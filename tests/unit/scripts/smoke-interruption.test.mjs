import assert from 'node:assert/strict'
import { test } from 'node:test'
import process from 'node:process'
import { spawn } from 'node:child_process'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ROOT } from '../../../scripts/smoke/runner.mjs'
import { bounded, waitFor } from '../../../scripts/smoke/lifecycle.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'smoke checkout = with spaces '))
  const cleanups = []
  t.after(async () => {
    const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()))
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length) {
      t.diagnostic(`Preserved fixture after cleanup failure: ${root}`)
      throw new AggregateError(errors, 'Fixture cleanup failed')
    }
    await rm(root, { recursive: true, force: true })
  })
  await cp(join(ROOT, 'scripts/smoke'), join(root, 'scripts/smoke'), { recursive: true })
  for (const name of ['xvfb-smoke.mjs', 'run-smoke.sh']) {
    await cp(join(ROOT, 'scripts', name), join(root, 'scripts', name))
  }
  const build = join(root, 'build/chromium')
  await mkdir(build, { recursive: true })
  await writeFile(
    join(build, 'manifest.json'),
    JSON.stringify({
      name: 'Smoke fixture',
      version: '1.0',
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html' },
    }),
  )
  for (const name of ['background.js', 'popup.js', 'popup.html'])
    await writeFile(join(build, name), '')
  const executable = join(root, 'fake browser')
  await cp(join(ROOT, 'tests/fixtures/smoke/fake-browser.fixture'), executable)
  await chmod(executable, 0o700)
  return { root, executable, cleanups }
}

async function isLive(pid) {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8')
    const state = contents.slice(contents.lastIndexOf(')') + 2).split(' ')[0]
    if (!/^[A-Z]$/.test(state)) throw new Error('Invalid process state')
    return !['Z', 'X'].includes(state)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
    throw error
  }
}

async function stopRunner(child, exited) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  try {
    await bounded(exited, 15000, 'Fixture runner exit')
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await bounded(exited, 2000, 'Reap fixture runner')
  }
}

async function launch(t, fixture, tag) {
  const parent = join(fixture.root, tag)
  const child = spawn(
    'sh',
    [
      join(fixture.root, 'scripts/run-smoke.sh'),
      '--browser',
      'chromium',
      '--chromium-path',
      fixture.executable,
      '--artifacts-dir',
      parent,
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, TMPDIR: fixture.root },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  exited.catch(() => {})
  let browser
  fixture.cleanups.push(async () => {
    await stopRunner(child, exited)
    if (!browser) throw new Error('Cannot verify fixture browser cleanup')
    // Never signal a remembered target PID as a process group. The fixture's
    // watchdog is only a final safety net after a failed test, not a pass condition.
    await waitFor(async () => !(await isLive(browser.pid)), { timeoutMs: 35000 })
  })
  const artifacts = await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`Runner exited early: ${output}`)
      try {
        const entries = await readdir(parent)
        if (!entries.length) return false
        const directory = join(parent, entries[0])
        const log = await readFile(join(directory, 'chromium/chromium.log'), 'utf8')
        if (!log.endsWith('\n')) return false
        browser = JSON.parse(log.trim())
        return directory
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    },
    { timeoutMs: 10000, label: 'Fixture browser startup' },
  )
  return { child, browser, artifacts, exited, output: () => output }
}

