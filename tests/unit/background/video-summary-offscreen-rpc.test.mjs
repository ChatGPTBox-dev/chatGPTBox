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

test('outbound commands are parsed and disconnect resets coordinator state', () => {
  const fixture = createFixture()
  fixture.rpc.postCommand({ type: 'CANCEL_TASK', fence })
  assert.deepEqual(fixture.port.postedMessages, [{ type: 'CANCEL_TASK', fence }])
  fixture.port.emitDisconnect()
  assert.equal(fixture.lifecycle.at(-1).type, 'DISCONNECTED')
  assert.throws(() => fixture.rpc.postCommand({ type: 'CANCEL_TASK', fence }), /DISCONNECTED/)
})
