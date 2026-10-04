import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
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

test('gateway RPC enforces allowlists and serializes safe errors without leaking request payloads', async () => {
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const generationCalls = []
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async queryTask(args) {
        assert.equal(args.taskId, 'task-1')
        return { status: 'completed' }
      },
      async submitDirectAsr() {
        const error = Object.assign(new Error('https://signed.example.invalid/leak?token=secret'), {
          code: 'MEDIAKIT_RATE_LIMITED',
          operation: 'submitDirectAsr',
          httpStatus: 429,
          providerCode: 'RATE_LIMITED',
          retryAfterMs: 4_000,
        })
        throw error
      },
    },
    modelGateway: {
      describeCapabilities(snapshot) {
        return { supported: snapshot?.provider === 'openai' }
      },
      async generateText(args) {
        generationCalls.push(args)
        return {
          text: 'generated summary',
          finishReason: 'stop',
          rawProviderResponse: 'private provider payload',
        }
      },
    },
    logger: createLogger(),
    onTaskEvent() {},
    requestSourceRefresh() {},
  })

  rpc.attachPort(port)

  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-1',
    gateway: 'mediakit',
    operation: 'queryTask',
    args: { taskId: 'task-1', signedUrl: 'https://signed.example.invalid/leak?token=secret' },
  })
  await Promise.resolve()

  assert.deepEqual(port.postedMessages[0], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-1',
    ok: true,
    result: { status: 'completed' },
  })

  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-2',
    gateway: 'mediakit',
    operation: 'submitDirectAsr',
    args: {
      audioUrl: 'https://signed.example.invalid/leak?token=secret',
      prompt: 'keep this private',
    },
  })
  await Promise.resolve()

  assert.deepEqual(port.postedMessages[1], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-2',
    ok: false,
    error: {
      code: 'MEDIAKIT_RATE_LIMITED',
      operation: 'submitDirectAsr',
      httpStatus: 429,
      providerCode: 'RATE_LIMITED',
      retryAfterMs: 4_000,
    },
  })

  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-3',
    gateway: 'mediakit',
    operation: 'deleteKey',
    args: {},
  })
  await Promise.resolve()

  assert.deepEqual(port.postedMessages[2], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-3',
    ok: false,
    error: {
      code: 'VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED',
      operation: 'deleteKey',
      httpStatus: null,
      providerCode: null,
      retryAfterMs: null,
    },
  })

  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-4',
    gateway: 'model',
    operation: 'generate',
    args: { requestId: 'chunk-1', taskId: 'task-1' },
  })
  await Promise.resolve()

  assert.deepEqual(port.postedMessages[3], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-4',
    ok: false,
    error: {
      code: 'VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED',
      operation: 'generate',
      httpStatus: null,
      providerCode: null,
      retryAfterMs: null,
    },
  })

  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-5',
    gateway: 'model',
    operation: 'generateText',
    args: {
      requestId: 'chunk-3',
      taskId: 'task-1',
      modelSnapshot: { modelName: 'moonshotWebFree' },
      messages: [{ role: 'user', content: 'private prompt' }],
      maxOutputTokens: 1200,
    },
  })
  await Promise.resolve()

  assert.deepEqual(generationCalls, [
    {
      requestId: 'chunk-3',
      taskId: 'task-1',
      modelSnapshot: { modelName: 'moonshotWebFree' },
      messages: [{ role: 'user', content: 'private prompt' }],
      maxOutputTokens: 1200,
    },
  ])
  assert.deepEqual(port.postedMessages[4], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-5',
    ok: true,
    result: { text: 'generated summary', finishReason: 'stop' },
  })
})

test('model generation RPC serializes only safe actionable error metadata', async () => {
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {
      async generateText() {
        const error = Object.assign(new Error('raw provider response with private prompt'), {
          code: 'MODEL_LOGIN_REQUIRED',
          operation: 'rawOperationShouldNotLeak',
          httpStatus: Number.NaN,
          providerCode: { raw: 'response' },
          retryAfterMs: Number.NaN,
          condition: 'login-required',
          modelName: 'moonshotWebFree',
          responseText: 'raw provider response body',
          messages: [{ role: 'user', content: 'private prompt' }],
        })
        throw error
      },
    },
    logger: createLogger(),
    onTaskEvent() {},
    requestSourceRefresh() {},
  })

  rpc.attachPort(port)
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-login',
    gateway: 'model',
    operation: 'generateText',
    args: {
      requestId: 'chunk-1',
      taskId: 'task-1',
      modelSnapshot: { modelName: 'moonshotWebFree' },
      messages: [{ role: 'user', content: 'private prompt' }],
      maxOutputTokens: 1200,
    },
  })
  await Promise.resolve()

  assert.deepEqual(port.postedMessages[0], {
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
    requestId: 'request-login',
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
})

