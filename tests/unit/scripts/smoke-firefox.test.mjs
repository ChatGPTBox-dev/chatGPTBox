import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import streams from 'node:fs'
import fs, { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout } from 'node:timers/promises'
import { URL } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { startFirefox } from '../../../scripts/smoke/firefox.mjs'
import { bounded, createLifecycle, waitFor } from '../../../scripts/smoke/lifecycle.mjs'
import { hashArtifact } from '../../../scripts/smoke/runner.mjs'

const popupUrl = 'moz-extension://owned-extension/popup.html?popup=true'

async function fixture(t, override = () => {}, popup = 'popup.html?popup=true') {
  const root = await mkdtemp(join(tmpdir(), 'smoke-firefox-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const cleanups = []
  const spawns = []
  let handlesReads = 0
  const controller = new AbortController()
  const options = {
    executable: '/usr/lib/firefox/firefox',
    geckodriver: '/owned/geckodriver',
    archive: join(root, 'extension.zip'),
    extensionDir: join(root, 'build'),
    manifest: {
      version: '2.6.1',
      name: 'ChatGPTBox',
      browser_action: { default_popup: popup },
    },
    profileDir: join(root, 'profile'),
    artifactsDir: join(root, 'artifacts'),
    signal: controller.signal,
    lifecycle: {
      spawn(...args) {
        spawns.push(args)
        return {
          child: {},
          exited: new Promise(() => {}),
          output: () => '1720000000000\tgeckodriver\tINFO\tListening on 127.0.0.1:41239\n',
          assertRunning() {},
        }
      },
      defer(label, cleanup) {
        cleanups.push({ label, cleanup })
      },
    },
  }
  await mkdir(options.profileDir)
  await mkdir(options.artifactsDir)
  await writeFile(options.archive, 'owned archive bytes')
  await mkdir(options.extensionDir)
  await writeFile(join(options.extensionDir, 'manifest.json'), JSON.stringify(options.manifest))
  await writeFile(join(options.extensionDir, 'background.js'), 'current build')
  options.artifactSha256 = await hashArtifact(options.extensionDir)
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:41239')
    const path = new URL(url).pathname
    const call = { path, method: init.method, body: init.body && JSON.parse(init.body), init }
    calls.push(call)
    const overridden = await override(call, { controller, cleanups })
    if (overridden) return overridden
    let value = null
    if (path === '/status') value = { ready: true }
    else if (path === '/session') {
      assert.equal(cleanups.length, 1, 'cleanup must be registered before creating a session')
      value = { sessionId: 'owned-session', capabilities: { browserVersion: '154.0' } }
    } else if (path.endsWith('/moz/addon/install')) value = 'addon@example.test'
    else if (path.endsWith('/window/handles')) {
      value = handlesReads++ ? ['original', 'popup'] : ['original']
    } else if (path.endsWith('/execute/sync') && call.body.script.includes('getByID')) {
      value = 'moz-extension://owned-extension/'
    } else if (path.endsWith('/execute/async')) {
      value = await new Promise((resolve, reject) => {
        try {
          runInNewContext(`(function () { ${call.body.script} }).apply(null, args)`, {
            args: [...call.body.args, resolve],
            location: {
              href: calls.find(
                (entry) =>
                  typeof entry.body?.script === 'string' &&
                  entry.body.script.includes('gBrowser.addTab'),
              )?.body.args[0],
            },
            document: { readyState: 'complete' },
            browser: { storage: { local: { get: async () => ({ stored: true }) } } },
          })
        } catch (error) {
          reject(error)
        }
      })
    } else if (path.endsWith('/screenshot')) value = Buffer.from('image bytes').toString('base64')
    else if (path.endsWith('/source')) value = '<html>popup</html>'
    return Response.json({ value })
  })
  return { options, calls, cleanups, spawns, controller }
}

test('Firefox opens the popup declared by the installed manifest including its query', async (t) => {
  const declared = 'custom/declared-popup.html?from=manifest'
  const { options, calls } = await fixture(t, undefined, declared)
  const adapter = await startFirefox(options)
  assert.equal(adapter.metadata.popupUrl, `moz-extension://owned-extension/${declared}`)
  assert.deepEqual(
    calls.find(
      (call) =>
        typeof call.body?.script === 'string' && call.body.script.includes('gBrowser.addTab'),
    ).body.args,
    [`moz-extension://owned-extension/${declared}`],
  )
  await adapter.close()
})