for (const [signal, expectedCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(
    `runner forwards ${signal} to the active preflight artifact walk`,
    { skip: process.platform !== 'linux' },
    async (t) => {
      const setup = await fixture(t)
      const ready = join(setup.root, 'hash-ready')
      const stopped = join(setup.root, 'hash-stopped')
      await writeFile(
        join(setup.root, 'scripts/smoke/artifacts.mjs'),
        `
      import { writeFileSync } from 'node:fs'
      export async function hashArtifact(directory, signal) {
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            writeFileSync(${JSON.stringify(stopped)}, 'cancelled')
            reject(signal.reason)
          }, { once: true })
          writeFileSync(${JSON.stringify(ready)}, 'ready')
        })
      }
      export async function snapshotArtifact() { throw new Error('Must not start a browser') }
      `,
      )
      const child = spawn(
        process.execPath,
        [
          join(setup.root, 'scripts/xvfb-smoke.mjs'),
          '--browser',
          'chromium',
          '--chromium-path',
          setup.executable,
          '--artifacts-dir',
          join(setup.root, 'artifacts'),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code))
      })
      exited.catch(() => {})
      setup.cleanups.push(() => stopRunner(child, exited))
      await waitFor(
        async () => {
          try {
            return await readFile(ready, 'utf8')
          } catch (error) {
            if (error.code === 'ENOENT') return false
            throw error
          }
        },
        { timeoutMs: 10000, label: 'Preflight hash entry' },
      )
      child.kill(signal)
      assert.equal(await bounded(exited, 10000, 'Cancelled preflight exit'), expectedCode, output)
      assert.equal(await readFile(stopped, 'utf8'), 'cancelled')
      const [runDirectory] = await readdir(join(setup.root, 'artifacts'))
      const report = JSON.parse(
        await readFile(join(setup.root, 'artifacts', runDirectory, 'report.json'), 'utf8'),
      )
      assert.equal(report.failedStage, 'preflight')
      assert.equal(report.exitCode, expectedCode)
      assert.deepEqual(report.browsers, [])
      assert.deepEqual(report.cleanup, [])
    },
  )
}

test(
  'shell runner preserves SIGINT/SIGTERM, cleans owned profiles and isolates simultaneous runs',
  { timeout: 60000, skip: process.platform !== 'linux' },
  async (t) => {
    const setup = await fixture(t)
    const first = await launch(t, setup, 'first')
    const second = await launch(t, setup, 'second')
    assert.notEqual(first.browser.profile, second.browser.profile)
    // Foreground Ctrl+C reaches the runner group; detached browser groups are owned separately.
    process.kill(-first.child.pid, 'SIGINT')
    await delay(50)
    first.child.kill('SIGINT')
    assert.deepEqual(await bounded(first.exited, 15000, 'SIGINT exit'), { code: 130, signal: null })
    assert.equal(await isLive(second.browser.pid), true)
    assert.doesNotThrow(() => process.kill(second.child.pid, 0))
    assert.equal((await stat(second.browser.profile)).isDirectory(), true)
    second.child.kill('SIGTERM')
    assert.deepEqual(await bounded(second.exited, 15000, 'SIGTERM exit'), {
      code: 143,
      signal: null,
    })
    for (const [run, code] of [
      [first, 130],
      [second, 143],
    ]) {
      await assert.rejects(stat(run.browser.profile), { code: 'ENOENT' })
      assert.equal(await isLive(run.browser.pid), false)
      const report = JSON.parse(await readFile(join(run.artifacts, 'report.json'), 'utf8'))
      assert.equal(report.exitCode, code, run.output())
      assert.equal(report.result, 'FAIL')
      assert.deepEqual(report.cleanup, [])
      assert.equal(report.root, await realpath(setup.root))
    }
  },
)

