import assert from 'node:assert/strict'
import test from 'node:test'

import { createVideoSummaryCoordinator } from '../../../src/background/video-summary-coordinator.mjs'

const identity = { platform: 'bilibili', videoId: 'BV1coord', mediaId: '101' }
const context = {
  tabId: 7,
  documentId: 'doc-7',
  frameId: 0,
  pageIdentity: identity,
  owner: { tabId: 7, documentId: 'doc-7', platform: 'bilibili', mediaId: '101' },
}
const start = {
  type: 'START_TASK',
  requestId: 'start-1',
  taskId: 'task-1',
  pageIdentity: identity,
  sourceChoice: 'native-subtitle',
  subtitleTrackId: 'track-1',
  sourceSnapshot: {
    pageIdentity: identity,
    title: 'Title',
    durationMs: 10_000,
    nativeSubtitleTracks: [
      {
        id: 'track-1',
        language: 'en',
        label: 'English',
        sourceKind: 'author',
        cues: [{ startMs: 0, endMs: 1_000, text: 'hello' }],
      },
    ],
    mediaCandidates: [],
  },
  settingsSnapshot: {
    preferredLanguage: 'en',
    speakerIdentification: true,
    summaryMaxOutputTokens: 4_000,
    asrConfirmed: false,
  },
  modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    async advance(ms) {
      const target = now + ms
      let due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      while (due) {
        now = due[1].at
        timers.delete(due[0])
        due[1].callback()
        await Promise.resolve()
        due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      }
      now = target
      await Promise.resolve()
    },
  }
}

function createHarness({ pausedEnsure = false } = {}) {
  const clock = createClock()
  const offscreenMessages = []
  const contentMessages = []
  const resetCalls = []
  const ensure = deferred()
  if (!pausedEnsure) ensure.resolve()
  const port = { id: 'port-1' }
  const otherPort = { id: 'port-2' }
  const coordinator = createVideoSummaryCoordinator({
    clock,
    ensureOffscreen: () => ensure.promise,
    sendOffscreen: (message) => offscreenMessages.push(structuredClone(message)),
    sendContent: (target, message) =>
      contentMessages.push({ port: target.id, ...structuredClone(message) }),
    resetOffscreen: async () => {
      resetCalls.push(clock.now())
    },
  })
  return {
    clock,
    coordinator,
    ensure,
    offscreenMessages,
    contentMessages,
    resetCalls,
    port,
    otherPort,
    acceptAttempt(index = 0) {
      const command = offscreenMessages[index]
      coordinator.handleOffscreenMessage({
        type: 'ATTEMPT_ACCEPTED',
        requestId: command.requestId,
        fence: command.fence,
      })
    },
    event(event, index = 0) {
      coordinator.handleOffscreenMessage({
        type: 'TASK_EVENT',
        fence: offscreenMessages[index].fence,
        event,
      })
    },
    release(index = 0) {
      coordinator.handleOffscreenMessage({
        type: 'EXECUTION_RELEASED',
        fence: offscreenMessages[index].fence,
      })
    },
  }
}

async function begin(harness, command = start, commandContext = context, port = harness.port) {
  await harness.coordinator.handleContentCommand({ context: commandContext, port, command })
  return harness.offscreenMessages.findLast((message) => message.type === 'START_ATTEMPT')
}

function retry(overrides = {}) {
  return {
    type: 'RETRY_TASK',
    requestId: 'retry-1',
    taskId: 'task-1',
    generation: 1,
    pageIdentity: identity,
    fromStage: 'synthesis',
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
    ...overrides,
  }
}

function cancelStart(overrides = {}) {
  return {
    type: 'CANCEL_START',
    cancelRequestId: 'cancel-1',
    targetStartRequestId: 'start-1',
    taskId: 'task-1',
    pageIdentity: identity,
    ...overrides,
  }
}

