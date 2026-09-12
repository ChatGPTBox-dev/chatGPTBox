import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs, { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { clearTimeout, setTimeout } from 'node:timers'
import { runInNewContext } from 'node:vm'
import { connectCDP } from '../../../scripts/smoke/cdp.mjs'
import { startChromium } from '../../../scripts/smoke/chromium.mjs'
import { createLifecycle } from '../../../scripts/smoke/lifecycle.mjs'
import { hashArtifact } from '../../../scripts/smoke/artifacts.mjs'

function fakeSocket(onSend, { open = true } = {}) {
  const sockets = []
  class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      this.closeCount = 0
      this.sent = []
      sockets.push(this)
      if (open) globalThis.queueMicrotask(() => this.emit('open'))
    }
    addEventListener(type, fn) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(fn)
      this.listeners.set(type, listeners)
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
    reply(message) {
      this.emit('message', { data: JSON.stringify(message) })
    }
    send(data) {
      const message = JSON.parse(data)
      this.sent.push(message)
      onSend?.(message, this)
    }
    close() {
      this.closeCount++
      this.emit('close')
    }
  }
  return { FakeWebSocket, sockets }
}

function cleanupRegistry(t) {
  const callbacks = []
  t.after(async () => {
    for (const callback of callbacks.reverse()) await callback()
  })
  return {
    callbacks,
    defer(label, cleanup) {
      callbacks.push(cleanup)
    },
  }
}

test('CDP registers cleanup before handshake and closes a stalled connection', async (t) => {
  const lifecycle = cleanupRegistry(t)
  const { FakeWebSocket, sockets } = fakeSocket(undefined, { open: false })
  const connecting = connectCDP('ws://127.0.0.1:1234', {
    lifecycle,
    timeoutMs: 10,
    WebSocketImpl: FakeWebSocket,
  })
  assert.equal(lifecycle.callbacks.length, 1)
  await assert.rejects(connecting, /Connect Chromium CDP timed out/)
  await lifecycle.callbacks[0]()
  await lifecycle.callbacks[0]()
  assert.equal(sockets[0].closeCount, 1)
})

test('CDP does not open a transport when cleanup registration is rejected', async () => {
  const { FakeWebSocket, sockets } = fakeSocket()
  await assert.rejects(
    connectCDP('ws://127.0.0.1:1234', {
      lifecycle: {
        defer() {
          throw new Error('Lifecycle is already closing')
        },
      },
      WebSocketImpl: FakeWebSocket,
    }),
    /Lifecycle is already closing/,
  )
  assert.equal(sockets.length, 0)
})

test('CDP correlates concurrent responses and surfaces protocol errors without retry', async (t) => {
  const { FakeWebSocket, sockets } = fakeSocket()
  const client = await connectCDP('ws://127.0.0.1:1234', {
    lifecycle: cleanupRegistry(t),
    WebSocketImpl: FakeWebSocket,
  })
  const socket = sockets[0]
  const first = client.request('Target.createTarget', { url: 'about:blank' })
  const second = client.request('Runtime.evaluate', {}, 'popup-session')
  socket.reply({ method: 'Runtime.consoleAPICalled', params: {} })
  socket.reply({ id: socket.sent[1].id, result: { value: 42 } })
  socket.reply({ id: socket.sent[0].id, error: { code: -1, message: 'Target denied' } })
  assert.deepEqual(await second, { value: 42 })
  await assert.rejects(first, /Target.createTarget: Target denied/)
  assert.equal(socket.sent[1].sessionId, 'popup-session')
  assert.equal(socket.sent.length, 2)
})

test('CDP request timeout ignores late responses and rejects pending requests on disconnect', async (t) => {
  const { FakeWebSocket, sockets } = fakeSocket()
  const client = await connectCDP('ws://127.0.0.1:1234', {
    lifecycle: cleanupRegistry(t),
    timeoutMs: 10,
    WebSocketImpl: FakeWebSocket,
  })
  await assert.rejects(client.request('Target.createTarget'), /Target.createTarget timed out/)
  const next = client.request('Browser.getVersion')
  sockets[0].reply({ id: sockets[0].sent[0].id, result: { wrong: true } })
  sockets[0].emit('close')
  await assert.rejects(next, /disconnected/)
  await assert.rejects(client.request('Browser.getVersion'), /disconnected/)
  assert.equal(sockets[0].sent.length, 2)
})

