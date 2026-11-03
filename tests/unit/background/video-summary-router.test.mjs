import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryRouter } from '../../../src/background/video-summary-router.mjs'
import { createFakePort } from '../helpers/port.mjs'

const pageIdentity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
const runtime = { id: 'extension-id' }
const sender = {
  id: 'extension-id',
  tab: { id: 7 },
  documentId: 'doc-7',
  frameId: 0,
  url: 'https://www.youtube.com/watch?v=abcdefghijk',
}
const command = {
  type: 'ATTACH_TASK',
  requestId: 'attach-1',
  taskId: 'task-1',
  generation: 1,
  pageIdentity,
}

test('router authenticates first parsed command and binds immutable browser context', async () => {
  const calls = []
  const coordinator = {
    handleContentCommand(value) {
      calls.push(value)
    },
    handleContentDisconnect() {},
    handleTabRemoved() {},
  }
  const router = createVideoSummaryRouter({ runtime, coordinator, logger: {} })
  const port = createFakePort({ name: 'video-summary', sender })
  assert.equal(router.handleConnect(port), true)
  port.emitMessage(command)
  await Promise.resolve()
  assert.deepEqual(calls[0].context, {
    tabId: 7,
    documentId: 'doc-7',
    frameId: 0,
    pageIdentity,
    owner: { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: 'abcdefghijk' },
  })
  assert.deepEqual(calls[0].command, command)
})

test('invalid senders disconnect before lifecycle or Offscreen work', async () => {
  let calls = 0
  const router = createVideoSummaryRouter({
    runtime,
    coordinator: {
      handleContentCommand() {
        calls += 1
      },
      handleContentDisconnect() {},
      handleTabRemoved() {},
    },
    logger: {},
  })
  for (const invalidSender of [
    { ...sender, id: 'other' },
    { ...sender, frameId: 1 },
    { ...sender, url: 'https://evil.example/' },
  ]) {
    const port = createFakePort({ name: 'video-summary', sender: invalidSender })
    router.handleConnect(port)
    port.emitMessage(command)
    assert.equal(port.disconnectCount(), 1)
  }
  await Promise.resolve()
  assert.equal(calls, 0)
})

test('disconnect and tab removal delegate to coordinator', async () => {
  const calls = []
  const router = createVideoSummaryRouter({
    runtime,
    coordinator: {
      handleContentCommand() {},
      handleContentDisconnect(value) {
        calls.push(['disconnect', value.context.owner])
      },
      handleTabRemoved(tabId) {
        calls.push(['tab', tabId])
      },
    },
    logger: {},
  })
  const port = createFakePort({ name: 'video-summary', sender })
  router.handleConnect(port)
  port.emitMessage(command)
  await Promise.resolve()
  port.emitDisconnect()
  router.handleTabRemoved(7)
  assert.deepEqual(calls, [
    ['disconnect', { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: 'abcdefghijk' }],
    ['tab', 7],
  ])
})