async function makeRetryable(harness) {
  await begin(harness)
  harness.acceptAttempt()
  harness.event({
    type: 'TASK_FAILED',
    stage: 'summarizing',
    checkpointAvailable: true,
    errorCode: 'MODEL_FAILED',
  })
  harness.release()
}

test('initial start allocates a global fence and commits TASK_STARTED before posting', async () => {
  const harness = createHarness()
  const command = await begin(harness)
  assert.deepEqual(command.fence, {
    owner: context.owner,
    taskId: 'task-1',
    generation: 1,
    attempt: 1,
  })
  assert.equal(command.mode, 'initial')
  const state = harness.coordinator.debugState()
  assert.deepEqual(state.activeSlots, [
    { key: [7, 'bilibili'], state: 'starting', fence: command.fence, pageIdentity: identity },
  ])
  assert.equal(state.retainedTasks[0].replayEvent.type, 'TASK_STARTED')
  assert.deepEqual(harness.contentMessages, [])
})

test('start replay shares one send and conflicting request content is rejected', async () => {
  const harness = createHarness()
  await Promise.all([
    begin(harness),
    begin(harness, structuredClone(start), context, harness.otherPort),
  ])
  assert.equal(harness.offscreenMessages.length, 1)
  await begin(harness, { ...start, sourceChoice: 'asr' })
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')
  harness.acceptAttempt()
  const acks = harness.contentMessages.filter(
    (message) => message.type === 'START_ACK' && message.status === 'started',
  )
  assert.equal(acks.length, 2)
  assert.deepEqual({ ...acks[0], port: undefined }, { ...acks[1], port: undefined })
})

test('one tab-platform slot rejects concurrent work and permits another platform', async () => {
  const harness = createHarness()
  await begin(harness)
  const otherContext = {
    ...context,
    documentId: 'doc-8',
    owner: { ...context.owner, documentId: 'doc-8' },
  }
  await begin(harness, { ...start, requestId: 'start-2', taskId: 'task-2' }, otherContext)
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_EXECUTION_BUSY')
  const youtubeIdentity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
  await begin(
    harness,
    {
      ...start,
      requestId: 'start-y',
      taskId: 'task-y',
      pageIdentity: youtubeIdentity,
      sourceSnapshot: { ...start.sourceSnapshot, pageIdentity: youtubeIdentity },
    },
    {
      tabId: 7,
      documentId: 'doc-y',
      frameId: 0,
      pageIdentity: youtubeIdentity,
      owner: { tabId: 7, documentId: 'doc-y', platform: 'youtube', mediaId: 'abcdefghijk' },
    },
  )
  assert.equal(harness.offscreenMessages.length, 2)
})

test('global generation scalar is not reused after deletion', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  harness.event({ type: 'TASK_COMPLETED', checkpointAvailable: true, result: { summary: 'ok' } })
  harness.release()
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: { type: 'CANCEL_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  const deletion = harness.offscreenMessages.at(-1)
  harness.coordinator.handleOffscreenMessage({ ...deletion, type: 'TASK_DELETED' })
  await begin(harness, { ...start, requestId: 'start-2', taskId: 'task-2' })
  assert.equal(harness.offscreenMessages.at(-1).fence.generation, 2)
})

test('cancel before ensure resolves creates no fence and replays both terminal ACKs', async () => {
  const harness = createHarness({ pausedEnsure: true })
  const pending = begin(harness)
  await Promise.resolve()
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: cancelStart(),
  })
  harness.ensure.resolve()
  await pending
  assert.deepEqual(harness.offscreenMessages, [])
  const messages = harness.contentMessages.map((message) => {
    const copy = { ...message }
    delete copy.port
    return copy
  })
  assert.deepEqual(messages, [
    {
      type: 'START_ACK',
      requestId: 'start-1',
      taskId: 'task-1',
      status: 'cancelled',
      fence: null,
    },
    {
      type: 'CANCEL_START_ACK',
      cancelRequestId: 'cancel-1',
      targetStartRequestId: 'start-1',
      status: 'cancelled',
      fence: null,
    },
  ])
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: cancelStart(),
  })
  assert.deepEqual(harness.contentMessages.at(-1), harness.contentMessages.at(-2))
})