test('CDP cancellation prevents new RPCs and permits bounded diagnostic requests', async (t) => {
  const controller = new AbortController()
  const { FakeWebSocket, sockets } = fakeSocket()
  const client = await connectCDP('ws://127.0.0.1:1234', {
    lifecycle: cleanupRegistry(t),
    signal: controller.signal,
    WebSocketImpl: FakeWebSocket,
  })
  const pending = client.request('Runtime.evaluate')
  controller.abort(new Error('Cancelled by test'))
  await assert.rejects(pending, /Cancelled by test/)
  await assert.rejects(client.request('Target.createTarget'), /Cancelled by test/)
  const capture = client.request('Page.captureScreenshot', {}, 'popup', { signal: undefined })
  sockets[0].reply({ id: sockets[0].sent.at(-1).id, result: { data: 'png' } })
  assert.deepEqual(await capture, { data: 'png' })
  assert.equal(sockets[0].sent.length, 2)
})

test('CDP rejects malformed messages and missing results', async (t) => {
  const { FakeWebSocket, sockets } = fakeSocket()
  const client = await connectCDP('ws://127.0.0.1:1234', {
    lifecycle: cleanupRegistry(t),
    WebSocketImpl: FakeWebSocket,
  })
  const missing = client.request('Browser.getVersion')
  sockets[0].reply({ id: sockets[0].sent.at(-1).id })
  await assert.rejects(missing, /missing CDP result/)
  const malformed = client.request('Runtime.evaluate')
  sockets[0].emit('message', { data: 'not JSON' })
  await assert.rejects(malformed, /Invalid CDP WebSocket message/)
})

test('CDP run cancellation preserves an already pending independent cleanup RPC', async (t) => {
  const controller = new AbortController()
  const cleanup = new AbortController()
  const { FakeWebSocket, sockets } = fakeSocket()
  const client = await connectCDP('ws://127.0.0.1:1234', {
    lifecycle: cleanupRegistry(t),
    signal: controller.signal,
    WebSocketImpl: FakeWebSocket,
  })
  const normal = client.request('Runtime.evaluate')
  const independent = client.request('Runtime.evaluate', {}, 'popup', {
    signal: cleanup.signal,
    timeoutMs: 1000,
  })
  controller.abort(new Error('Run cancelled'))
  await assert.rejects(normal, /Run cancelled/)
  sockets[0].reply({ id: sockets[0].sent[0].id, result: { late: true } })
  sockets[0].reply({ id: sockets[0].sent[1].id, result: { cleaned: true } })
  assert.deepEqual(await independent, { cleaned: true })
  await assert.rejects(
    client.request('Runtime.evaluate', {}, 'popup', {
      signal: cleanup.signal,
      timeoutMs: 10,
    }),
    /timed out after 10 ms/,
  )
  await assert.rejects(client.request('Runtime.evaluate'), /Run cancelled/)
  assert.equal(sockets[0].sent.length, 3)
})

test('Chromium cleanup evaluation survives cancellation and retains a five-second deadline', async (t) => {
  const controller = new AbortController()
  const fixture = await chromiumFixture(t, { signal: controller.signal })
  const adapter = await startChromium(fixture.options)
  const normal = adapter.evaluate(() => new Promise(() => {}))
  controller.abort(new Error('Run cancelled'))
  await assert.rejects(normal, /Run cancelled/)
  await assert.rejects(
    Promise.resolve().then(() => adapter.evaluate(() => 1)),
    /Run cancelled/,
  )
  assert.equal(await adapter.evaluateCleanup((a, b) => a + b, 2, 3), 5)
  await assert.rejects(
    adapter.evaluateCleanup(async () => {
      throw new Error('Cleanup failed')
    }),
    /Cleanup failed/,
  )
  t.mock.timers.enable({ apis: ['setTimeout'] })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.timers.reset()
    syncBuiltinESMExports()
  })
  const stalled = adapter.evaluateCleanup(() => new Promise(() => {}))
  const rejected = assert.rejects(stalled, /timed out after 5000 ms/)
  t.mock.timers.tick(5001)
  await rejected
})

