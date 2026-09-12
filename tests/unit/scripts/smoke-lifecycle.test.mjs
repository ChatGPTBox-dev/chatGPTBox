import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import test from 'node:test'
import timers from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { bounded, createLifecycle, waitFor } from '../../../scripts/smoke/lifecycle.mjs'

const fixture = fileURLToPath(new URL('../../fixtures/smoke/process.fixture', import.meta.url))
const options = { timeout: 10000, skip: process.platform === 'win32' }

function owned(t, options = {}) {
  const lifecycle = createLifecycle({ cleanupTimeoutMs: 1500, ...options })
  t.after(() => lifecycle.force())
  return lifecycle
}

function stalledCleanupClock(t) {
  const clock = { elapsed: 0, delays: [] }
  const setTimeout = timers.setTimeout
  const time = t.mock.method(performance, 'now', () => clock.elapsed)
  const timeout = t.mock.method(timers, 'setTimeout', (callback, ms, ...args) => {
    clock.delays.push(ms)
    // Only the two stalled-callback tests use this clock. Advance by the
    // requested budget when its timer fires, independently of worker pauses.
    return setTimeout(() => {
      clock.elapsed += ms
      callback(...args)
    }, 0)
  })
  syncBuiltinESMExports()
  t.after(() => {
    time.mock.restore()
    timeout.mock.restore()
    syncBuiltinESMExports()
  })
  return clock
}

async function ready(managed) {
  await waitFor(
    () => {
      managed.assertRunning()
      return managed.output().includes('READY') && managed.output().includes('stderr ready')
    },
    { timeoutMs: 3000, label: 'Fixture startup' },
  )
}

async function isLive(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])
    }
    return true
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false
    throw error
  }
}

test(
  'bounded settles success, failure, timeout, and cancellation without late rejections',
  options,
  async () => {
    assert.equal(await bounded(Promise.resolve(42), 100, 'Success'), 42)
    const failure = new Error('Original failure')
    await assert.rejects(bounded(Promise.reject(failure), 100, 'Failure'), (e) => e === failure)
    await assert.rejects(bounded(new Promise(() => {}), 20, 'Stalled'), /Stalled timed out/)
    const controller = new AbortController()
    const pending = bounded(
      delay(50).then(() => Promise.reject(failure)),
      500,
      'Abort',
      controller.signal,
    )
    controller.abort(failure)
    await assert.rejects(pending, (e) => e === failure)
    await assert.rejects(
      bounded(
        Promise.reject(new Error('Late rejection')),
        500,
        'Already aborted',
        controller.signal,
      ),
      (e) => e === failure,
    )
    await delay(75)
    for (const ms of [0, -1, Infinity, NaN, 2147483648]) {
      await assert.rejects(bounded(Promise.resolve(), ms, 'Invalid'), RangeError)
    }
  },
)

test('waitFor retries only falsy readiness and bounds a hung probe', options, async () => {
  let attempts = 0
  assert.equal(
    await waitFor(() => (++attempts === 3 ? 'ready' : false), { timeoutMs: 1000 }),
    'ready',
  )
  assert.equal(attempts, 3)
  attempts = 0
  await assert.rejects(
    waitFor(() => {
      attempts++
      throw new Error('Fatal probe')
    }),
    /Fatal probe/,
  )
  assert.equal(attempts, 1)
  await assert.rejects(
    waitFor(() => new Promise(() => {}), { timeoutMs: 20, label: 'Hung probe' }),
    /Hung probe timed out/,
  )
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 20 }),
    /timed out/,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    waitFor(() => assert.fail('Aborted probe ran'), { signal: controller.signal }),
    { name: 'AbortError' },
  )
})

test(
  'cleanup is LIFO and idempotent, and continues after failed or hung callbacks',
  options,
  async (t) => {
    const lifecycle = owned(t, { cleanupTimeoutMs: 180 })
    const seen = []
    lifecycle.defer('First', (...args) => {
      assert.deepEqual(args, [])
      seen.push('first')
    })
    lifecycle.defer('Failed', () => {
      seen.push('failed')
      throw new Error('Cleanup failed')
    })
    lifecycle.defer('Hung', () => {
      seen.push('hung')
      return new Promise(() => {})
    })
    const started = performance.now()
    const cleanup = lifecycle.cleanup()
    assert.equal(lifecycle.cleanup(), cleanup)
    assert.throws(() => lifecycle.defer('Late', () => {}), /closing/)
    assert.throws(() => lifecycle.spawn(process.execPath, [fixture, 'hang']), /closing/)
    const errors = await cleanup
    assert.equal(errors.length, 2)
    assert.match(errors[0].message, /Hung.*timed out/)
    assert.match(errors[1].message, /Failed.*Cleanup failed/)
    assert.deepEqual(seen, ['hung', 'failed', 'first'])
    assert.ok(performance.now() - started < 1000)
    assert.equal(await lifecycle.cleanup(), errors)
  },
)

