import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
import { createFakePort } from '../helpers/port.mjs'

const owner = { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: 'abcdefghijk' }
const fence = { owner, taskId: 'task-1', generation: 1, attempt: 1 }

function createFixture({ executable = true } = {}) {
  const port = createFakePort({ name: 'video-summary-offscreen' })
  const lifecycle = []
  const completed = []
  const coordinator = {
    handleOffscreenMessage(message) {
      lifecycle.push(message)
      return message.type !== 'GATEWAY_REQUEST' || executable
    },
    completeGatewayRequest(value, requestId) {
      completed.push([value, requestId])
    },
    handleOffscreenDisconnect() {
      lifecycle.push({ type: 'DISCONNECTED' })
    },
  }
  const rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async queryTask() {
        return { status: 'completed' }
      },
    },
    modelGateway: {},
    coordinator,
    logger: {},
  })
  rpc.attachPort(port)
  return { port, rpc, lifecycle, completed }
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
  assert.deepEqual(fixture.completed, [[fence, 'gateway-1']])

  const blocked = createFixture({ executable: false })
  blocked.port.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'blocked',
    fence,
    gateway: 'mediakit',
    operation: 'queryTask',
    args: {},
  })
  await Promise.resolve()
  assert.deepEqual(blocked.port.postedMessages, [])
})

test('outbound commands are parsed and disconnect resets coordinator state', () => {
  const fixture = createFixture()
  fixture.rpc.postCommand({ type: 'CANCEL_TASK', fence })
  assert.deepEqual(fixture.port.postedMessages, [{ type: 'CANCEL_TASK', fence }])
  fixture.port.emitDisconnect()
  assert.equal(fixture.lifecycle.at(-1).type, 'DISCONNECTED')
  assert.throws(() => fixture.rpc.postCommand({ type: 'CANCEL_TASK', fence }), /DISCONNECTED/)
})
