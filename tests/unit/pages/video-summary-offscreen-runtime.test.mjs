import assert from 'node:assert/strict'
import test from 'node:test'
import { startVideoSummaryOffscreenRuntime } from '../../../src/pages/VideoSummaryOffscreen/runtime.mjs'
import { createFakePort } from '../helpers/port.mjs'

const owner = { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: 'abcdefghijk' }
const fence = { owner, taskId: 'task-1', generation: 1, attempt: 1 }
const payload = {
  sourceChoice: 'native-subtitle',
  sourceSnapshot: {
    pageIdentity: { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' },
  },
  settingsSnapshot: {},
  modelSnapshot: {},
}

function createClock() {
  let now = 0
  let id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, delay) {
      timers.set(++id, { fn, at: now + delay })
      return id
    },
    clearTimeout(timerId) {
      timers.delete(timerId)
    },
    advance(ms) {
      now += ms
      for (const [timerId, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(timerId)
          timer.fn()
        }
      }
    },
  }
}

function createFixture() {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const clock = createClock()
  const calls = { register: [], authorize: [], cancel: [], release: [], delete: [] }
  let registered
  const runner = {
    registerAttempt(value) {
      registered = value
      calls.register.push(value)
    },
    async authorizeAttempt(value) {
      calls.authorize.push(value)
      registered.emit({ type: 'TASK_RESULT', checkpointAvailable: true, result: { summary: 'ok' } })
    },
    cancelGeneration(value) {
      calls.cancel.push(value)
    },
    releaseAttempt(value) {
      calls.release.push(value)
    },
    deleteTask(value) {
      calls.delete.push(value)
    },
  }
  startVideoSummaryOffscreenRuntime({ port, taskRunner: runner, logger: {}, clock })
  return { port, clock, calls }
}

test('Offscreen accepts registration before authorization and releases after terminal event', async () => {
  const fixture = createFixture()
  fixture.port.emitMessage({
    type: 'START_ATTEMPT',
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload,
  })
  assert.deepEqual(fixture.port.postedMessages[0], {
    type: 'ATTEMPT_ACCEPTED',
    requestId: 'start-1',
    fence,
  })
  assert.deepEqual(fixture.calls.authorize, [])
  fixture.port.emitMessage({ type: 'ATTEMPT_AUTHORIZED', requestId: 'start-1', fence })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fixture.port.postedMessages.at(-2).type, 'TASK_EVENT')
  assert.equal(fixture.port.postedMessages.at(-2).event.type, 'TASK_COMPLETED')
  assert.equal(fixture.port.postedMessages.at(-1).type, 'EXECUTION_RELEASED')
  assert.deepEqual(fixture.calls.release, [fence])
})

test('authorization watchdog cancels generation without provider execution', () => {
  const fixture = createFixture()
  fixture.port.emitMessage({
    type: 'START_ATTEMPT',
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload,
  })
  fixture.clock.advance(10_000)
  assert.deepEqual(fixture.calls.authorize, [])
  assert.deepEqual(fixture.calls.cancel, [{ owner, taskId: 'task-1', generation: 1 }])
  assert.deepEqual(fixture.calls.release, [fence])
})

test('release retransmits at most ten total times and ACK clears the tombstone', async () => {
  const fixture = createFixture()
  fixture.port.emitMessage({
    type: 'START_ATTEMPT',
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload,
  })
  fixture.port.emitMessage({ type: 'ATTEMPT_AUTHORIZED', requestId: 'start-1', fence })
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let index = 0; index < 20; index += 1) fixture.clock.advance(1_000)
  assert.equal(
    fixture.port.postedMessages.filter((message) => message.type === 'EXECUTION_RELEASED').length,
    10,
  )

  const acknowledged = createFixture()
  acknowledged.port.emitMessage({
    type: 'START_ATTEMPT',
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload,
  })
  acknowledged.port.emitMessage({ type: 'ATTEMPT_AUTHORIZED', requestId: 'start-1', fence })
  await new Promise((resolve) => setTimeout(resolve, 0))
  acknowledged.port.emitMessage({ type: 'EXECUTION_RELEASED_ACK', fence })
  acknowledged.clock.advance(20_000)
  assert.equal(
    acknowledged.port.postedMessages.filter((message) => message.type === 'EXECUTION_RELEASED')
      .length,
    1,
  )
})

test('generation cancel and idempotent delete use fenced runner interfaces', () => {
  const fixture = createFixture()
  fixture.port.emitMessage({ type: 'CANCEL_TASK', fence })
  fixture.port.emitMessage({ type: 'DELETE_TASK', owner, taskId: 'task-1', generation: 1 })
  fixture.port.emitMessage({ type: 'DELETE_TASK', owner, taskId: 'task-1', generation: 1 })
  assert.deepEqual(fixture.calls.cancel, [{ owner, taskId: 'task-1', generation: 1 }])
  assert.equal(fixture.calls.delete.length, 2)
  assert.equal(
    fixture.port.postedMessages.filter((message) => message.type === 'TASK_DELETED').length,
    2,
  )
})