test('cancel before send-commit does not consume the global generation', async () => {
  const harness = createHarness({ pausedEnsure: true })
  const pending = begin(harness)
  await Promise.resolve()
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: cancelStart(),
  })
  harness.ensure.resolve()
  await pending
  await begin(harness, { ...start, requestId: 'start-2', taskId: 'task-2' })
  assert.equal(harness.offscreenMessages.at(-1).fence.generation, 1)
})

test('cancel after START_ATTEMPT revokes and cancels without authorization', async () => {
  const harness = createHarness()
  const attempt = await begin(harness)
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: cancelStart(),
  })
  harness.acceptAttempt()
  assert.equal(
    harness.offscreenMessages.filter((message) => message.type === 'ATTEMPT_AUTHORIZED').length,
    0,
  )
  assert.equal(harness.offscreenMessages.at(-1).type, 'CANCEL_TASK')
  assert.deepEqual(harness.offscreenMessages.at(-1).fence, attempt.fence)
  assert.equal(harness.coordinator.debugState().activeSlots[0].state, 'cancelling')
  assert.equal(harness.coordinator.debugState().capabilities[0].revoked, true)
  assert.equal(harness.contentMessages[0].status, 'cancelling')
})

test('cancel request ID conflicts when reused for another target', async () => {
  const harness = createHarness({ pausedEnsure: true })
  void begin(harness)
  await Promise.resolve()
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: cancelStart(),
  })
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: cancelStart({ taskId: 'task-2', targetStartRequestId: 'start-2' }),
  })
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')
})

test('ATTEMPT_ACCEPTED synchronously authorizes, runs, and acknowledges', async () => {
  const harness = createHarness()
  const attempt = await begin(harness)
  harness.acceptAttempt()
  assert.deepEqual(harness.offscreenMessages.at(-1), {
    type: 'ATTEMPT_AUTHORIZED',
    requestId: 'start-1',
    fence: attempt.fence,
  })
  assert.equal(harness.coordinator.debugState().activeSlots[0].state, 'running')
  assert.equal(harness.contentMessages.at(-1).status, 'started')
})

test('ATTEMPT_ACCEPTED watchdog rejects and begins cancellation', async () => {
  const harness = createHarness()
  await begin(harness)
  await harness.clock.advance(10_000)
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_ATTEMPT_ACCEPT_TIMEOUT')
  assert.equal(harness.offscreenMessages.at(-1).type, 'CANCEL_TASK')
  assert.equal(harness.coordinator.debugState().activeSlots[0].state, 'cancelling')
})

test('retry retains generation, increments attempt, clears expiry, and authorizes', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  assert.equal(harness.coordinator.debugState().retainedTasks[0].expiresAt, 900_000)
  const command = await begin(harness, retry())
  assert.equal(command.mode, 'retry-summary')
  assert.equal(command.fence.generation, 1)
  assert.equal(command.fence.attempt, 2)
  assert.equal(harness.coordinator.debugState().retainedTasks[0].expiresAt, null)
  harness.acceptAttempt(harness.offscreenMessages.indexOf(command))
  assert.equal(harness.contentMessages.at(-1).type, 'RETRY_ACK')
  assert.equal(harness.contentMessages.at(-1).status, 'started')
})

test('retry record replays pending and terminal responses and detects hash conflicts', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  await Promise.all([begin(harness, retry()), begin(harness, retry(), context, harness.otherPort)])
  assert.equal(
    harness.offscreenMessages.filter((message) => message.type === 'START_ATTEMPT').length,
    2,
  )
  await begin(harness, retry({ fromStage: 'summarizing' }))
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')
  harness.acceptAttempt(
    harness.offscreenMessages.findLastIndex((message) => message.type === 'START_ATTEMPT'),
  )
  const retryAcks = harness.contentMessages.filter((message) => message.type === 'RETRY_ACK')
  assert.equal(retryAcks.length, 3)
  await begin(harness, retry())
  assert.equal(harness.contentMessages.at(-1).status, 'started')
})