test('Firefox installs the verified directory snapshot instead of a stale archive', async (t) => {
  const { options, calls } = await fixture(t)
  const adapter = await startFirefox(options)
  const installed = calls.find((call) => call.path.endsWith('/moz/addon/install')).body.path
  assert.equal(installed, join(options.artifactsDir, 'extension'))
  assert.equal(await hashArtifact(installed), options.artifactSha256)
  await writeFile(join(options.extensionDir, 'background.js'), 'later build')
  assert.equal(await readFile(join(installed, 'background.js'), 'utf8'), 'current build')
  assert.equal(adapter.metadata.artifactSha256, options.artifactSha256)
  assert.equal(Object.hasOwn(adapter.metadata, 'archiveSha256'), false)
  await adapter.close()
})

test('Firefox rejects a build changed since preflight before launching processes', async (t) => {
  const { options, calls, spawns } = await fixture(t)
  await writeFile(join(options.extensionDir, 'background.js'), 'changed build')
  await assert.rejects(startFirefox(options), /Build changed since preflight/)
  assert.equal(spawns.length, 0)
  assert.equal(calls.length, 0)
})

for (const popup of [
  null,
  '',
  ' ',
  ' popup.html',
  'https://example.test/popup.html',
  'javascript:alert(1)',
  '//other-extension/popup.html',
  'moz-extension://other-extension/popup.html',
  'moz-extension://owned-extension/popup.html',
]) {
  test(`Firefox rejects invalid manifest popup ${JSON.stringify(
    popup,
  )} before startup`, async (t) => {
    const { options, calls, spawns } = await fixture(t, undefined, popup)
    await assert.rejects(startFirefox(options), /Invalid Firefox manifest popup path/)
    assert.equal(calls.length, 0)
    assert.equal(spawns.length, 0)
  })
}

test('Firefox uses snapshot manifest identity and action popup precedence', async (t) => {
  const { options } = await fixture(t)
  const manifest = {
    ...options.manifest,
    name: 'Current snapshot',
    version: '3.0',
    action: { default_popup: 'action-popup.html?source=action#tab' },
  }
  await writeFile(join(options.extensionDir, 'manifest.json'), JSON.stringify(manifest))
  options.artifactSha256 = await hashArtifact(options.extensionDir)
  // The earlier metadata may predate the directory hash; use the snapshot instead.
  const adapter = await startFirefox(options)
  assert.equal(adapter.metadata.expectedName, manifest.name)
  assert.equal(adapter.metadata.expectedVersion, manifest.version)
  assert.equal(adapter.metadata.manifestVersion, manifest.version)
  assert.equal(
    adapter.metadata.popupUrl,
    'moz-extension://owned-extension/action-popup.html?source=action#tab',
  )
  await adapter.close()
})

test(
  'Firefox does not recreate an owned profile after cancellation during snapshot validation',
  { timeout: 5000 },
  async (t) => {
    const { options, controller, calls } = await fixture(t)
    const lifecycle = createLifecycle({ signal: controller.signal })
    t.after(() => lifecycle.force())
    lifecycle.defer('Firefox profile', () =>
      rm(options.profileDir, { recursive: true, force: true }),
    )
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    const originalReadFile = readFile
    const mockRead = t.mock.method(fs, 'readFile', async (...args) => {
      const bytes = await originalReadFile(...args)
      if (args[0] === join(options.artifactsDir, 'extension/manifest.json')) {
        started.resolve()
        await release.promise
      }
      return bytes
    })
    syncBuiltinESMExports()
    t.after(() => {
      release.resolve()
      mockRead.mock.restore()
      syncBuiltinESMExports()
    })
    const reason = new Error('Cancelled while validating snapshot')
    const rejected = assert.rejects(
      startFirefox({ ...options, lifecycle }),
      (error) => error === reason,
    )
    await started.promise
    controller.abort(reason)
    assert.deepEqual(await lifecycle.cleanup(), [])
    await assert.rejects(stat(options.profileDir), { code: 'ENOENT' })
    release.resolve()
    await rejected
    await assert.rejects(stat(options.profileDir), { code: 'ENOENT' })
    assert.equal(calls.length, 0)
  },
)

