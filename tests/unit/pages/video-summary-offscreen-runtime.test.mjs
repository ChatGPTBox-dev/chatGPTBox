import assert from 'node:assert/strict'
import test from 'node:test'
import { startVideoSummaryOffscreenRuntime } from '../../../src/pages/VideoSummaryOffscreen/runtime.mjs'
import {
  VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES,
  VIDEO_SUMMARY_OFFSCREEN_PORT_NAME,
  createVideoSummaryOwner,
} from '../../../src/video-summary/contracts.mjs'
import { createFakePort } from '../helpers/port.mjs'

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  }
}

function createRequestIdFactory() {
  let nextId = 1
  return () => `request-${nextId++}`
}

test('START_TASK emits events and validated cancellation releases its owner binding', async () => {
  const owner = createVideoSummaryOwner({
    tabId: 5,
    documentId: 'doc-5',
    platform: 'bilibili',
    videoId: 'BV5task',
  })
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const starts = []
  const cancels = []
  const retries = []
  const releases = []
  const taskRunner = {
    async start(command, emit) {
      starts.push(command)
      emit({
        type: 'TASK_STATUS',
        taskId: command.taskId,
        owner: command.owner,
        stage: 'running',
      })
    },
    cancel(taskId) {
      cancels.push(taskId)
    },
    release(taskId) {
      releases.push(taskId)
    },
    async retry(taskId, command) {
      retries.push({ taskId, command })
    },
  }

  startVideoSummaryOffscreenRuntime({
    port,
    taskRunner,
    logger: createLogger(),
    createRequestId: createRequestIdFactory(),
  })

  port.emitMessage({
    type: 'START_TASK',
    taskId: 'task-5',
    platform: owner.platform,
    videoId: owner.videoId,
    owner,
    sourceChoice: 'native-subtitle',
    sourceSnapshot: { videoId: owner.videoId },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { provider: 'openai' },
  })
  await Promise.resolve()

  assert.equal(starts.length, 1)
  assert.equal(typeof starts[0].requestSourceRefresh, 'function')
  assert.deepEqual(port.postedMessages[0], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.taskEvent,
    event: {
      type: 'TASK_STATUS',
      taskId: 'task-5',
      platform: owner.platform,
      videoId: owner.videoId,
      owner,
      stage: 'running',
    },
  })

  port.emitMessage({
    type: 'CANCEL_TASK',
    taskId: 'task-5',
    platform: owner.platform,
    videoId: owner.videoId,
    owner,
  })
  port.emitMessage({
    type: 'RETRY_TASK',
    taskId: 'task-5',
    platform: owner.platform,
    videoId: owner.videoId,
    owner,
    fromStage: 'summarizing',
    modelSnapshot: { provider: 'openai' },
  })
  await Promise.resolve()

  assert.deepEqual(cancels, ['task-5'])
  assert.deepEqual(releases, [])
  assert.deepEqual(retries, [])
})

test('owner binding follows result and failure retention semantics without new protocol commands', async () => {
  const owner = createVideoSummaryOwner({
    tabId: 7,
    documentId: 'doc-7',
    platform: 'bilibili',
    videoId: 'BV7retention',
  })
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const starts = []
  const retries = []
  const taskRunner = {
    async start(command, emit) {
      starts.push({ command, emit })
    },
    cancel() {},
    release() {},
    async retry(taskId) {
      retries.push(taskId)
    },
  }

  startVideoSummaryOffscreenRuntime({ port, taskRunner, logger: createLogger() })
  const start = (taskId) => {
    port.emitMessage({
      type: 'START_TASK',
      taskId,
      platform: owner.platform,
      videoId: owner.videoId,
      owner,
    })
  }
  const retry = (taskId) => {
    port.emitMessage({
      type: 'RETRY_TASK',
      taskId,
      platform: owner.platform,
      videoId: owner.videoId,
      owner,
      fromStage: 'summarizing',
    })
  }

  start('result-task')
  await Promise.resolve()
  starts.at(-1).emit({ type: 'TASK_RESULT', taskId: 'result-task', owner })
  retry('result-task')

  start('checkpoint-failure-task')
  await Promise.resolve()
  starts.at(-1).emit({
    type: 'TASK_FAILED',
    taskId: 'checkpoint-failure-task',
    owner,
    checkpointAvailable: true,
  })
  retry('checkpoint-failure-task')

  start('pre-checkpoint-failure-task')
  await Promise.resolve()
  starts.at(-1).emit({
    type: 'TASK_FAILED',
    taskId: 'pre-checkpoint-failure-task',
    owner,
    checkpointAvailable: false,
  })
  retry('pre-checkpoint-failure-task')
  await Promise.resolve()

  assert.deepEqual(retries, ['result-task', 'checkpoint-failure-task'])
  assert.equal(
    port.postedMessages.some((message) => message.type === 'RELEASE_TASK'),
    false,
  )
})