test('terminal retry record can be replaced but pending retry cannot', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  await begin(harness, retry())
  await begin(harness, retry({ requestId: 'retry-2' }))
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_RETRY_PENDING')
  harness.coordinator.handleOffscreenMessage({
    type: 'ATTEMPT_REJECTED',
    requestId: 'retry-1',
    fence: harness.offscreenMessages.at(-1).fence,
    errorCode: 'REJECTED',
  })
  await begin(harness, retry({ requestId: 'retry-2' }))
  assert.equal(harness.offscreenMessages.at(-1).requestId, 'retry-2')
  assert.equal(harness.offscreenMessages.at(-1).fence.attempt, 3)
})

test('generation cancellation resolves the current retry attempt', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  const attempt = await begin(harness, retry())
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: { type: 'CANCEL_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  assert.equal(harness.offscreenMessages.at(-1).type, 'CANCEL_TASK')
  assert.deepEqual(harness.offscreenMessages.at(-1).fence, attempt.fence)
})

test('terminal event is stored before delivery and release ACK retains checkpoint', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  harness.event({ type: 'TASK_COMPLETED', checkpointAvailable: true, result: { summary: 'ok' } })
  assert.equal(harness.coordinator.debugState().retainedTasks[0].replayEvent.type, 'TASK_COMPLETED')
  assert.equal(harness.contentMessages.at(-1).type, 'TASK_EVENT')
  harness.release()
  assert.equal(harness.coordinator.debugState().activeSlots.length, 0)
  assert.equal(harness.coordinator.debugState().retainedTasks.length, 1)
  assert.equal(harness.coordinator.debugState().capabilities.length, 0)
  assert.equal(harness.offscreenMessages.at(-1).type, 'EXECUTION_RELEASED_ACK')
  assert.equal(harness.coordinator.debugState().retainedTasks[0].expiresAt, 900_000)
})

test('terminal release watchdog resets runtime and makes replay non-retryable', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  harness.event({ type: 'TASK_FAILED', checkpointAvailable: true, errorCode: 'MODEL_FAILED' })
  await harness.clock.advance(10_000)
  assert.deepEqual(harness.resetCalls, [10_000])
  assert.equal(harness.coordinator.debugState().activeSlots.length, 0)
  const retained = harness.coordinator.debugState().retainedTasks[0]
  assert.equal(retained.checkpointAvailable, false)
  assert.equal(retained.replayEvent.errorCode, 'VIDEO_SUMMARY_RUNTIME_RESTARTED')
})

test('cancel without active slot marks deleting until TASK_DELETED', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: { type: 'CANCEL_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  assert.equal(harness.coordinator.debugState().retainedTasks[0].state, 'deleting')
  const deletion = harness.offscreenMessages.at(-1)
  assert.equal(deletion.type, 'DELETE_TASK')
  await begin(harness, retry())
  assert.equal(harness.contentMessages.at(-1).errorCode, 'TASK_UNAVAILABLE')
  harness.coordinator.handleOffscreenMessage({ ...deletion, type: 'TASK_DELETED' })
  harness.coordinator.handleOffscreenMessage({ ...deletion, type: 'TASK_DELETED' })
  assert.equal(harness.coordinator.debugState().retainedTasks.length, 0)
})

test('delete watchdog resets runtime and removes retained state', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: { type: 'CANCEL_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  await harness.clock.advance(10_000)
  assert.equal(harness.resetCalls.length, 1)
  assert.equal(harness.coordinator.debugState().retainedTasks.length, 0)
})

