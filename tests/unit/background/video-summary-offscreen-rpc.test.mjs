import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
import { createFakePort } from '../helpers/port.mjs'

const owner = { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: 'abcdefghijk' }
const fence = { owner, taskId: 'task-1', generation: 1, attempt: 1 }

function createFixture({ executable = true, authorization } = {}) {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const lifecycle = []
  const completed = []
  const gatewayCalls = []
  const uploadedCalls = []
  const coordinator = {
    handleOffscreenMessage(message) {
      lifecycle.push(message)
      return true
    },
    authorizeGatewayRequest(request) {
      lifecycle.push({ type: 'AUTHORIZE', request })
      if (!executable) throw new Error('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
      return authorization?.(request) ?? { args: structuredClone(request.args), reservation: null }
    },
    completeGatewayRequest(value) {
      completed.push(value)
    },
    handleOffscreenDisconnect() {
      lifecycle.push({ type: 'DISCONNECTED' })
    },
  }
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async queryTask(args) {
        gatewayCalls.push(args)
        return { status: 'completed' }
      },
      async submitUploadedAsr(args) {
        uploadedCalls.push(args)
        return { taskId: 'provider-uploaded' }
      },
    },
    modelGateway: {},
    coordinator,
    logger: {},
  })
  rpc.attachPort(port)
  return { port, rpc, lifecycle, completed, gatewayCalls, uploadedCalls }
}

test('RPC parses lifecycle messages and forwards them to coordinator', () => {
  const fixture = createFixture()
  fixture.port.emitMessage({ type: 'ATTEMPT_ACCEPTED', requestId: 'start-1', fence })
  assert.deepEqual(fixture.lifecycle, [{ type: 'ATTEMPT_ACCEPTED', requestId: 'start-1', fence }])
})

test('gateway dispatch requires coordinator authorization and returns a fenced response', async () => {
  const fixture = createFixture()
  fixture.port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'gateway-1',
    fence,
    gateway: 'mediakit',
    operation: 'queryTask',
    args: { taskId: 'task-1' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fixture.port.postedMessages[0], {
    type: 'GATEWAY_RESPONSE',
    requestId: 'gateway-1',
    fence,
    ok: true,
    result: { status: 'completed' },
  })
  assert.deepEqual(fixture.gatewayCalls, [{ taskId: 'task-1' }])
  assert.deepEqual(fixture.completed, [
    {
      fence,
      requestId: 'gateway-1',
      gateway: 'mediakit',
      operation: 'queryTask',
      outcome: { ok: true, result: { status: 'completed' } },
    },
  ])

  const blocked = createFixture({ executable: false })
  blocked.port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'blocked',
    fence,
    gateway: 'mediakit',
    operation: 'queryTask',
    args: {},
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(blocked.gatewayCalls.length, 0)
  assert.equal(blocked.port.postedMessages[0].ok, false)
  assert.equal(blocked.port.postedMessages[0].error.code, 'VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
})

test('uploaded submission invokes its exact authorized gateway operation', async () => {
  const fixture = createFixture()
  fixture.port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'gateway-uploaded',
    fence,
    gateway: 'mediakit',
    operation: 'submitUploadedAsr',
    args: { audioUrl: 'mediakit://file-1' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fixture.uploadedCalls, [{ audioUrl: 'mediakit://file-1' }])
  assert.equal(fixture.port.postedMessages[0].ok, true)
})

test('authorization runs before dispatch and gateway receives only cloned authorized arguments', async () => {
  const authorizedArgs = { taskId: 'provider-task-1' }
  const fixture = createFixture({
    authorization() {
      return { args: authorizedArgs, reservation: null }
    },
  })
  fixture.port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'gateway-authorized',
    fence,
    gateway: 'mediakit',
    operation: 'queryTask',
    args: { taskId: 'substituted-task' },
  })
  authorizedArgs.taskId = 'provider-task-mutated-after-authorization'
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(fixture.gatewayCalls, [{ taskId: 'provider-task-1' }])
})

test('exact-fence cancellation aborts the matching request only', async () => {
  const signals = []
  const fixture = createFixture()
  fixture.rpc.detachPort()
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      queryTask(args, { signal }) {
        signals.push(signal)
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
    modelGateway: {},
    coordinator: {
      authorizeGatewayRequest: ({ args }) => ({ args, reservation: null }),
      completeGatewayRequest() {},
      handleOffscreenMessage() {},
      handleOffscreenDisconnect() {},
    },
    logger: {},
  })
  rpc.attachPort(port)
  port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'shared-request',
    fence,
    gateway: 'mediakit',
    operation: 'queryTask',
    args: { taskId: 'provider-task' },
  })
  await Promise.resolve()
  port.emitMessage({
    type: 'CANCEL_GATEWAY_REQUEST',
    requestId: 'shared-request',
    fence: { ...fence, attempt: 2 },
  })
  assert.equal(signals[0].aborted, false)
  port.emitMessage({ type: 'CANCEL_GATEWAY_REQUEST', requestId: 'shared-request', fence })
  assert.equal(signals[0].aborted, true)
})