test('task commands and refresh results cannot cross platform owner bindings', async () => {
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const starts = []
  const cancels = []
  const retries = []
  const bilibiliOwner = createVideoSummaryOwner({
    tabId: 5,
    documentId: 'doc-5',
    platform: 'bilibili',
    videoId: 'same-id',
  })
  const youtubeOwner = createVideoSummaryOwner({
    tabId: 5,
    documentId: 'doc-5',
    platform: 'youtube',
    videoId: 'same-id',
  })
  let refreshPromise

  startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      async start(command) {
        starts.push(command)
        refreshPromise = command.requestSourceRefresh({
          owner: bilibiliOwner,
          taskId: command.taskId,
          expectedVideoId: command.owner.videoId,
        })
      },
      cancel(taskId) {
        cancels.push(taskId)
      },
      async retry(taskId) {
        retries.push(taskId)
      },
    },
    logger: createLogger(),
    createRequestId: createRequestIdFactory(),
  })

  port.emitMessage({
    type: 'START_TASK',
    taskId: 'same-task',
    platform: 'bilibili',
    videoId: 'same-id',
    owner: bilibiliOwner,
  })
  await Promise.resolve()
  port.emitMessage({
    type: 'START_TASK',
    taskId: 'same-task',
    platform: 'youtube',
    videoId: 'same-id',
    owner: youtubeOwner,
  })
  port.emitMessage({
    type: 'RETRY_TASK',
    taskId: 'same-task',
    platform: 'youtube',
    videoId: 'same-id',
    owner: youtubeOwner,
  })
  port.emitMessage({
    type: 'CANCEL_TASK',
    taskId: 'same-task',
    platform: 'youtube',
    videoId: 'same-id',
    owner: youtubeOwner,
  })
  port.emitMessage({
    type: 'SOURCE_REFRESH_RESULT',
    requestId: 'request-1',
    taskId: 'same-task',
    platform: 'youtube',
    videoId: 'same-id',
    owner: youtubeOwner,
    sourceSnapshot: { platform: 'youtube', videoId: 'same-id' },
  })
  await Promise.resolve()

  assert.equal(starts.length, 1)
  assert.deepEqual(retries, [])
  assert.deepEqual(cancels, [])
  assert.equal(port.postedMessages[0].owner.platform, 'bilibili')

  port.emitMessage({
    type: 'SOURCE_REFRESH_RESULT',
    requestId: 'request-1',
    taskId: 'same-task',
    platform: 'bilibili',
    videoId: 'same-id',
    owner: bilibiliOwner,
    sourceSnapshot: { platform: 'bilibili', videoId: 'same-id' },
  })
  assert.deepEqual(await refreshPromise, { platform: 'bilibili', videoId: 'same-id' })
})