test('offscreen disconnect rejects pending starts and permits a later generation', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.coordinator.handleOffscreenDisconnect()
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_RUNTIME_RESTARTED')
  assert.equal(harness.coordinator.debugState().activeSlots.length, 0)
  await begin(harness, { ...start, requestId: 'start-2', taskId: 'task-2' })
  assert.equal(harness.offscreenMessages.at(-1).fence.generation, 2)
})

test('attach replays active, retryable, terminal, and not-found states', async () => {
  const harness = createHarness()
  await begin(harness)
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.otherPort,
    command: { type: 'ATTACH_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  assert.equal(harness.contentMessages.at(-1).status, 'active')
  assert.equal(harness.contentMessages.at(-1).event.type, 'TASK_STARTED')
  harness.acceptAttempt()
  harness.event({ type: 'TASK_FAILED', checkpointAvailable: true, errorCode: 'MODEL_FAILED' })
  harness.release()
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.otherPort,
    command: { type: 'ATTACH_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  assert.equal(harness.contentMessages.at(-1).status, 'retryable')
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.otherPort,
    command: { type: 'ATTACH_TASK', taskId: 'missing', generation: 9, pageIdentity: identity },
  })
  assert.equal(harness.contentMessages.at(-1).status, 'not-found')
  assert.equal(harness.contentMessages.at(-1).errorCode, 'TASK_UNAVAILABLE')
})

test('same owner reconnect cancels disconnect grace', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  harness.coordinator.handleContentDisconnect({ context, port: harness.port })
  await harness.clock.advance(14_000)
  await harness.coordinator.handleContentCommand({
    context,
    port: harness.otherPort,
    command: { type: 'ATTACH_TASK', taskId: 'task-1', generation: 1, pageIdentity: identity },
  })
  await harness.clock.advance(2_000)
  assert.equal(
    harness.offscreenMessages.filter((message) => message.type === 'CANCEL_TASK').length,
    0,
  )
})

test('disconnect grace and tab removal revoke then cancel and delete after release', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  harness.coordinator.handleContentDisconnect({ context, port: harness.port })
  await harness.clock.advance(15_000)
  assert.equal(harness.coordinator.debugState().capabilities[0].revoked, true)
  assert.equal(harness.offscreenMessages.at(-1).type, 'CANCEL_TASK')
  harness.release()
  assert.equal(harness.offscreenMessages.at(-1).type, 'DELETE_TASK')
  const deletion = harness.offscreenMessages.at(-1)
  harness.coordinator.handleOffscreenMessage({ ...deletion, type: 'TASK_DELETED' })
  assert.equal(harness.coordinator.debugState().retainedTasks.length, 0)
})

test('expiry callback cannot delete a task whose retry cleared its deadline', async () => {
  const harness = createHarness()
  await makeRetryable(harness)
  await harness.clock.advance(899_999)
  await begin(harness, retry())
  await harness.clock.advance(1)
  assert.notEqual(harness.offscreenMessages.at(-1).type, 'DELETE_TASK')
})

test('128 pending start records reject the next without eviction', async () => {
  const harness = createHarness({ pausedEnsure: true })
  for (let index = 0; index < 128; index += 1) {
    void begin(harness, { ...start, requestId: `start-${index}`, taskId: `task-${index}` })
  }
  await Promise.resolve()
  await begin(harness, { ...start, requestId: 'start-over', taskId: 'task-over' })
  assert.equal(
    harness.contentMessages.at(-1).errorCode,
    'VIDEO_SUMMARY_START_RECORD_LIMIT_EXCEEDED',
  )
  assert.equal(harness.coordinator.debugState().startRecords.length, 128)
})

test('terminal start records expire and free document capacity', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.coordinator.handleOffscreenMessage({
    type: 'ATTEMPT_REJECTED',
    requestId: 'start-1',
    fence: harness.offscreenMessages[0].fence,
    errorCode: 'REJECTED',
  })
  await harness.clock.advance(900_000)
  assert.equal(harness.coordinator.debugState().startRecords.length, 0)
})

