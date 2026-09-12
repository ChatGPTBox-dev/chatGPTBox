import { spawn as spawnChild } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

function checkTimeout(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2147483647) {
    throw new RangeError('Timeout must be positive and at most 2147483647 ms')
  }
}

function cancellation(signal) {
  return signal.reason ?? new Error('Operation aborted')
}

// This bounds waiting, not the underlying operation. Callers must arrange its cleanup.
export function bounded(promise, ms, label = 'Operation', signal) {
  return new Promise((resolve, reject) => {
    let timer
    const finish = (callback, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const abort = () => finish(reject, cancellation(signal))
    // Observe even an already rejected promise when cancellation wins the race.
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
    try {
      checkTimeout(ms)
    } catch (error) {
      reject(error)
      return
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(reject, new Error(`${label} timed out after ${ms} ms`)), ms)
  })
}

// Only an explicit falsy result means "not ready"; probe errors are never retried.
export async function waitFor(asyncProbe, { timeoutMs = 60000, signal, label = 'Readiness' } = {}) {
  checkTimeout(timeoutMs)
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw cancellation(signal)
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error(`${label} timed out after ${timeoutMs} ms`)
    const result = await bounded(
      Promise.resolve().then(() => {
        if (signal?.aborted) throw cancellation(signal)
        return asyncProbe()
      }),
      remaining,
      label,
      signal,
    )
    if (result) return result
    const pause = Math.min(50, deadline - performance.now())
    if (pause > 0) await delay(pause, undefined, { signal })
  }
}

// Linux may retain orphan zombies until PID 1 reaps them. They cannot run or hold
// resources, and Node can only reap its own direct children. Other POSIX hosts
// use the process-group existence check without relying on /proc.
async function hasLiveMembers(pgid) {
  if (process.platform !== 'linux') return true
  const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  // Bound concurrent descriptor use without paying one async round trip per PID.
  for (let offset = 0; offset < entries.length; offset += 64) {
    const live = await Promise.all(
      entries.slice(offset, offset + 64).map(async (entry) => {
        try {
          const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
          const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
          return Number(group) === pgid && state !== 'Z' && state !== 'X'
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
          return false
        }
      }),
    )
    if (live.some(Boolean)) return true
  }
  return false
}