test('source refresh requests and gateway responses resolve and reject by request id', async () => {
  const owner = createVideoSummaryOwner({
    tabId: 6,
    documentId: 'doc-6',
    platform: 'bilibili',
    videoId: 'BV6task',
  })
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  let startCommand = null
  const runtime = startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      async start(command) {
        startCommand = command
      },
      cancel() {},
      async retry() {},
    },
    logger: createLogger(),
    createRequestId: createRequestIdFactory(),
  })

  port.emitMessage({
    type: 'START_TASK',
    taskId: 'task-6',
    platform: owner.platform,
    videoId: owner.videoId,
    owner,
    sourceChoice: 'asr',
    sourceSnapshot: { videoId: owner.videoId },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { provider: 'openai' },
  })
  await Promise.resolve()

  const refreshPromise = startCommand.requestSourceRefresh({
    owner,
    taskId: 'task-6',
    expectedVideoId: owner.videoId,
    reason: 'DIRECT_DOWNLOAD_FAILED',
  })
  const queryPromise = runtime.mediaKitGateway.queryTask({
    taskId: 'task-6',
    signal: new AbortController().signal,
  })
  const generationPromise = runtime.modelGateway.generateText({
    requestId: 'chunk-1',
    taskId: 'task-6',
    modelSnapshot: { modelName: 'moonshotWebFree' },
    messages: [{ role: 'user', content: 'private prompt' }],
    maxOutputTokens: 1200,
  })

  assert.deepEqual(port.postedMessages.slice(0, 3), [
    {
      type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.sourceRefreshRequest,
      requestId: 'request-1',
      taskId: 'task-6',
      platform: owner.platform,
      videoId: owner.videoId,
      owner,
      expectedVideoId: owner.videoId,
      reason: 'DIRECT_DOWNLOAD_FAILED',
    },
    {
      type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
      requestId: 'request-2',
      gateway: 'mediakit',
      operation: 'queryTask',
      args: { taskId: 'task-6' },
    },
    {
      type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
      requestId: 'request-3',
      gateway: 'model',
      operation: 'generateText',
      args: {
        requestId: 'chunk-1',
        taskId: 'task-6',
        modelSnapshot: { modelName: 'moonshotWebFree' },
        messages: [{ role: 'user', content: 'private prompt' }],
        maxOutputTokens: 1200,
      },
    },
  ])

  port.emitMessage({
    type: 'SOURCE_REFRESH_RESULT',
    requestId: 'request-1',
    taskId: 'task-6',
    platform: owner.platform,
    videoId: owner.videoId,
    owner,
    sourceSnapshot: { videoId: owner.videoId, refreshed: true },
  })
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-2',
    ok: true,
    result: { status: 'completed' },
  })
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-3',
    ok: false,
    error: {
      code: 'MODEL_LOGIN_REQUIRED',
      operation: 'generateText',
      httpStatus: null,
      providerCode: null,
      retryAfterMs: null,
      condition: 'login-required',
      modelName: 'moonshotWebFree',
    },
  })

  assert.deepEqual(await refreshPromise, { videoId: owner.videoId, refreshed: true })
  assert.deepEqual(await queryPromise, { status: 'completed' })
  await assert.rejects(generationPromise, (error) => {
    assert.equal(error.message, 'MODEL_LOGIN_REQUIRED')
    assert.equal(error.code, 'MODEL_LOGIN_REQUIRED')
    assert.equal(error.operation, 'generateText')
    assert.equal(error.condition, 'login-required')
    assert.equal(error.modelName, 'moonshotWebFree')
    return true
  })
})

test('model capability RPC sends the model snapshot without an extra wrapper', async () => {
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const runtime = startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      async start() {},
      cancel() {},
      async retry() {},
    },
    logger: createLogger(),
    createRequestId: createRequestIdFactory(),
  })
  const modelSnapshot = { modelName: 'customModel', apiMode: null }

  const capabilityPromise = runtime.modelGateway.describeCapabilities(modelSnapshot)
  const request = port.postedMessages[0]
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: request.requestId,
    ok: true,
    result: { supported: true },
  })

  assert.deepEqual(request, {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-1',
    gateway: 'model',
    operation: 'describeCapabilities',
    args: modelSnapshot,
  })
  assert.deepEqual(await capabilityPromise, { supported: true })
})

test('disconnect rejects every pending source refresh and gateway RPC', async () => {
  const owner = createVideoSummaryOwner({
    tabId: 9,
    documentId: 'doc-9',
    platform: 'bilibili',
    videoId: 'BV9task',
  })
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  let startCommand = null
  const runtime = startVideoSummaryOffscreenRuntime({
    port,
    taskRunner: {
      async start(command) {
        startCommand = command
      },
      cancel() {},
      async retry() {},
    },
    logger: createLogger(),
    createRequestId: createRequestIdFactory(),
  })

  port.emitMessage({
    type: 'START_TASK',
    taskId: 'task-9',
    platform: owner.platform,
    videoId: owner.videoId,
    owner,
    sourceChoice: 'asr',
    sourceSnapshot: { videoId: owner.videoId },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { provider: 'openai' },
  })
  await Promise.resolve()

  const refreshPromise = startCommand.requestSourceRefresh({
    owner,
    taskId: 'task-9',
    expectedVideoId: owner.videoId,
    reason: 'SIGNED_URL_EXPIRED',
  })
  const gatewayPromise = runtime.mediaKitGateway.requestUploadTarget()

  port.emitDisconnect()

  await assert.rejects(refreshPromise, /VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED/)
  await assert.rejects(gatewayPromise, /VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED/)
})