test(
  'Firefox cancellation closes an in-flight snapshot transfer before rejecting startup',
  { timeout: 5000 },
  async (t) => {
    const { options, controller, calls } = await fixture(t)
    const lifecycle = createLifecycle({ signal: controller.signal })
    t.after(() => lifecycle.force())
    lifecycle.defer('Firefox profile', () =>
      rm(options.profileDir, { recursive: true, force: true }),
    )
    const spawn = t.mock.method(lifecycle, 'spawn', () => {
      throw new Error('Unexpected browser startup')
    })
    const started = Promise.withResolvers()
    const originalRead = streams.createReadStream
    const originalWrite = streams.createWriteStream
    const input = new PassThrough()
    let output
    const mockRead = t.mock.method(streams, 'createReadStream', (path, ...args) => {
      if (path === join(options.extensionDir, 'background.js')) {
        input.write('partial')
        started.resolve()
        return input
      }
      return originalRead(path, ...args)
    })
    const mockWrite = t.mock.method(streams, 'createWriteStream', (path, ...args) => {
      const result = originalWrite(path, ...args)
      if (path === join(options.artifactsDir, 'extension/background.js')) output = result
      return result
    })
    syncBuiltinESMExports()
    t.after(() => {
      input.destroy()
      output?.destroy()
      mockRead.mock.restore()
      mockWrite.mock.restore()
      syncBuiltinESMExports()
    })
    const reason = new Error('Cancelled during snapshot copy')
    const rejected = assert.rejects(
      startFirefox({ ...options, lifecycle }),
      (error) => error === reason,
    )
    await bounded(started.promise, 1000, 'Snapshot transfer start')
    await waitFor(() => output?.bytesWritten > 0, { timeoutMs: 1000 })
    controller.abort(reason)
    await bounded(rejected, 1000, 'Snapshot cancellation')
    assert.equal(input.closed, true)
    assert.equal(output.closed, true)
    assert.deepEqual(await lifecycle.cleanup(), [])
    await assert.rejects(stat(options.profileDir), { code: 'ENOENT' })
    assert.equal(
      await readFile(join(options.artifactsDir, 'extension/background.js'), 'utf8'),
      'partial',
    )
    await assert.rejects(stat(options.profileDir), { code: 'ENOENT' })
    assert.equal(spawn.mock.callCount(), 0)
    assert.equal(calls.length, 0)
  },
)

test('Firefox uses an owned headless session and privileged extension popup context', async (t) => {
  const { options, calls, cleanups, spawns } = await fixture(t)
  const adapter = await startFirefox(options)
  assert.deepEqual(spawns[0].slice(0, 2), [
    options.geckodriver,
    [
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--websocket-port',
      '0',
      '--profile-root',
      options.profileDir,
      '--allow-system-access',
    ],
  ])
  assert.equal(spawns[0][2].logPath, join(options.artifactsDir, 'geckodriver.log'))
  const session = calls.find((call) => call.path === '/session')
  assert.equal(
    session.body.capabilities.alwaysMatch['moz:firefoxOptions'].binary,
    options.executable,
  )
  assert.deepEqual(session.body.capabilities.alwaysMatch['moz:firefoxOptions'].args, ['-headless'])
  assert.deepEqual(calls.find((call) => call.path.endsWith('/moz/addon/install')).body, {
    path: join(options.artifactsDir, 'extension'),
    temporary: true,
  })
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('/moz/context')).map((call) => call.body.context),
    ['chrome', 'content'],
  )
  const tab = calls.find(
    (call) => call.path.endsWith('/execute/sync') && call.body.script.includes('gBrowser.addTab'),
  )
  assert.match(tab.body.script, /Services\.scriptSecurityManager\.getSystemPrincipal\(\)/)
  assert.deepEqual(tab.body.args, [popupUrl])
  assert.deepEqual(calls.find((call) => call.path.endsWith('/window')).body, { handle: 'popup' })
  assert.deepEqual(adapter.metadata, {
    browserVersion: '154.0',
    extensionId: 'addon@example.test',
    popupUrl,
    expectedVersion: '2.6.1',
    expectedName: 'ChatGPTBox',
    artifactSha256: options.artifactSha256,
    snapshotDir: join(options.artifactsDir, 'extension'),
    manifestVersion: '2.6.1',
  })
  assert.equal(await adapter.evaluate(async (a, b) => Promise.resolve(a + b), 3, 4), 7)
  assert.equal(
    await adapter.evaluate(async () => (await globalThis.browser.storage.local.get()).stored),
    true,
  )
  await assert.rejects(
    adapter.evaluate(async () => {
      throw new Error('page failure')
    }),
    /page failure/,
  )
  await adapter.capture('popup-initial')
  await assert.rejects(adapter.capture('../escape'), /inside artifactsDir/)
  assert.equal(
    await readFile(join(options.artifactsDir, 'popup-initial.png'), 'utf8'),
    'image bytes',
  )
  assert.equal(
    await readFile(join(options.artifactsDir, 'popup-initial.html'), 'utf8'),
    '<html>popup</html>',
  )
  await adapter.close()
  await cleanups[0].cleanup()
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1)
})