test('model generation RPC replaces unsafe condition and model name metadata with nulls', async () => {
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {
      async generateText() {
        throw Object.assign(new Error('unsafe provider failure'), {
          code: 'MODEL_TEMPORARY_FAILURE',
          condition: 'private prompt leaked here',
          modelName: 'moonshotWebFree private prompt',
        })
      },
    },
    logger: createLogger(),
    onTaskEvent() {},
    requestSourceRefresh() {},
  })

  rpc.attachPort(port)
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
    requestId: 'request-unsafe',
    gateway: 'model',
    operation: 'generateText',
    args: { requestId: 'chunk-unsafe', taskId: 'task-1' },
  })
  await Promise.resolve()

  assert.deepEqual(port.postedMessages[0].error, {
    code: 'MODEL_TEMPORARY_FAILURE',
    operation: 'generateText',
    httpStatus: null,
    providerCode: null,
    retryAfterMs: null,
    condition: null,
    modelName: null,
  })
})

test('task events and source refresh requests cross the offscreen port with correlated responses', async () => {
  const owner = createVideoSummaryOwner({ tabId: 7, documentId: 'doc-7', videoId: 'BV7test' })
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const taskEvents = []
  const refreshCalls = []
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {},
    logger: createLogger(),
    onTaskEvent(event) {
      taskEvents.push(event)
    },
    requestSourceRefresh(request) {
      refreshCalls.push(request)
    },
  })

  rpc.attachPort(port)
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.taskEvent,
    event: {
      type: 'TASK_STATUS',
      taskId: 'task-7',
      owner,
      stage: 'transcribing',
    },
  })
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.sourceRefreshRequest,
    requestId: 'refresh-1',
    taskId: 'task-7',
    owner,
    expectedVideoId: owner.videoId,
    reason: 'DIRECT_DOWNLOAD_FAILED',
  })

  assert.deepEqual(taskEvents, [
    {
      type: 'TASK_STATUS',
      taskId: 'task-7',
      owner,
      stage: 'transcribing',
    },
  ])
  assert.deepEqual(refreshCalls, [
    {
      requestId: 'refresh-1',
      taskId: 'task-7',
      owner,
      expectedVideoId: owner.videoId,
      reason: 'DIRECT_DOWNLOAD_FAILED',
    },
  ])

  rpc.postCommand({
    type: 'SOURCE_REFRESH_RESULT',
    taskId: 'task-7',
    owner,
    sourceSnapshot: { videoId: owner.videoId },
  })

  assert.deepEqual(port.postedMessages.at(-1), {
    type: 'SOURCE_REFRESH_RESULT',
    requestId: 'refresh-1',
    taskId: 'task-7',
    owner,
    sourceSnapshot: { videoId: owner.videoId },
  })
})

test('disconnect removes listeners and forgets pending source refresh correlations', async () => {
  const owner = createVideoSummaryOwner({ tabId: 8, documentId: 'doc-8', videoId: 'BV8test' })
  const port = createFakePort({ name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {},
    logger: createLogger(),
    onTaskEvent() {},
    requestSourceRefresh() {},
  })

  rpc.attachPort(port)
  port.emitMessage({
    type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.sourceRefreshRequest,
    requestId: 'refresh-8',
    taskId: 'task-8',
    owner,
    expectedVideoId: owner.videoId,
    reason: 'SIGNED_URL_EXPIRED',
  })
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })

  port.emitDisconnect()

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  rpc.postCommand({
    type: 'SOURCE_REFRESH_RESULT',
    taskId: 'task-8',
    owner,
    sourceSnapshot: { videoId: owner.videoId },
  })
  assert.deepEqual(port.postedMessages, [])
})