test('spawn failure is observable and does not prevent independent cleanup', options, async (t) => {
  const lifecycle = owned(t)
  let cleaned = false
  lifecycle.defer('Independent', () => {
    cleaned = true
  })
  const managed = lifecycle.spawn('/nonexistent/chatgptbox-smoke-executable', [])
  await assert.rejects(managed.exited, /ENOENT/)
  assert.throws(() => managed.assertRunning(), /ENOENT/)
  const errors = await lifecycle.cleanup()
  assert.equal(cleaned, true)
  assert.ok(errors.some((error) => /ENOENT/.test(error.message)))
})

test('multiple stalled resources share one aggregate cleanup budget', options, async (t) => {
  const lifecycle = owned(t, { cleanupTimeoutMs: 200 })
  const clock = stalledCleanupClock(t)
  const seen = []
  for (let index = 0; index < 4; index++) {
    lifecycle.defer(`Stalled ${index}`, () => {
      seen.push(index)
      return new Promise(() => {})
    })
  }
  assert.equal((await lifecycle.cleanup()).length, 4)
  assert.deepEqual(seen, [3, 2, 1, 0])
  assert.equal(clock.elapsed, 200, 'Cleanup multiplied the timeout by resource count')
})

test(
  'an exhausted aggregate deadline does not add a timer for every remaining resource',
  options,
  async (t) => {
    const lifecycle = owned(t, { cleanupTimeoutMs: 20 })
    const clock = stalledCleanupClock(t)
    let invoked = 0
    for (let index = 0; index < 250; index++) {
      lifecycle.defer(`Stalled ${index}`, () => {
        invoked++
        return new Promise(() => {})
      })
    }
    const errors = await lifecycle.cleanup()
    assert.equal(errors.length, 250)
    assert.equal(invoked, 250)
    assert.ok(errors.some((error) => /Overall cleanup deadline exceeded/.test(error.message)))
    assert.equal(clock.elapsed, 20, 'Cleanup added per-resource delays after its deadline')
    assert.ok(clock.delays.length <= 20, 'Expired resources must not allocate more timers')
  },
)

test(
  'a failed callback cannot strand processes or remove their profile before reaping',
  options,
  async (t) => {
    const lifecycle = owned(t)
    let managed
    let profileCleaned = false
    lifecycle.defer('Profile', async () => {
      assert.equal(await isLive(managed.child.pid), false)
      assert.notEqual(managed.child.signalCode, null)
      profileCleaned = true
    })
    managed = lifecycle.spawn(process.execPath, [fixture, 'ignore-term'])
    await ready(managed)
    lifecycle.defer('Broken protocol close', () => {
      throw new Error('Protocol unavailable')
    })
    const errors = await lifecycle.cleanup()
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /Protocol unavailable/)
    assert.equal(profileCleaned, true)
  },
)

test(
  'early exit preserves status and both output streams in diagnostics and log',
  options,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'smoke-lifecycle-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const lifecycle = owned(t)
    const logPath = join(directory, 'process.log')
    const managed = lifecycle.spawn(process.execPath, [fixture, 'early-exit'], { logPath })
    assert.deepEqual(await bounded(managed.exited, 3000, 'Early exit'), { code: 7, signal: null })
    assert.throws(() => managed.assertRunning(), /exited unexpectedly/)
    assert.deepEqual(await lifecycle.cleanup(), [])
    for (const output of [managed.output(), await readFile(logPath, 'utf8')]) {
      assert.match(output, /stdout before exit/)
      assert.match(output, /stderr before exit/)
    }
  },
)

test('cleanup terminates and reaps a hanging owned child', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'])
  await ready(managed)
  assert.deepEqual(await lifecycle.cleanup(), [])
  assert.deepEqual(await managed.exited, { code: null, signal: 'SIGTERM' })
  assert.equal(await isLive(managed.child.pid), false)
  await lifecycle.assertProcessesStopped()
})