test(
  'all-browser runner reaps the previous browser and removes its profile before starting the next',
  { timeout: 75000, skip: process.platform !== 'linux' },
  async (t) => {
    const setup = await fixture(t)
    await cp(join(setup.root, 'build/chromium'), join(setup.root, 'build/firefox'), {
      recursive: true,
    })
    await writeFile(join(setup.root, 'build/firefox.zip'), 'Fixture archive')
    const marker = join(setup.root, 'previous-browser.json')
    setup.cleanups.push(async () => {
      const previous = JSON.parse(await readFile(marker, 'utf8'))
      await waitFor(async () => !(await isLive(previous.targetPid)), { timeoutMs: 35000 })
    })
    await writeFile(
      join(setup.root, 'scripts/smoke/chromium.mjs'),
      `
    import process from 'node:process'
    import { writeFile } from 'node:fs/promises'
    import { waitFor } from './lifecycle.mjs'
    export async function startChromium({ lifecycle, profileDir }) {
      const managed = lifecycle.spawn(process.execPath, ['-e',
        'setTimeout(() => process.exit(99), 30000); console.log(process.pid)'])
      const targetPid = await waitFor(() => {
        managed.assertRunning()
        const output = managed.output()
        return /^\\d+\\n$/.test(output) && Number(output.trim())
      }, { timeoutMs: 3000 })
      await writeFile(${JSON.stringify(
        marker,
      )}, JSON.stringify({ targetPid, supervisorPid: managed.child.pid, profileDir }))
      return { metadata: {}, close: async () => {}, capture: async () => {} }
    }
  `,
    )
    await writeFile(
      join(setup.root, 'scripts/smoke/firefox.mjs'),
      `
    import process from 'node:process'
    import assert from 'node:assert/strict'
    import { readFile, stat } from 'node:fs/promises'
    const isLive = ${isLive.toString()}
    export async function startFirefox() {
      const previous = JSON.parse(await readFile(${JSON.stringify(marker)}, 'utf8'))
      assert.throws(() => process.kill(previous.supervisorPid, 0), { code: 'ESRCH' })
      assert.equal(await isLive(previous.targetPid), false)
      await assert.rejects(stat(previous.profileDir), { code: 'ENOENT' })
      return { metadata: {}, close: async () => {}, capture: async () => {} }
    }
  `,
    )
    await writeFile(
      join(setup.root, 'scripts/smoke/scenarios.mjs'),
      `
    export async function runScenarios() { return { checks: ['Fixture check'], requests: [] } }
  `,
    )
    const child = spawn(
      process.execPath,
      [
        join(setup.root, 'scripts/xvfb-smoke.mjs'),
        '--browser',
        'all',
        '--chromium-path',
        setup.executable,
        '--firefox-path',
        process.execPath,
        '--geckodriver-path',
        process.execPath,
        '--artifacts-dir',
        join(setup.root, 'artifacts'),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    setup.cleanups.push(() => stopRunner(child, exit))
    assert.equal(await bounded(exit, 10000, 'Sequential browsers'), 0, output)
  },
)

test(
  'runner reports success, failures, EPIPE and late signals truthfully',
  { timeout: 60000, skip: process.platform !== 'linux' },
  async (t) => {
    const setup = await fixture(t)
    // Substitute protocol boundaries only; exercise the real CLI, report and lifecycle.
    await writeFile(
      join(setup.root, 'scripts/smoke/chromium.mjs'),
      `
    import process from 'node:process'
    export async function startChromium({ lifecycle }) {
      lifecycle.defer('fixture cleanup', async () => {
        if (process.env.SMOKE_FIXTURE_MODE === 'cleanup') throw new Error('Fixture cleanup failure')
      })
      return { metadata: {}, close: async () => {}, capture: async () => {} }
    }
  `,
    )
    await writeFile(
      join(setup.root, 'scripts/smoke/scenarios.mjs'),
      `
    import process from 'node:process'
    import { setTimeout } from 'node:timers/promises'
    export async function runScenarios() {
      await setTimeout(50)
      if (process.env.SMOKE_FIXTURE_MODE === 'scenario-cleanup') {
        throw Object.assign(new Error('Fixture primary failure'), {
          cleanupErrors: [new Error('Fixture secondary cleanup failure')]
        })
      }
      if (process.env.SMOKE_FIXTURE_MODE === 'scenario') throw new Error('Fixture scenario failure')
      return { checks: ['Fixture check'], requests: [] }
    }
  `,
    )
    const interruptImport = join(setup.root, 'interrupt-report.mjs')
    await writeFile(
      interruptImport,
      `
      import fs from 'node:fs/promises'
      import process from 'node:process'
      import { syncBuiltinESMExports } from 'node:module'
      import { setTimeout } from 'node:timers/promises'
      const original = fs.writeFile
      let sent = false
      fs.writeFile = async (...args) => {
        const result = await original(...args)
        if (!sent && String(args[0]).endsWith('report.json')) {
          sent = true
          process.kill(process.pid, 'SIGTERM')
          await setTimeout(20)
        }
        return result
      }
      syncBuiltinESMExports()
    `,
    )
    const stdoutInterruptImport = join(setup.root, 'interrupt-stdout.mjs')
    await writeFile(
      stdoutInterruptImport,
      `
      import process from 'node:process'
      import { setInterval, clearInterval } from 'node:timers'
      const original = process.stdout.write
      let sent = false
      process.stdout.write = function (chunk, callback) {
        return original.call(this, chunk, (error) => {
          if (error || sent) return callback(error)
          sent = true
          const signal = process.env.SMOKE_FIXTURE_MODE === 'stdout-int' ? 'SIGINT' : 'SIGTERM'
          // Release the write only after the runner has observed the signal.
          const keepAlive = setInterval(() => {}, 1000)
          process.once(signal, () => {
            clearInterval(keepAlive)
            callback()
          })
          process.kill(process.pid, signal)
        })
      }
    `,
    )
    for (const [mode, expected] of [
      ['success', 0],
      ['scenario', 1],
      ['scenario-cleanup', 1],
      ['cleanup', 1],
      ['epipe', 1],
      ['late-signal', 143],
      ['stdout-int', 130],
      ['stdout-term', 143],
    ]) {
      const parent = join(setup.root, mode)
      const preload =
        mode === 'late-signal'
          ? interruptImport
          : mode.startsWith('stdout-')
          ? stdoutInterruptImport
          : undefined
      const child = spawn(
        preload ? process.execPath : 'sh',
        [
          ...(preload
            ? ['--import', preload, join(setup.root, 'scripts/xvfb-smoke.mjs')]
            : [join(setup.root, 'scripts/run-smoke.sh')]),
          '--browser',
          'chromium',
          '--chromium-path',
          setup.executable,
          '--artifacts-dir',
          parent,
        ],
        {
          env: { ...process.env, SMOKE_FIXTURE_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      if (mode === 'epipe') child.stdout.destroy()
      else
        child.stdout.on('data', (chunk) => {
          output += chunk
        })
      child.stderr.resume()
      const exit = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code))
      })
      setup.cleanups.push(() => stopRunner(child, exit))
      assert.equal(await bounded(exit, 5000, `${mode} exit`), expected, mode)
      const directories = await readdir(parent)
      const report = JSON.parse(await readFile(join(parent, directories[0], 'report.json'), 'utf8'))
      assert.equal(report.exitCode, expected, mode)
      assert.equal(report.result, expected === 0 ? 'PASS' : 'FAIL', mode)
      if (mode.startsWith('stdout-')) {
        assert.doesNotMatch(output, /PASS|exit 0/, mode)
        assert.match(output, /artifacts:/, mode)
      }
      await assert.rejects(stat(report.browsers[0].profileDir), { code: 'ENOENT' })
      if (mode === 'epipe') assert.equal(report.failedStage, 'reporting')
      if (mode === 'cleanup') assert.match(report.cleanup[0], /Fixture cleanup failure/)
      if (mode === 'scenario-cleanup') {
        assert.match(report.error, /Fixture primary failure/)
        assert.match(report.cleanup[0], /Fixture secondary cleanup failure/)
      }
    }
  },
)

test(
  'Firefox startup failures report preflight identity separately from the snapshot',
  { timeout: 10000, skip: process.platform !== 'linux' },
  async (t) => {
    const setup = await fixture(t)
    await cp(join(setup.root, 'build/chromium'), join(setup.root, 'build/firefox'), {
      recursive: true,
    })
    await writeFile(
      join(setup.root, 'scripts/smoke/firefox.mjs'),
      `
      import { join } from 'node:path'
      import { snapshotArtifact } from './artifacts.mjs'
      export async function startFirefox(options) {
        await snapshotArtifact(options.extensionDir, join(options.artifactsDir, 'extension'),
          options.artifactSha256, options.signal)
        throw new Error('Fixture Firefox startup failure')
      }
    `,
    )
    const parent = join(setup.root, 'startup-failure')
    const child = spawn(
      process.execPath,
      [
        join(setup.root, 'scripts/xvfb-smoke.mjs'),
        '--browser',
        'firefox',
        '--firefox-path',
        setup.executable,
        '--geckodriver-path',
        process.execPath,
        '--artifacts-dir',
        parent,
      ],
      { stdio: 'ignore' },
    )
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    setup.cleanups.push(() => stopRunner(child, exit))
    assert.equal(await bounded(exit, 5000, 'Firefox startup failure exit'), 1)
    const directories = await readdir(parent)
    const report = JSON.parse(await readFile(join(parent, directories[0], 'report.json'), 'utf8'))
    assert.equal(report.failedStage, 'firefox:startup')
    assert.match(report.error, /Fixture Firefox startup failure/)
    assert.equal(report.browsers[0].preflightManifestVersion, '1.0')
    assert.equal(Object.hasOwn(report.browsers[0], 'manifestVersion'), false)
    assert.equal(
      report.browsers[0].snapshotDir,
      join(await realpath(parent), directories[0], 'firefox/extension'),
    )
    assert.equal((await stat(join(report.browsers[0].snapshotDir, 'manifest.json'))).isFile(), true)
    await assert.rejects(stat(report.browsers[0].profileDir), { code: 'ENOENT' })
    assert.deepEqual(report.cleanup, [])
  },
)