test('CDP uses the Node builtin WebSocket against a local protocol peer', async (t) => {
  const server = createServer()
  const peers = new Set()
  t.after(async () => {
    for (const peer of peers) peer.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  server.on('upgrade', (request, peer) => {
    peers.add(peer)
    peer.on('close', () => peers.delete(peer))
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    peer.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    let input = Buffer.alloc(0)
    peer.on('data', (chunk) => {
      input = Buffer.concat([input, chunk])
      while (input.length >= 2) {
        const opcode = input[0] & 15
        const length = input[1] & 127
        // The test sends only small, single-frame CDP commands and a close frame.
        assert.ok(length < 126)
        assert.ok(input[1] & 128)
        if (input.length < 6 + length) return
        const mask = input.subarray(2, 6)
        const payload = Buffer.from(input.subarray(6, 6 + length))
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        input = input.subarray(6 + length)
        if (opcode === 8) {
          peer.end(Buffer.from([0x88, 0]))
          return
        }
        assert.equal(opcode, 1)
        const message = JSON.parse(payload.toString())
        assert.equal(message.method, 'Browser.getVersion')
        const response = Buffer.from(
          JSON.stringify({ id: message.id, result: { product: 'Chromium/native-transport' } }),
        )
        peer.write(Buffer.concat([Buffer.from([0x81, response.length]), response]))
      }
    })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const client = await connectCDP(`ws://127.0.0.1:${server.address().port}/devtools/browser/test`, {
    lifecycle: cleanupRegistry(t),
  })
  assert.deepEqual(await client.request('Browser.getVersion'), {
    product: 'Chromium/native-transport',
  })
  await client.close()
})

async function chromiumFixture(
  t,
  {
    protocolError,
    evaluationError,
    screenshotError,
    contextTransition,
    partialPort,
    signal,
    key,
  } = {},
) {
  const directory = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), 'smoke-chromium-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const extensionDir = path.join(directory, 'extension')
  const profileDir = path.join(directory, 'profile')
  const artifactsDir = path.join(directory, 'artifacts')
  await mkdir(extensionDir)
  await mkdir(profileDir)
  await mkdir(artifactsDir)
  await writeFile(
    path.join(extensionDir, 'manifest.json'),
    JSON.stringify({
      version: '1.2.3',
      name: 'ChatGPTBox',
      ...(key ? { key } : {}),
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html?popup=true' },
    }),
  )
  const extensionId = createHash('sha256')
    .update(key ? Buffer.from(key, 'base64') : extensionDir)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  const popupUrl = `chrome-extension://${extensionId}/popup.html?popup=true`
  const lifecycle = cleanupRegistry(t)
  const launches = []
  const portRecord = '43210\n/devtools/browser/12345678-1234-1234-1234-123456789abc\n'
  lifecycle.spawn = (executable, args, options) => {
    launches.push({ executable, args, options })
    const portFile = path.join(profileDir, 'DevToolsActivePort')
    writeFileSync(portFile, partialPort ? '43210\n/devtools/browser/1234' : portRecord)
    if (partialPort) {
      const timer = setTimeout(() => writeFileSync(portFile, portRecord), 10)
      t.after(() => clearTimeout(timer))
    }
    return {
      assertRunning() {
        signal?.throwIfAborted()
      },
      output: () => 'Fake browser output',
    }
  }
  const { FakeWebSocket, sockets } = fakeSocket((message, socket) => {
    if (message.method === protocolError) {
      socket.reply({ id: message.id, error: { message: 'Deliberate protocol failure' } })
      return
    }
    let result = {}
    switch (message.method) {
      case 'Browser.getVersion':
        result = { product: 'Chromium/150.0.0.0' }
        break
      case 'Target.getTargets':
        result = {
          targetInfos: [
            { type: 'page', targetId: 'unrelated', url: 'https://example.test/' },
            {
              type: 'service_worker',
              targetId: 'built-in-component',
              url: `chrome-extension://${'b'.repeat(32)}/background.js`,
            },
            {
              type: 'service_worker',
              targetId: 'worker',
              url: `chrome-extension://${extensionId}/background.js`,
            },
          ],
        }
        break
      case 'Target.createTarget':
        assert.equal(message.params.url, popupUrl)
        result = { targetId: 'popup' }
        break
      case 'Target.attachToTarget':
        assert.equal(message.params.targetId, 'popup')
        result = { sessionId: 'popup-session' }
        break
      case 'Runtime.evaluate': {
        assert.equal(message.sessionId, 'popup-session')
        assert.equal(message.params.awaitPromise, true)
        assert.equal(message.params.returnByValue, true)
        if (contextTransition && message.params.expression.includes('readyState')) {
          contextTransition = false
          socket.reply({
            id: message.id,
            error: { code: -32000, message: 'Execution context was destroyed.' },
          })
          return
        }
        if (evaluationError && message.params.expression.includes('readyState')) {
          result = {
            exceptionDetails: { exception: { description: 'Popup initialization failed' } },
          }
          break
        }
        const value = runInNewContext(message.params.expression, {
          location: { href: popupUrl },
          document: {
            readyState: 'complete',
            documentElement: { outerHTML: '<html><body>Extension popup</body></html>' },
          },
          chrome: { runtime: { id: extensionId } },
        })
        Promise.resolve(value).then(
          (value) => socket.reply({ id: message.id, result: { result: { value } } }),
          (error) =>
            socket.reply({
              id: message.id,
              result: { exceptionDetails: { exception: { description: error.message } } },
            }),
        )
        return
      }
      case 'Page.captureScreenshot':
        if (screenshotError) {
          socket.reply({ id: message.id, error: { message: 'Screenshot failed' } })
          return
        }
        result = { data: Buffer.from('fake-png').toString('base64') }
        break
    }
    socket.reply({ id: message.id, result })
  })
  t.mock.method(globalThis, 'WebSocket', function (url) {
    return new FakeWebSocket(url)
  })
  return {
    options: {
      executable: '/fake/chromium',
      extensionDir,
      profileDir,
      artifactsDir,
      lifecycle,
      signal,
      artifactSha256: await hashArtifact(extensionDir),
    },
    launches,
    sockets,
    extensionId,
    popupUrl,
  }
}

test('Chromium launches isolated native headless and evaluates async code in its extension popup', async (t) => {
  const fixture = await chromiumFixture(t)
  const adapter = await startChromium(fixture.options)
  const launch = fixture.launches[0]
  assert.equal(launch.executable, '/fake/chromium')
  assert.ok(launch.args.includes('--headless=new'))
  assert.ok(launch.args.includes('--remote-debugging-port=0'))
  assert.ok(launch.args.includes(`--load-extension=${fixture.options.extensionDir}`))
  assert.ok(launch.args.includes(`--disable-extensions-except=${fixture.options.extensionDir}`))
  assert.ok(launch.args.includes(`--user-data-dir=${fixture.options.profileDir}`))
  assert.ok(!launch.args.includes('--no-sandbox'))
  assert.equal(
    fixture.sockets[0].url,
    'ws://127.0.0.1:43210/devtools/browser/12345678-1234-1234-1234-123456789abc',
  )
  assert.deepEqual(adapter.metadata, {
    browserVersion: 'Chromium/150.0.0.0',
    extensionId: fixture.extensionId,
    popupUrl: fixture.popupUrl,
    expectedVersion: '1.2.3',
    expectedName: 'ChatGPTBox',
    manifestVersion: '1.2.3',
  })
  const identity = await adapter.evaluate(async (arg) => {
    await Promise.resolve()
    return { id: globalThis.chrome.runtime.id, arg }
  }, 'quotes " and newlines\n')
  assert.equal(identity.id, fixture.extensionId)
  assert.equal(identity.arg, 'quotes " and newlines\n')
  await assert.rejects(
    adapter.evaluate(async () => {
      throw new Error('Scenario failed')
    }),
    /Scenario failed/,
  )
  await adapter.capture('failure')
  assert.equal(
    await readFile(path.join(fixture.options.artifactsDir, 'failure.png'), 'utf8'),
    'fake-png',
  )
  assert.match(
    await readFile(path.join(fixture.options.artifactsDir, 'failure.html'), 'utf8'),
    /Extension popup/,
  )
  await assert.rejects(adapter.capture('../outside'), /inside artifactsDir/)
  await adapter.close()
  await adapter.close()
  assert.equal(fixture.sockets[0].closeCount, 1)
})

test('Chromium retries only the popup readiness context transition', async (t) => {
  const fixture = await chromiumFixture(t, { contextTransition: true })
  await startChromium(fixture.options)
  assert.equal(
    fixture.sockets[0].sent.filter(
      (message) =>
        message.method === 'Runtime.evaluate' && message.params.expression.includes('readyState'),
    ).length,
    2,
  )
  assert.equal(
    fixture.sockets[0].sent.filter((message) => message.method === 'Target.createTarget').length,
    1,
  )
})

test('Chromium waits for a complete DevToolsActivePort record before connecting', async (t) => {
  const fixture = await chromiumFixture(t, { partialPort: true })
  await startChromium(fixture.options)
  assert.equal(fixture.sockets.length, 1)
  assert.equal(
    fixture.sockets[0].url,
    'ws://127.0.0.1:43210/devtools/browser/12345678-1234-1234-1234-123456789abc',
  )
})

test('Chromium diagnostics bypass cancelled liveness checks while the transport remains open', async (t) => {
  const controller = new AbortController()
  const fixture = await chromiumFixture(t, { signal: controller.signal })
  const adapter = await startChromium(fixture.options)
  controller.abort(new Error('Scenario cancelled'))
  await assert.rejects(
    adapter.evaluate(() => true),
    /Scenario cancelled/,
  )
  await adapter.capture('cancelled')
  assert.equal(
    await readFile(path.join(fixture.options.artifactsDir, 'cancelled.png'), 'utf8'),
    'fake-png',
  )
  assert.match(
    await readFile(path.join(fixture.options.artifactsDir, 'cancelled.html'), 'utf8'),
    /Extension popup/,
  )
})

test('Chromium ignores component workers with the same script path', async (t) => {
  const fixture = await chromiumFixture(t)
  const adapter = await startChromium(fixture.options)
  assert.equal(adapter.metadata.extensionId, fixture.extensionId)
  assert.notEqual(adapter.metadata.extensionId, 'b'.repeat(32))
})

test('Chromium uses the manifest public key instead of the load path for identity', async (t) => {
  const fixture = await chromiumFixture(t, {
    key: Buffer.from('Fixture public key').toString('base64'),
  })
  const adapter = await startChromium(fixture.options)
  assert.equal(adapter.metadata.extensionId, fixture.extensionId)
})

test(
  'Chromium resolves a symlink before selecting its worker and loading the extension',
  { skip: os.platform() === 'win32' },
  async (t) => {
    const fixture = await chromiumFixture(t)
    const alias = path.join(path.dirname(fixture.options.extensionDir), 'extension alias')
    await fs.symlink(fixture.options.extensionDir, alias, 'dir')
    const adapter = await startChromium({ ...fixture.options, extensionDir: alias })
    assert.equal(adapter.metadata.extensionId, fixture.extensionId)
    assert.ok(fixture.launches[0].args.includes(`--load-extension=${fixture.options.extensionDir}`))
  },
)

test('Chromium uses the verified build manifest instead of stale caller metadata', async (t) => {
  const fixture = await chromiumFixture(t)
  const adapter = await startChromium({
    ...fixture.options,
    manifest: {
      name: 'Runner build',
      version: '2.3.4',
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html?popup=true' },
    },
  })
  assert.equal(adapter.metadata.expectedName, 'ChatGPTBox')
  assert.equal(adapter.metadata.expectedVersion, '1.2.3')
  assert.equal(adapter.metadata.manifestVersion, '1.2.3')
})

for (const change of [
  'manifest',
  'invalid manifest',
  'missing manifest',
  'file',
  'empty directory',
]) {
  test(`Chromium rejects a changed ${change} after preflight before spawning`, async (t) => {
    const fixture = await chromiumFixture(t)
    const { extensionDir } = fixture.options
    const manifestPath = path.join(extensionDir, 'manifest.json')
    if (change === 'manifest') {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.version = '9.9.9'
      await writeFile(manifestPath, JSON.stringify(manifest))
    } else if (change === 'invalid manifest') {
      await writeFile(manifestPath, '{')
    } else if (change === 'missing manifest') {
      await rm(manifestPath)
    } else if (change === 'file') {
      await writeFile(path.join(extensionDir, 'new.js'), 'changed')
    } else {
      await mkdir(path.join(extensionDir, 'new-directory'))
    }
    await assert.rejects(startChromium(fixture.options), /Build changed since preflight/)
    assert.equal(fixture.launches.length, 0)
  })
}

test('Chromium requires a valid preflight hash before spawning', async (t) => {
  const fixture = await chromiumFixture(t)
  for (const artifactSha256 of [undefined, '', 'invalid']) {
    await assert.rejects(
      startChromium({ ...fixture.options, artifactSha256 }),
      /Missing preflight build hash/,
    )
  }
  assert.equal(fixture.launches.length, 0)
})

test('Chromium captures PNG and DOM when popup startup fails', async (t) => {
  const fixture = await chromiumFixture(t, { evaluationError: true })
  await assert.rejects(
    startChromium(fixture.options),
    /Popup initialization failed.*\nFake browser output/,
  )
  assert.equal(
    await readFile(path.join(fixture.options.artifactsDir, 'chromium-startup-failure.png'), 'utf8'),
    'fake-png',
  )
  assert.match(
    await readFile(
      path.join(fixture.options.artifactsDir, 'chromium-startup-failure.html'),
      'utf8',
    ),
    /Extension popup/,
  )
})

test('Chromium captures DOM even if screenshot fails', async (t) => {
  const fixture = await chromiumFixture(t, { screenshotError: true })
  const adapter = await startChromium(fixture.options)
  await assert.rejects(adapter.capture('failure'), /Chromium capture failed/)
  assert.match(
    await readFile(path.join(fixture.options.artifactsDir, 'failure.html'), 'utf8'),
    /Extension popup/,
  )
})

test('Chromium does not retry target creation failures and retains cleanup', async (t) => {
  const fixture = await chromiumFixture(t, { protocolError: 'Target.createTarget' })
  await assert.rejects(
    startChromium(fixture.options),
    /Target.createTarget: Deliberate protocol failure/,
  )
  assert.equal(
    fixture.sockets[0].sent.filter((message) => message.method === 'Target.createTarget').length,
    1,
  )
  assert.equal(fixture.options.lifecycle.callbacks.length, 1)
})

test('Chromium rejects stale profile port files without launching', async (t) => {
  const fixture = await chromiumFixture(t)
  await writeFile(
    path.join(fixture.options.profileDir, 'DevToolsActivePort'),
    '1234\n/devtools/browser/stale',
  )
  await assert.rejects(startChromium(fixture.options), /use a fresh profile/)
  assert.equal(fixture.launches.length, 0)
})

test('Chromium cancellation before startup does not spawn a process', async (t) => {
  const fixture = await chromiumFixture(t)
  const controller = new AbortController()
  controller.abort(new Error('Stop now'))
  await assert.rejects(startChromium({ ...fixture.options, signal: controller.signal }), /Stop now/)
  assert.equal(fixture.launches.length, 0)
})

test(
  'Chromium does not recreate an owned profile after cancellation during manifest reading',
  { timeout: 5000 },
  async (t) => {
    const controller = new AbortController()
    const fixture = await chromiumFixture(t, { signal: controller.signal })
    const lifecycle = createLifecycle({ signal: controller.signal })
    t.after(() => lifecycle.force())
    lifecycle.defer('Chromium profile', () =>
      rm(fixture.options.profileDir, { recursive: true, force: true }),
    )
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    const originalReadFile = readFile
    const manifestPath = path.join(fixture.options.extensionDir, 'manifest.json')
    const mockRead = t.mock.method(fs, 'readFile', async (...args) => {
      const bytes = await originalReadFile(...args)
      if (args[0] === manifestPath) {
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
    const reason = new Error('Cancelled while reading manifest')
    const rejected = assert.rejects(
      startChromium({ ...fixture.options, lifecycle }),
      (error) => error === reason,
    )
    await started.promise
    controller.abort(reason)
    assert.deepEqual(await lifecycle.cleanup(), [])
    await assert.rejects(stat(fixture.options.profileDir), { code: 'ENOENT' })
    release.resolve()
    await rejected
    await assert.rejects(stat(fixture.options.profileDir), { code: 'ENOENT' })
    assert.equal(fixture.sockets.length, 0)
  },
)

test('Chromium normal close rejects a late browser exit while lifecycle cleanup remains available', async (t) => {
  const fixture = await chromiumFixture(t)
  const originalSpawn = fixture.options.lifecycle.spawn
  let browser
  fixture.options.lifecycle.spawn = (...args) => (browser = originalSpawn(...args))
  const adapter = await startChromium(fixture.options)
  const failure = new Error('Process Chromium exited unexpectedly (7)')
  t.mock.method(browser, 'assertRunning', () => {
    throw failure
  })
  fixture.sockets[0].emit('close')
  await assert.rejects(adapter.close(), (error) => error === failure)
  await fixture.options.lifecycle.callbacks[0]()
})