export function createLifecycle({ signal, cleanupTimeoutMs = 10000 } = {}) {
  checkTimeout(cleanupTimeoutMs)
  const resources = []
  const groups = new Set()
  const errors = []
  let cleaning = false
  let forced = false
  let cleanupPromise

  const report = (label, cause) => {
    const error = new Error(`${label}: ${cause?.message ?? String(cause)}`, { cause })
    errors.push(error)
    return error
  }

  function assertOpen() {
    if (signal?.aborted) throw cancellation(signal)
    if (cleaning || forced) throw new Error('Lifecycle is closing; new resources are not allowed')
  }

  function defer(label, asyncCleanup) {
    assertOpen()
    if (typeof asyncCleanup !== 'function') throw new TypeError('Cleanup must be a function')
    resources.push({ label, run: asyncCleanup })
  }

  function groupExists(record, retire = true) {
    if (record.retired || !record.child.pid) return false
    try {
      process.kill(-record.child.pid, 0)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      if (retire) {
        record.retired = true
        groups.delete(record)
      }
      return false
    }
  }

  // Read-only guard for dependent resources such as browser profiles. Unknown
  // process state (including /proc permission failures) must preserve the resource.
  async function assertProcessesStopped() {
    for (const record of groups) {
      if (record.uncertain) throw new Error('Supervisor ownership was lost; preserve its profile')
      if (groupExists(record, false) && (await hasLiveMembers(record.child.pid))) {
        throw new Error(`Process group ${record.child.pid} still has live members`)
      }
    }
  }

  function killGroup(record, signalName) {
    record.request(signalName === 'SIGKILL' ? 'force' : 'stop')
  }

  function spawn(command, args = [], { logPath, cwd, env } = {}) {
    assertOpen()
    if (process.platform === 'win32') throw new Error('Smoke process groups require a POSIX host')
    const child = spawnChild(
      process.execPath,
      [fileURLToPath(new URL('./supervisor.mjs', import.meta.url))],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    )
    const record = { child, retired: false, uncertain: false }
    // Register ownership synchronously, before opening logs or awaiting readiness.
    groups.add(record)
    let ended = false
    let failure
    let tail = ''
    let log
    let logClosed = Promise.resolve()
    let supervisorEnded = false
    let ready = false
    let requested
    let startSent = false
    let targetStarted = false
    let terminating = false
    let graceMs = 100
    let targetResult
    let resolveTarget
    let rejectTarget
    const fail = (label, error) => {
      const reported = report(label, error)
      failure ??= reported
    }
    const exited = new Promise((resolve, reject) => {
      resolveTarget = resolve
      rejectTarget = reject
    })
    // Some callers only use assertRunning; never leave a spawn rejection unhandled.
    exited.catch(() => {})
    function lost(error) {
      record.uncertain = true
      fail('Supervisor control', error)
      rejectTarget(failure)
    }
    function send(message) {
      if (!child.connected) {
        if (!supervisorEnded) lost(new Error('Control channel unavailable'))
        return
      }
      try {
        child.send({ version: 1, ...message }, (error) => {
          if (error && !supervisorEnded) {
            lost(error)
            if (child.connected) child.disconnect()
          }
        })
      } catch (error) {
        lost(error)
        if (child.connected) child.disconnect()
      }
    }
    record.request = (type) => {
      if (supervisorEnded || record.retired) return
      if (requested === 'force' || (requested === 'stop' && type === 'stop')) return
      requested = type
      if (ready) send({ type, graceMs })
    }
    child.on('message', (message) => {
      const invalid = () => {
        lost(new Error('Invalid supervisor message'))
        record.request('force')
      }
      if (!message || message.version !== 1) {
        invalid()
        return
      }
      if (message.type === 'ready') {
        if (ready) return invalid()
        ready = true
        if (!requested && (cleaning || forced || signal?.aborted || record.uncertain)) {
          record.request(forced ? 'force' : 'stop')
          return
        }
        if (requested) send({ type: requested, graceMs })
        else {
          startSent = true
          send({ type: 'start', command, args, cwd, env })
        }
      } else if (message.type === 'started') {
        if (
          !startSent ||
          targetStarted ||
          ended ||
          !Number.isSafeInteger(message.pid) ||
          message.pid <= 0
        ) {
          return invalid()
        }
        targetStarted = true
      } else if (message.type === 'target-exit') {
        if (
          !targetStarted ||
          ended ||
          !(
            (Number.isInteger(message.code) && message.signal === null) ||
            (message.code === null && typeof message.signal === 'string')
          )
        )
          return invalid()
        ended = true
        targetResult = { code: message.code, signal: message.signal }
        resolveTarget(targetResult)
      } else if (message.type === 'start-error') {
        if (!startSent || ended || typeof message.message !== 'string') return invalid()
        ended = true
        fail(
          `Process ${command}`,
          Object.assign(new Error(message.message), { code: message.code }),
        )
        rejectTarget(failure)
      } else if (message.type === 'terminating') {
        if (!ready || terminating) return invalid()
        terminating = true
      } else invalid()
    })
    let resolveIpcClosed
    const ipcClosed = new Promise((resolve) => {
      resolveIpcClosed = resolve
    })
    const supervisorExit = new Promise((resolve) => {
      child.once('exit', (code, signalName) => {
        supervisorEnded = true
        resolve({ code, signalName })
      })
      child.once('error', (error) => {
        lost(error)
        if (!child.pid) {
          supervisorEnded = true
          resolveIpcClosed()
          resolve({ code: null, signalName: null })
        }
      })
    })
    child.on('disconnect', () => {
      if (!requested && !supervisorEnded) lost(new Error('Control channel disconnected'))
      resolveIpcClosed()
    })
    // OS exit and IPC reads are independent. Process queued final messages
    // before deciding that an acknowledgement or target result was lost.
    const supervisorSettled = Promise.all([supervisorExit, ipcClosed]).then(([result]) => {
      if (!terminating || result.signalName !== 'SIGKILL') {
        lost(new Error(`Supervisor exited unexpectedly (${result.code ?? result.signalName})`))
      }
      rejectTarget(new Error('Target exit status unavailable after supervisor termination'))
    })
    // IPC disconnect does not reliably produce ChildProcess.close on all Node
    // versions. Reaping and output draining are independent completion facts.
    const drained = Promise.all(
      [child.stdout, child.stderr].map(
        (stream) => new Promise((resolve) => stream.once('close', resolve)),
      ),
    )

    async function stop(budgetMs) {
      const deadline = performance.now() + budgetMs
      try {
        graceMs = Math.min(1000, budgetMs / 2)
        killGroup(record, forced ? 'SIGKILL' : 'SIGTERM')
        // Reap the direct child and drain both pipes before flushing the log.
        await bounded(
          supervisorSettled,
          Math.max(1, deadline - performance.now()),
          `Reap ${command}`,
        )
        await bounded(drained, Math.max(1, deadline - performance.now()), `Drain ${command}`)
        if (record.uncertain) throw new Error('Supervisor ownership was lost')
        while (groupExists(record)) {
          if (!(await hasLiveMembers(child.pid))) {
            record.retired = true
            groups.delete(record)
            break
          }
          if (performance.now() >= deadline) throw new Error('Process group did not terminate')
          await delay(10)
        }
        log?.end()
        await bounded(logClosed, Math.max(1, deadline - performance.now()), `Flush ${command} log`)
      } finally {
        // A timeout must not leave our pipes or file descriptors keeping Node alive.
        child.stdout.destroy()
        child.stderr.destroy()
        log?.destroy()
        if (!supervisorEnded) record.uncertain = true
        if (child.connected) child.disconnect()
        child.unref()
      }
    }
    resources.push({ label: `Stop ${command}`, run: stop, record })

    if (logPath !== undefined) {
      try {
        log = createWriteStream(logPath, { flags: 'a' })
        logClosed = new Promise((resolve) => log.once('close', resolve))
        log.on('error', (error) => {
          fail(`Log ${logPath}`, error)
          child.stdout.resume()
          child.stderr.resume()
        })
        log.on('drain', () => {
          child.stdout.resume()
          child.stderr.resume()
        })
      } catch (error) {
        fail(`Log ${logPath}`, error)
      }
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('error', (error) => fail(`Output ${command}`, error))
      stream.on('data', (chunk) => {
        // Keep diagnostics bounded while preserving complete output on disk.
        tail = (tail + chunk).slice(-1024 * 1024)
        if (log && !log.destroyed && !log.writableEnded && !log.write(chunk)) {
          child.stdout.pause()
          child.stderr.pause()
        }
      })
    }
    return {
      child,
      exited,
      output: () => tail,
      assertRunning() {
        assertOpen()
        if (failure) throw failure
        if (ended || supervisorEnded) {
          throw new Error(
            `Process ${command} exited unexpectedly (${
              targetResult?.code ?? targetResult?.signal ?? 'target status unavailable'
            })\n${tail}`,
          )
        }
      },
    }
  }

  function cleanup() {
    if (cleanupPromise) return cleanupPromise
    cleaning = true
    signal?.removeEventListener('abort', onAbort)
    // Defer invocation until the shared promise is installed, including reentrant cleanup.
    cleanupPromise = Promise.resolve().then(async () => {
      const deadline = performance.now() + cleanupTimeoutMs
      while (resources.length) {
        // Share one deadline fairly, so a stalled resource cannot starve later cleanup.
        const remaining = deadline - performance.now()
        const budgetMs = Math.max(1, remaining / resources.length)
        const { label, run, record } = resources.pop()
        try {
          const operation = Promise.resolve().then(() => (record ? run(budgetMs) : run()))
          if (remaining <= 0) {
            // Invoke independent cleanup, but do not add a timer per resource
            // after the overall deadline. The timeout remains an explicit failure.
            operation.catch(() => {})
            throw new Error('Overall cleanup deadline exceeded')
          }
          await bounded(operation, budgetMs, label)
        } catch (error) {
          report(label, error)
          if (record) {
            try {
              killGroup(record, 'SIGKILL')
            } catch (killError) {
              report(label, killError)
            }
          }
        }
      }
      return errors
    })
    return cleanupPromise
  }

  function force() {
    forced = true
    for (const record of groups) {
      try {
        killGroup(record, 'SIGKILL')
      } catch (error) {
        report('Force process group', error)
      }
    }
    return cleanup()
  }

  const onAbort = () => {
    cleanup()
  }
  if (signal?.aborted) cleanup()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return { defer, spawn, cleanup, force, assertProcessesStopped }
}