for (const path of ['/session', '/session/owned-session/moz/addon/install']) {
  for (const status of [200, 500]) {
    test(`Firefox rejects WebDriver error at ${path} with HTTP ${status} without retry`, async (t) => {
      const { options, calls, cleanups } = await fixture(t, (call) => {
        if (call.path === path) {
          return Response.json(
            { value: { error: 'unknown error', message: 'broken operation' } },
            { status },
          )
        }
      })
      await assert.rejects(startFirefox(options), /broken operation/)
      assert.equal(calls.filter((call) => call.path === path).length, 1)
      await cleanups[0].cleanup()
      assert.equal(
        calls.filter((call) => call.method === 'DELETE').length,
        path === '/session' ? 0 : 1,
      )
    })
  }
}

test('Firefox rejects failed HTTP status even with a successful-looking value', async (t) => {
  const { options, calls } = await fixture(t, (call) => {
    if (call.path === '/session')
      return Response.json({ value: { sessionId: 'bad' } }, { status: 502 })
  })
  await assert.rejects(startFirefox(options), /HTTP 502/)
  assert.equal(calls.filter((call) => call.path === '/session').length, 1)
})

test('Firefox rejects malformed HTTP JSON without retrying session creation', async (t) => {
  const { options, calls } = await fixture(t, (call) => {
    if (call.path === '/session') return new Response('<html>error</html>', { status: 503 })
  })
  await assert.rejects(startFirefox(options), /HTTP 503, invalid JSON/)
  assert.equal(calls.filter((call) => call.path === '/session').length, 1)
})

for (const value of ['', '  ', null]) {
  test(`Firefox rejects empty addon ID ${JSON.stringify(value)} and retains cleanup`, async (t) => {
    const { options, calls, cleanups } = await fixture(t, (call) => {
      if (call.path.endsWith('/moz/addon/install')) return Response.json({ value })
    })
    await assert.rejects(startFirefox(options), /empty addon ID/)
    assert.equal(calls.filter((call) => call.path.endsWith('/moz/addon/install')).length, 1)
    assert.equal(calls.filter((call) => call.path.endsWith('/moz/context')).length, 0)
    await cleanups[0].cleanup()
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1)
  })
}

test('Firefox retries explicit read-only not-ready status', async (t) => {
  let statusReads = 0
  const { options, calls } = await fixture(t, (call) => {
    if (call.path === '/status') return Response.json({ value: { ready: ++statusReads > 1 } })
  })
  const adapter = await startFirefox(options)
  assert.equal(statusReads, 2)
  assert.equal(calls.filter((call) => call.path === '/session').length, 1)
  await adapter.close()
})

test('Firefox preserves evaluation messages when the stack contains only locations', async (t) => {
  const { options } = await fixture(t)
  const adapter = await startFirefox(options)
  await assert.rejects(
    adapter.evaluate(() => {
      const error = new Error('Popup snapshot is missing')
      error.stack = 'pageFunction@moz-extension://owned-extension/popup.html:4:2'
      throw error
    }),
    (error) => {
      assert.match(error.message, /^Firefox evaluation failed: Error: Popup snapshot is missing/)
      assert.match(error.message, /pageFunction@moz-extension:/)
      assert.doesNotMatch(error.message, /WebDriver POST/)
      return true
    },
  )
  await adapter.close()
})

test('Firefox waits for a complete listening-port log record', async (t) => {
  const { options, calls } = await fixture(t)
  const originalSpawn = options.lifecycle.spawn
  let reads = 0
  options.lifecycle.spawn = (...args) => ({
    ...originalSpawn(...args),
    output: () =>
      ++reads === 1
        ? 'geckodriver INFO Listening on 127.0.0.1:4'
        : 'geckodriver INFO Listening on 127.0.0.1:41239\n',
  })
  const adapter = await startFirefox(options)
  assert.equal(reads, 2)
  assert.equal(calls.filter((call) => call.path === '/status').length, 1)
  await adapter.close()
})

test('Firefox rejects malformed readiness instead of retrying', async (t) => {
  const { options, calls } = await fixture(t, (call) => {
    if (call.path === '/status') return Response.json({ value: {} })
  })
  await assert.rejects(startFirefox(options), /Invalid geckodriver readiness status/)
  assert.equal(calls.length, 1)
})

test('Firefox refuses an empty session ID before installing the addon', async (t) => {
  const { options, calls, cleanups } = await fixture(t, (call) => {
    if (call.path === '/session') return Response.json({ value: { sessionId: '' } })
  })
  await assert.rejects(startFirefox(options), /empty session ID/)
  await cleanups[0].cleanup()
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0)
})