test('parent cleanup never signals a remembered numeric process group', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'])
  await ready(managed)
  const originalKill = process.kill
  const destructiveSignals = []
  try {
    process.kill = (pid, signal) => {
      if (signal !== 0) destructiveSignals.push({ pid, signal })
      return originalKill.call(process, pid, signal)
    }
    assert.deepEqual(await lifecycle.cleanup(), [])
    assert.deepEqual(destructiveSignals, [])
  } finally {
    process.kill = originalKill
  }
})

test('force before supervisor readiness prevents target startup', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'early-exit'])
  assert.deepEqual(await lifecycle.force(), [])
  await assert.rejects(managed.exited, /Target exit status unavailable/)
  assert.equal(managed.output(), '')
  assert.equal(await isLive(managed.child.pid), false)
})

test('cleanup waiting on another resource cannot start a late-ready target', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'early-exit'])
  lifecycle.defer('Protocol close', () => delay(300))
  assert.deepEqual(await lifecycle.cleanup(), [])
  await assert.rejects(managed.exited, /Target exit status unavailable/)
  assert.equal(managed.output(), '')
})

test('the target does not inherit the supervisor control channel', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, ['-e', 'console.log(typeof process.send)'])
  assert.deepEqual(await bounded(managed.exited, 3000), { code: 0, signal: null })
  assert.deepEqual(await lifecycle.cleanup(), [])
  assert.equal(managed.output().trim(), 'undefined')
})

test(
  'control EOF invokes supervisor cleanup without waiting for ChildProcess close',
  options,
  async (t) => {
    const lifecycle = owned(t)
    const managed = lifecycle.spawn(process.execPath, [fixture, 'ignore-term'])
    await ready(managed)
    managed.child.disconnect()
    const errors = await lifecycle.cleanup()
    assert.ok(errors.some((error) => /disconnected|ownership was lost/.test(error.message)))
    await waitFor(async () => !(await isLive(managed.child.pid)), { timeoutMs: 2000 })
    await assert.rejects(lifecycle.assertProcessesStopped(), /ownership was lost/)
  },
)

test('invalid supervisor results cannot resolve the target successfully', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'])
  await ready(managed)
  managed.child.emit('message', { version: 1, type: 'target-exit' })
  await assert.rejects(managed.exited, /Invalid supervisor message/)
  assert.ok((await lifecycle.cleanup()).length > 0)
  await assert.rejects(lifecycle.assertProcessesStopped(), /ownership was lost/)
})

test(
  'supervisor exit before final IPC delivery preserves the target result',
  options,
  async (t) => {
    const lifecycle = owned(t)
    const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'])
    await ready(managed)
    const originalEmit = managed.child.emit
    const pending = []
    let exited = false
    let disconnected = false
    let sawTerminating = false
    managed.child.emit = function (event, ...args) {
      if (event === 'message' && args[0]?.type === 'terminating') sawTerminating = true
      if (
        !exited &&
        event === 'message' &&
        ['target-exit', 'terminating'].includes(args[0]?.type)
      ) {
        pending.push(args)
        return true
      }
      if (event === 'disconnect' && !exited) {
        disconnected = true
        return true
      }
      const result = originalEmit.call(this, event, ...args)
      if (event === 'exit') {
        exited = true
        for (const message of pending) originalEmit.call(this, 'message', ...message)
        if (disconnected) originalEmit.call(this, 'disconnect')
      }
      return result
    }
    try {
      assert.deepEqual(await lifecycle.cleanup(), [])
      assert.equal(sawTerminating, true)
      assert.deepEqual(await managed.exited, { code: null, signal: 'SIGTERM' })
    } finally {
      managed.child.emit = originalEmit
    }
  },
)

test(
  'unexpected supervisor exit remains uncertain even after its group disappears',
  options,
  async (t) => {
    const lifecycle = owned(t)
    const managed = lifecycle.spawn(process.execPath, [fixture, 'early-exit'])
    assert.deepEqual(await bounded(managed.exited, 3000), { code: 7, signal: null })
    // The fixture has already ended; only our directly owned supervisor remains.
    const exited = new Promise((resolve) => managed.child.once('exit', resolve))
    managed.child.kill('SIGKILL')
    await bounded(exited, 2000)
    const errors = await lifecycle.cleanup()
    assert.ok(errors.some((error) => /Supervisor/.test(error.message)))
    await assert.rejects(lifecycle.assertProcessesStopped(), /ownership was lost/)
  },
)