test('cancellation reaches every gateway network boundary', async () => {
  const signals = new Map()
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const hold =
    (operation) =>
    (args, { signal }) => {
      signals.set(operation, signal)
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      submitDirectAsr: hold('submitDirectAsr'),
      requestUploadTarget: hold('requestUploadTarget'),
      submitUploadedAsr: hold('submitUploadedAsr'),
      queryTask: hold('queryTask'),
    },
    modelGateway: { generateText: hold('generateText') },
    coordinator: {
      authorizeGatewayRequest: ({ args }) => ({ args, reservation: null }),
      completeGatewayRequest() {},
      handleOffscreenMessage() {},
      handleOffscreenDisconnect() {},
    },
    logger: {},
  })
  rpc.attachPort(port)
  const operations = [
    ['mediakit', 'submitDirectAsr'],
    ['mediakit', 'requestUploadTarget'],
    ['mediakit', 'submitUploadedAsr'],
    ['mediakit', 'queryTask'],
    ['model', 'generateText'],
  ]
  for (const [gateway, operation] of operations) {
    port.emitMessage({
      type: 'GATEWAY_REQUEST',
      requestId: `request-${operation}`,
      fence,
      gateway,
      operation,
      args: {},
    })
  }
  await Promise.resolve()
  for (const [, operation] of operations) {
    port.emitMessage({
      type: 'CANCEL_GATEWAY_REQUEST',
      requestId: `request-${operation}`,
      fence,
    })
  }
  assert.deepEqual(
    [...signals.entries()].map(([operation, signal]) => [operation, signal.aborted]),
    operations.map(([, operation]) => [operation, true]),
  )
})

test('generation cancellation aborts all matching controllers', async () => {
  const signals = []
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {
      generateText(args, { signal }) {
        signals.push(signal)
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
    coordinator: {
      authorizeGatewayRequest: ({ args }) => ({ args, reservation: null }),
      completeGatewayRequest() {},
      handleOffscreenMessage() {},
      handleOffscreenDisconnect() {},
    },
    logger: {},
  })
  rpc.attachPort(port)
  for (const requestId of ['request-1', 'request-2']) {
    port.emitMessage({
      type: 'GATEWAY_REQUEST',
      requestId,
      fence,
      gateway: 'model',
      operation: 'generateText',
      args: {},
    })
  }
  await Promise.resolve()
  rpc.cancelGeneration(fence)
  assert.deepEqual(
    signals.map(({ aborted }) => aborted),
    [true, true],
  )
})

test('disconnect aborts all in-flight gateway controllers', async () => {
  const signals = []
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {
      generateText(args, { signal }) {
        signals.push(signal)
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
    coordinator: {
      authorizeGatewayRequest: ({ args }) => ({ args, reservation: null }),
      completeGatewayRequest() {},
      handleOffscreenMessage() {},
      handleOffscreenDisconnect() {},
    },
    logger: {},
  })
  rpc.attachPort(port)
  port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'request-disconnect',
    fence,
    gateway: 'model',
    operation: 'generateText',
    args: {},
  })
  await Promise.resolve()
  port.emitDisconnect()
  assert.equal(signals[0].aborted, true)
})

test('RPC error serialization omits sensitive and invalid diagnostic fields', async () => {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const error = Object.assign(new Error('SECRET_ERROR_MESSAGE'), {
    code: 'MODEL_GATEWAY_PROVIDER_ERROR',
    operation: 'SECRET_OPERATION',
    httpStatus: 503,
    providerCode: 'PROVIDER_FAILED',
    retryAfterMs: 2500,
    condition: 'temporary',
    modelName: 'safe-model-1',
    requestId: 'req_rpc-1',
    providerBody: 'SECRET_PROVIDER_BODY',
    prompt: 'SECRET_PROMPT',
    Authorization: 'SECRET_AUTHORIZATION',
    token: 'SECRET_TOKEN',
    nested: { transcript: 'SECRET_TRANSCRIPT' },
  })
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async queryTask() {
        throw error
      },
    },
    modelGateway: {},
    coordinator: {
      authorizeGatewayRequest: ({ args }) => ({ args, reservation: null }),
      completeGatewayRequest() {},
      handleOffscreenMessage() {},
      handleOffscreenDisconnect() {},
    },
    logger: {},
  })
  rpc.attachPort(port)
  port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'gateway-sensitive',
    fence,
    gateway: 'mediakit',
    operation: 'queryTask',
    args: { taskId: 'provider-task' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(port.postedMessages[0].error, {
    code: 'MODEL_GATEWAY_PROVIDER_ERROR',
    operation: 'queryTask',
    httpStatus: 503,
    providerCode: 'PROVIDER_FAILED',
    retryAfterMs: 2500,
    condition: 'temporary',
    modelName: 'safe-model-1',
  })
  const serialized = JSON.stringify(port.postedMessages[0].error)
  for (const sentinel of [
    'SECRET_ERROR_MESSAGE',
    'SECRET_OPERATION',
    'SECRET_PROVIDER_BODY',
    'SECRET_PROMPT',
    'SECRET_AUTHORIZATION',
    'SECRET_TOKEN',
    'SECRET_TRANSCRIPT',
    'req_rpc-1',
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel)
  }
})

test('outbound commands are parsed and disconnect resets coordinator state', () => {
  const fixture = createFixture()
  fixture.rpc.postCommand({ type: 'CANCEL_TASK', fence })
  assert.deepEqual(fixture.port.postedMessages, [{ type: 'CANCEL_TASK', fence }])
  fixture.port.emitDisconnect()
  assert.equal(fixture.lifecycle.at(-1).type, 'DISCONNECTED')
  assert.throws(() => fixture.rpc.postCommand({ type: 'CANCEL_TASK', fence }), /DISCONNECTED/)
})