test('Firefox surfaces failed session cleanup and does not retry it', async (t) => {
  const { options, calls, cleanups } = await fixture(t, (call) => {
    if (call.method === 'DELETE') {
      return Response.json({ value: { error: 'unknown error', message: 'cannot close' } })
    }
  })
  const adapter = await startFirefox(options)
  await assert.rejects(adapter.close(), /cannot close/)
  await assert.rejects(cleanups[0].cleanup(), /cannot close/)
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1)
})

test('Firefox never retries a network failure during addon installation', async (t) => {
  const { options, calls, cleanups } = await fixture(t, (call) => {
    if (call.path.endsWith('/moz/addon/install')) throw new TypeError('fetch failed')
  })
  await assert.rejects(startFirefox(options), /fetch failed/)
  assert.equal(calls.filter((call) => call.path.endsWith('/moz/addon/install')).length, 1)
  await cleanups[0].cleanup()
})

test('Firefox aborts a stalled installation and still deletes its session once', async (t) => {
  const { options, calls, cleanups, controller } = await fixture(t, async (call) => {
    if (call.path.endsWith('/moz/addon/install')) {
      await setTimeout(10)
      controller.abort(new Error('test operation timeout'))
      return new Promise(() => {})
    }
  })
  await assert.rejects(startFirefox(options), /test operation timeout/)
  assert.equal(calls.filter((call) => call.path.endsWith('/moz/addon/install')).length, 1)
  assert.equal(
    calls.find((call) => call.path.endsWith('/moz/addon/install')).init.signal.aborted,
    true,
  )
  await cleanups[0].cleanup()
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1)
  assert.equal(
    calls.find((call) => call.method === 'DELETE').init.signal.reason?.message ===
      'test operation timeout',
    false,
  )
})

for (const path of ['/session', '/session/owned-session/moz/addon/install']) {
  test(`Firefox bounds a stalled ${path} request without retrying`, async (t) => {
    const { options, calls, cleanups } = await fixture(t, (call) => {
      if (call.path === path) {
        queueMicrotask(() => t.mock.timers.tick(path === '/session' ? 60001 : 30001))
        return new Promise(() => {})
      }
    })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.timers.reset()
      syncBuiltinESMExports()
    })
    await assert.rejects(startFirefox(options), path === '/session' ? /60000 ms/ : /30000 ms/)
    assert.equal(calls.filter((call) => call.path === path).length, 1)
    assert.equal(calls.find((call) => call.path === path).init.signal.aborted, true)
    await cleanups[0].cleanup()
  })
}

test('Firefox bounds session shutdown to five seconds without retry', async (t) => {
  const { options, calls } = await fixture(t, (call) => {
    if (call.method === 'DELETE') {
      queueMicrotask(() => t.mock.timers.tick(5001))
      return new Promise(() => {})
    }
  })
  const adapter = await startFirefox(options)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.timers.reset()
    syncBuiltinESMExports()
  })
  await assert.rejects(adapter.close(), /5000 ms/)
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1)
  assert.equal(calls.find((call) => call.method === 'DELETE').init.signal.aborted, true)
})

test('Firefox cleanup evaluation survives cancellation and retains a five-second deadline', async (t) => {
  let stall = false
  const started = Promise.withResolvers()
  const { options, calls, controller } = await fixture(t, (call) => {
    if (stall && call.path.endsWith('/execute/async')) {
      started.resolve()
      return new Promise(() => {})
    }
  })
  const adapter = await startFirefox(options)
  stall = true
  const normal = adapter.evaluate(() => 1)
  await started.promise
  controller.abort(new Error('Run cancelled'))
  await assert.rejects(normal, /Run cancelled/)
  const count = calls.length
  await assert.rejects(
    adapter.evaluate(() => 1),
    /Run cancelled/,
  )
  assert.equal(calls.length, count)
  stall = false
  assert.equal(await adapter.evaluateCleanup((a, b) => a + b, 2, 3), 5)
  await assert.rejects(
    adapter.evaluateCleanup(async () => {
      throw new Error('Cleanup failed')
    }),
    /Cleanup failed/,
  )
  stall = true
  t.mock.timers.enable({ apis: ['setTimeout'] })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.timers.reset()
    syncBuiltinESMExports()
  })
  const stalled = adapter.evaluateCleanup(() => 1)
  const cleanupSignal = calls.at(-1).init.signal
  assert.equal(cleanupSignal.aborted, false)
  assert.notEqual(cleanupSignal, controller.signal)
  const rejected = assert.rejects(stalled, /timed out after 5000 ms/)
  t.mock.timers.tick(5001)
  await rejected
  assert.equal(cleanupSignal.aborted, true)
  await adapter.close()
})