test(
  'a timed-out process cleanup preserves its guarded profile until the process stops',
  options,
  async (t) => {
    const profileDir = await mkdtemp(join(tmpdir(), 'smoke-lifecycle-preserved-profile-'))
    const lifecycle = owned(t, { cleanupTimeoutMs: 1000 })
    lifecycle.defer('Profile', async () => {
      await lifecycle.assertProcessesStopped()
      await rm(profileDir, { recursive: true })
    })
    const managed = lifecycle.spawn(process.execPath, [fixture, 'ignore-term'])
    const originalSend = managed.child.send
    const originalDisconnect = managed.child.disconnect
    let suppressedCommands = 0
    try {
      await ready(managed)
      managed.child.send = () => {
        suppressedCommands++
        return true
      }
      managed.child.disconnect = () => {}
      const errors = await lifecycle.cleanup()
      assert.ok(suppressedCommands > 0)
      assert.ok(errors.length > 0)
      await assert.rejects(
        bounded(lifecycle.assertProcessesStopped(), 2000, 'Check surviving process'),
        /ownership was lost/,
      )
      assert.equal(await isLive(managed.child.pid), true)
      assert.equal((await stat(profileDir)).isDirectory(), true)
    } finally {
      managed.child.send = originalSend
      managed.child.disconnect = originalDisconnect
      if (managed.child.connected) managed.child.disconnect()
      await lifecycle.force()
      await waitFor(async () => !(await isLive(managed.child.pid)), { timeoutMs: 2000 })
      await rm(profileDir, { recursive: true, force: true })
    }
    await assert.rejects(lifecycle.assertProcessesStopped(), /ownership was lost/)
  },
)

test(
  'the stopped-process guard preserves ownership on missing or unknown process state',
  options,
  async (t) => {
    const lifecycle = owned(t)
    const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'])
    const originalKill = process.kill
    let inspectionError
    const checks = []
    try {
      await ready(managed)
      process.kill = (pid, signal) => {
        if (pid === -managed.child.pid) {
          checks.push(signal)
          if (inspectionError) throw inspectionError
        }
        return originalKill.call(process, pid, signal)
      }
      inspectionError = Object.assign(new Error('Process not visible'), { code: 'ESRCH' })
      await lifecycle.assertProcessesStopped()
      inspectionError = Object.assign(new Error('Process inspection denied'), { code: 'EPERM' })
      await assert.rejects(lifecycle.assertProcessesStopped(), (error) => error === inspectionError)
      inspectionError = undefined
      await assert.rejects(lifecycle.assertProcessesStopped(), /still has live members/)
      assert.deepEqual(checks, [0, 0, 0])
    } finally {
      process.kill = originalKill
      await lifecycle.force()
      await assert.rejects(
        bounded(managed.exited, 2000, 'Reap inspection fixture'),
        /status unavailable/,
      )
    }
    await lifecycle.assertProcessesStopped()
  },
)

test('cleanup escalates an owned group ignoring TERM to KILL', options, async (t) => {
  const lifecycle = owned(t, { cleanupTimeoutMs: 800 })
  const managed = lifecycle.spawn(process.execPath, [fixture, 'ignore-term'])
  await ready(managed)
  assert.deepEqual(await lifecycle.cleanup(), [])
  await assert.rejects(managed.exited, /Target exit status unavailable/)
  assert.match(managed.output(), /IGNORED TERM/)
  assert.equal(await isLive(managed.child.pid), false)
})

test('descendants remain owned after their group leader exits', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'descendant'])
  assert.deepEqual(await bounded(managed.exited, 3000, 'Leader exit'), { code: 0, signal: null })
  const descendant = Number(managed.output().match(/DESCENDANT (\d+)/)?.[1])
  assert.ok(Number.isInteger(descendant))
  assert.equal(await isLive(descendant), true)
  assert.deepEqual(await lifecycle.cleanup(), [])
  await waitFor(async () => !(await isLive(descendant)), { timeoutMs: 1000 })
})

test(
  'independent lifecycles and an unrelated sentinel survive another lifecycle cleanup',
  options,
  async (t) => {
    const sentinel = spawn(process.execPath, [fixture, 'hang'], { stdio: 'ignore' })
    const sentinelExit = new Promise((resolve) => sentinel.once('exit', resolve))
    t.after(async () => {
      sentinel.kill('SIGKILL')
      await bounded(sentinelExit, 2000, 'Sentinel exit')
    })
    const first = owned(t)
    const second = owned(t)
    const one = first.spawn(process.execPath, [fixture, 'hang'])
    const two = second.spawn(process.execPath, [fixture, 'hang'])
    await Promise.all([ready(one), ready(two)])
    assert.deepEqual(await first.cleanup(), [])
    two.assertRunning()
    assert.equal(await isLive(two.child.pid), true)
    assert.equal(await isLive(sentinel.pid), true)
    assert.deepEqual(await second.cleanup(), [])
    assert.equal(await isLive(sentinel.pid), true)
  },
)

