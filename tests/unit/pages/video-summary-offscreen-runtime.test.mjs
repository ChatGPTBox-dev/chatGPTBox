import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bootstrapVideoSummaryOffscreenRuntime,
  startVideoSummaryOffscreenRuntime,
} from '../../../src/pages/VideoSummaryOffscreen/runtime.mjs'
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
  startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: runner,
    logger: {},
    clock,
    cleanupTask: async () => {},
  })
  return { port, clock, calls }
}

test('bootstrap clears every root child before connecting', async () => {
  const order = []
  await bootstrapVideoSummaryOffscreenRuntime({
    cleanupRoot: async () => {
      order.push('remove-one', 'remove-two', 'remove-three')
    },
    connect() {
      order.push('connect')
      return createFakePort({ name: 'video-summary-offscreen' })
    },
    startRuntime() {
      order.push('start')
    },
  })
  assert.deepEqual(order, ['remove-one', 'remove-two', 'remove-three', 'connect', 'start'])
})

test('bootstrap cleanup failure prevents connection', async () => {
  let connected = false
  await assert.rejects(
    bootstrapVideoSummaryOffscreenRuntime({
      cleanupRoot: async () => {
        throw new Error('DELETE_FAILED')
      },
      connect() {
        connected = true
      },
      startRuntime() {},
    }),
    /DELETE_FAILED/,
  )
  assert.equal(connected, false)
})

test('runtime cleans media on command rejection, cancel, delete, and disconnect', async () => {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const cleaned = []
  const runner = {
    registerAttempt() {
      throw new Error('REJECTED')
    },
    authorizeAttempt() {},
    cancelGeneration() {},
    releaseAttempt() {},
    deleteTask() {},
  }
  startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: runner,
    logger: {},
    cleanupTask: async ({ taskId, signal }) => {
      assert.equal(signal.aborted, false)
      cleaned.push(taskId)
    },
  })
  port.emitMessage({ type: 'START_ATTEMPT', requestId: 'start-1', fence, mode: 'initial', payload })
  port.emitMessage({ type: 'CANCEL_TASK', fence })
  port.emitMessage({ type: 'DELETE_TASK', owner, taskId: 'task-2', generation: 1 })
  port.emitDisconnect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(cleaned.sort(), ['task-1', 'task-1', 'task-2'])
})

test('cleanup failure resets runtime instead of claiming task deletion', async () => {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  let resets = 0
  startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      registerAttempt() {},
      authorizeAttempt() {},
      cancelGeneration() {},
      releaseAttempt() {},
      deleteTask() {},
    },
    logger: {},
    cleanupTask: async () => {
      throw new Error('DELETE_FAILED')
    },
    resetRuntime() {
      resets += 1
    },
  })
  port.emitMessage({ type: 'DELETE_TASK', owner, taskId: 'task-1', generation: 1 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resets, 1)
  assert.deepEqual(port.postedMessages, [])
})

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

test('generation cancel and idempotent delete use fenced runner interfaces', async () => {
  const fixture = createFixture()
  fixture.port.emitMessage({ type: 'CANCEL_TASK', fence })
  fixture.port.emitMessage({ type: 'DELETE_TASK', owner, taskId: 'task-1', generation: 1 })
  fixture.port.emitMessage({ type: 'DELETE_TASK', owner, taskId: 'task-1', generation: 1 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fixture.calls.cancel, [{ owner, taskId: 'task-1', generation: 1 }])
  assert.equal(fixture.calls.delete.length, 2)
  assert.equal(
    fixture.port.postedMessages.filter((message) => message.type === 'TASK_DELETED').length,
    2,
  )
})

test('gateway requests are limited to sixteen unsettled calls per generation', async () => {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  let registered
  const runtime = startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      registerAttempt(value) {
        registered = value
      },
      authorizeAttempt() {
        return new Promise(() => {})
      },
      cancelGeneration() {},
      releaseAttempt() {},
      deleteTask() {},
    },
    logger: {},
    createRequestId: (() => {
      let request = 0
      return () => `gateway-${++request}`
    })(),
  })
  port.emitMessage({ type: 'START_ATTEMPT', requestId: 'start-1', fence, mode: 'initial', payload })
  port.emitMessage({ type: 'ATTEMPT_AUTHORIZED', requestId: 'start-1', fence })

  const pending = Array.from({ length: 16 }, () =>
    runtime.modelGateway.generateText({ taskId: fence.taskId }),
  )
  assert.equal(port.postedMessages.filter(({ type }) => type === 'GATEWAY_REQUEST').length, 16)
  await assert.rejects(
    runtime.modelGateway.generateText({ taskId: fence.taskId }),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
  assert.equal(port.postedMessages.filter(({ type }) => type === 'GATEWAY_REQUEST').length, 16)

  port.emitMessage({
    type: 'GATEWAY_RESPONSE',
    requestId: 'gateway-1',
    fence,
    ok: true,
    result: {},
  })
  await pending[0]
  void runtime.modelGateway.generateText({ taskId: fence.taskId })
  assert.equal(port.postedMessages.filter(({ type }) => type === 'GATEWAY_REQUEST').length, 17)

  const nextGeneration = { ...fence, generation: 2 }
  for (let index = 0; index < 16; index += 1) {
    void runtime.requestGateway({
      fence: nextGeneration,
      gateway: 'model',
      operation: 'generateText',
      args: {},
    })
  }
  assert.equal(
    port.postedMessages.filter(
      (message) => message.type === 'GATEWAY_REQUEST' && message.fence.generation === 2,
    ).length,
    16,
  )
  assert.equal(typeof registered.payload.requestSourceRefresh, 'function')
})

test('task abort cancels every pending gateway request and source refresh', async () => {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  let registered
  const runtime = startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      registerAttempt(value) {
        registered = value
      },
      authorizeAttempt() {
        return new Promise(() => {})
      },
      cancelGeneration() {},
      releaseAttempt() {},
      deleteTask() {},
    },
    logger: {},
    createRequestId: (() => {
      let request = 0
      return () => `request-${++request}`
    })(),
  })
  port.emitMessage({ type: 'START_ATTEMPT', requestId: 'start-1', fence, mode: 'initial', payload })
  port.emitMessage({ type: 'ATTEMPT_AUTHORIZED', requestId: 'start-1', fence })
  const controller = new AbortController()
  const gatewayPromise = runtime.modelGateway.generateText(
    { taskId: fence.taskId },
    { signal: controller.signal },
  )
  const refreshPromise = registered.payload.requestSourceRefresh(
    {
      owner,
      taskId: fence.taskId,
      reason: 'SIGNED_URL_EXPIRED',
    },
    { signal: controller.signal },
  )

  controller.abort()
  await assert.rejects(gatewayPromise, { name: 'AbortError' })
  await assert.rejects(refreshPromise, { name: 'AbortError' })
  assert.deepEqual(
    port.postedMessages.filter(({ type }) => type === 'CANCEL_GATEWAY_REQUEST'),
    [{ type: 'CANCEL_GATEWAY_REQUEST', requestId: 'request-1', fence }],
  )
})