test('32 retained tasks reject the 33rd without eviction', async () => {
  const harness = createHarness()
  for (let index = 0; index < 32; index += 1) {
    const task = { ...start, requestId: `start-${index}`, taskId: `task-${index}` }
    await begin(harness, task)
    harness.coordinator.handleOffscreenMessage({
      type: 'ATTEMPT_REJECTED',
      requestId: task.requestId,
      fence: harness.offscreenMessages.at(-1).fence,
      errorCode: 'REJECTED',
    })
  }
  await begin(harness, { ...start, requestId: 'start-32', taskId: 'task-32' })
  assert.equal(
    harness.contentMessages.at(-1).errorCode,
    'VIDEO_SUMMARY_RETAINED_TASK_LIMIT_EXCEEDED',
  )
  assert.equal(harness.coordinator.debugState().retainedTasks.length, 32)
})

test('oversized replay is replaced and progress stores only one event', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  harness.event({ type: 'TASK_PROGRESS', stage: 'summarizing', completedChunks: 1, totalChunks: 2 })
  harness.event({ type: 'TASK_PROGRESS', stage: 'summarizing', completedChunks: 2, totalChunks: 2 })
  assert.equal(harness.coordinator.debugState().retainedTasks[0].replayEvent.completedChunks, 2)
  harness.event({
    type: 'TASK_COMPLETED',
    checkpointAvailable: true,
    result: { summary: 'x'.repeat(16 * 1024 * 1024) },
  })
  const retained = harness.coordinator.debugState().retainedTasks[0]
  assert.equal(retained.checkpointAvailable, false)
  assert.equal(retained.replayEvent.errorCode, 'VIDEO_SUMMARY_RESULT_TOO_LARGE')
})

test('more than 16 pending gateway RPCs for a fence is rejected', async () => {
  const harness = createHarness()
  await begin(harness)
  harness.acceptAttempt()
  const fence = harness.offscreenMessages[0].fence
  for (let index = 0; index < 17; index += 1) {
    harness.coordinator.handleOffscreenMessage({
      type: 'GATEWAY_REQUEST',
      requestId: `rpc-${index}`,
      fence,
      gateway: 'model',
      operation: 'generateText',
      args: {},
    })
  }
  assert.equal(harness.offscreenMessages.at(-1).type, 'GATEWAY_RESPONSE')
  assert.equal(harness.offscreenMessages.at(-1).error.code, 'VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  assert.equal(harness.coordinator.debugState().capabilities[0].pendingRpcIds.length, 16)
})

test('nested owner maps keep delimiter-containing IDs distinct', async () => {
  const harness = createHarness()
  const firstContext = {
    ...context,
    documentId: 'doc:a',
    owner: { ...context.owner, documentId: 'doc:a', mediaId: 'b:c' },
    pageIdentity: { ...identity, mediaId: 'b:c' },
  }
  const secondContext = {
    ...context,
    tabId: 8,
    documentId: 'doc:a:b',
    owner: { ...context.owner, tabId: 8, documentId: 'doc:a:b', mediaId: 'c' },
    pageIdentity: { ...identity, mediaId: 'c' },
  }
  await begin(
    harness,
    {
      ...start,
      pageIdentity: firstContext.pageIdentity,
      sourceSnapshot: { ...start.sourceSnapshot, pageIdentity: firstContext.pageIdentity },
    },
    firstContext,
  )
  await begin(
    harness,
    {
      ...start,
      requestId: 'start-2',
      taskId: 'task-2',
      pageIdentity: secondContext.pageIdentity,
      sourceSnapshot: { ...start.sourceSnapshot, pageIdentity: secondContext.pageIdentity },
    },
    secondContext,
  )
  assert.equal(harness.coordinator.debugState().retainedTasks.length, 2)
})
