// Internal entry point: lifecycle starts this process in a new POSIX session.
// Never use a remembered PID to signal a group, including on error paths.
import { spawn } from 'node:child_process'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

if (process.platform === 'win32' || typeof process.send !== 'function') {
  throw new Error('The smoke supervisor requires an isolated POSIX IPC child')
}

let started = false
let stopping = false
let forcing = false
let timer

function force() {
  if (forcing) return
  forcing = true
  stopping = true
  clearTimeout(timer)
  // The sender is itself a member, so this cannot select a recycled group.
  // SIGKILL includes us: do not promise a subsequent target-exit message.
  const kill = () => process.kill(0, 'SIGKILL')
  timer = setTimeout(kill, 100)
  if (process.connected) {
    try {
      process.send({ version: 1, type: 'terminating' }, kill)
    } catch {
      kill()
    }
  } else kill()
}

function stop(graceMs = 100) {
  if (stopping) return
  stopping = true
  timer = setTimeout(force, graceMs)
  process.kill(0, 'SIGTERM')
}

function send(message) {
  if (!process.connected) {
    stop()
    return
  }
  process.send({ version: 1, ...message }, (error) => {
    if (error) stop()
  })
}

// Remain alive through the graceful group signal, including after target exit.
process.on('SIGTERM', () => {})
process.on('SIGINT', () => stop())
process.on('disconnect', () => stop())
process.on('error', () => stop())
process.on('message', (message) => {
  if (!message || message.version !== 1) {
    stop()
    return
  }
  if (message.type === 'force') {
    force()
    return
  }
  if (message.type === 'stop') {
    if (!Number.isFinite(message.graceMs) || message.graceMs < 0 || message.graceMs > 1000) {
      stop()
      return
    }
    stop(message.graceMs)
    return
  }
  if (stopping) return
  if (
    message.type !== 'start' ||
    started ||
    typeof message.command !== 'string' ||
    !Array.isArray(message.args) ||
    !message.args.every((arg) => typeof arg === 'string')
  ) {
    stop()
    return
  }
  started = true
  try {
    const target = spawn(message.command, message.args, {
      cwd: message.cwd,
      env: message.env,
      detached: false,
      // The target must not inherit the private control channel.
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    target.once('spawn', () => send({ type: 'started', pid: target.pid }))
    target.once('error', (error) =>
      send({ type: 'start-error', message: error.message, code: error.code }),
    )
    target.once('exit', (code, signal) => send({ type: 'target-exit', code, signal }))
  } catch (error) {
    send({ type: 'start-error', message: error.message, code: error.code })
  }
})
send({ type: 'ready' })