test(
  'abort starts cleanup and force acts as the second signal without global handlers',
  options,
  async (t) => {
    const termListeners = process.listenerCount('SIGTERM')
    const intListeners = process.listenerCount('SIGINT')
    const controller = new AbortController()
    const lifecycle = owned(t, { signal: controller.signal, cleanupTimeoutMs: 5000 })
    const managed = lifecycle.spawn(process.execPath, [fixture, 'ignore-term'])
    await ready(managed)
    controller.abort()
    assert.throws(() => lifecycle.spawn(process.execPath, [fixture, 'hang']), {
      name: 'AbortError',
    })
    await waitFor(() => managed.output().includes('IGNORED TERM'), { timeoutMs: 1000 })
    const started = performance.now()
    assert.equal(lifecycle.force(), lifecycle.cleanup())
    assert.deepEqual(await lifecycle.cleanup(), [])
    assert.ok(performance.now() - started < 750)
    await assert.rejects(managed.exited, /Target exit status unavailable/)
    assert.equal(process.listenerCount('SIGTERM'), termListeners)
    assert.equal(process.listenerCount('SIGINT'), intListeners)
  },
)

test(
  'pre-aborted lifecycle and force before spawn forbid acquiring resources',
  options,
  async (t) => {
    const controller = new AbortController()
    controller.abort()
    const aborted = owned(t, { signal: controller.signal })
    assert.throws(() => aborted.spawn(process.execPath, [fixture, 'hang']), { name: 'AbortError' })
    assert.deepEqual(await aborted.cleanup(), [])
    const forced = owned(t)
    assert.deepEqual(await forced.force(), [])
    assert.throws(() => forced.spawn(process.execPath, [fixture, 'hang']), /closing/)
  },
)

test('log errors are handled, visible, and do not strand a running process', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'], {
    logPath: '/nonexistent/chatgptbox-smoke-directory/output.log',
  })
  await waitFor(() => managed.output().includes('READY'), { timeoutMs: 3000 })
  await waitFor(
    () => {
      try {
        managed.assertRunning()
        return false
      } catch (error) {
        assert.match(error.message, /Log.*ENOENT/)
        return true
      }
    },
    { timeoutMs: 3000, label: 'Log stream failure' },
  )
  const errors = await lifecycle.cleanup()
  assert.ok(errors.some((error) => /Log.*ENOENT/.test(error.message)))
  assert.equal(await isLive(managed.child.pid), false)
})

test('output stream errors are handled and retained during cleanup', options, async (t) => {
  const lifecycle = owned(t)
  const managed = lifecycle.spawn(process.execPath, [fixture, 'hang'])
  await ready(managed)
  managed.child.stdout.destroy(new Error('Read stream failure'))
  await waitFor(
    () => {
      try {
        managed.assertRunning()
        return false
      } catch (error) {
        assert.match(error.message, /Read stream failure/)
        return true
      }
    },
    { timeoutMs: 3000, label: 'Output stream failure' },
  )
  const errors = await lifecycle.cleanup()
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /Read stream failure/)
  assert.equal(await isLive(managed.child.pid), false)
})

test(
  'a real log write error releases pipe backpressure and still allows cleanup',
  {
    ...options,
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const lifecycle = owned(t)
    const managed = lifecycle.spawn(process.execPath, [fixture, 'flood'], { logPath: '/dev/full' })
    await waitFor(() => managed.output().includes('stderr ready'), { timeoutMs: 3000 })
    assert.throws(() => managed.assertRunning(), /ENOSPC/)
    const errors = await lifecycle.cleanup()
    assert.ok(errors.some((error) => /ENOSPC/.test(error.message)))
    assert.equal(await isLive(managed.child.pid), false)
  },
)

test(
  'large output is drained to disk while the diagnostic tail stays bounded',
  options,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'smoke-lifecycle-flood-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const lifecycle = owned(t)
    const logPath = join(directory, 'flood.log')
    const managed = lifecycle.spawn(process.execPath, [fixture, 'flood'], { logPath })
    await ready(managed)
    assert.ok(managed.output().length <= 1024 * 1024)
    assert.deepEqual(await lifecycle.cleanup(), [])
    const log = await readFile(logPath, 'utf8')
    assert.equal(log.match(/O/g).length, 2 * 1024 * 1024)
    assert.equal(log.match(/E/g).length, 2 * 1024 * 1024 + 1)
  },
)
