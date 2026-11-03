import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { register } from 'node:module'
import { getUserConfig } from '../../../../src/config/index.mjs'

register(new URL('../../../setup/chatgpt-web-loader-hooks.mjs', import.meta.url))
const {
  getModels,
  getRequirements,
  isNeedWebsocket,
  sendWebsocketConversation,
  stopWebsocketConversation,
  deleteConversation,
} = await import('../../../../src/services/apis/chatgpt-web.mjs')

const shim = globalThis.__TEST_BROWSER_SHIM__

beforeEach(async () => {
  shim.flushStorageEvents()
  shim.replaceStorage({ customChatGptWebApiUrl: 'https://old.example' })
  for (let attempt = 0; attempt < 3; attempt++) await getUserConfig()
})

test('ChatGPT Web requests observe endpoint changes before their storage event', async (t) => {
  shim.deferStorageEvents()
  t.after(() => shim.flushStorageEvents())
  shim.setStorage({ customChatGptWebApiUrl: 'https://new.example' })
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({
    text: async () => JSON.stringify({ models: [{ slug: 'TEST_MODEL' }] }),
  }))
  t.mock.method(console, 'debug', () => {})

  assert.deepEqual(await getModels('TEST_TOKEN'), ['TEST_MODEL'])
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://new.example/backend-api/models')
})

test('websocket requests observe endpoint updates before storage events', async (t) => {
  shim.deferStorageEvents()
  t.after(() => shim.flushStorageEvents())
  shim.setStorage({ customChatGptWebApiUrl: 'https://new.example' })
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({
    json: async () => ({
      conversation_id: 'TEST_CONVERSATION',
      websocket_request_id: 'TEST_REQUEST',
    }),
  }))
  t.mock.method(console, 'debug', () => {})

  const result = await sendWebsocketConversation('TEST_TOKEN', { method: 'POST' })

  assert.equal(fetch.mock.calls[0].arguments[0], 'https://new.example/backend-api/conversation')
  assert.equal(result.conversationId, 'TEST_CONVERSATION')
  assert.equal(result.wsRequestId, 'TEST_REQUEST')
})

test('conversation cleanup keeps the generation endpoint after settings change', async (t) => {
  const snapshot = await getUserConfig({ fresh: true })
  shim.setStorage({ customChatGptWebApiUrl: 'https://new.example' })
  const reads = t.mock.method(globalThis.chrome.storage.local, 'get')
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ text: async () => '{}' }))
  t.mock.method(console, 'debug', () => {})

  await stopWebsocketConversation('TEST_TOKEN', 'TEST_CONVERSATION', 'TEST_REQUEST', snapshot)
  await deleteConversation('TEST_TOKEN', 'TEST_CONVERSATION', snapshot)

  assert.equal(reads.mock.callCount(), 0)
  assert.deepEqual(
    fetch.mock.calls.map((call) => call.arguments[0]),
    [
      'https://old.example/backend-api/stop_conversation',
      'https://old.example/backend-api/conversation/TEST_CONVERSATION',
    ],
  )
})

test('ChatGPT Web subrequests reuse config without storage reads', async (t) => {
  const reads = t.mock.method(globalThis.chrome.storage.local, 'get')
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({
    text: async () => JSON.stringify({ models: [{ slug: 'TEST_MODEL' }], shared_websocket: true }),
  }))
  t.mock.method(console, 'debug', () => {})
  const snapshot = { customChatGptWebApiUrl: 'https://snapshot.example' }

  await Promise.all([
    getModels('TEST_TOKEN', snapshot),
    getRequirements('TEST_TOKEN', snapshot),
    isNeedWebsocket('TEST_TOKEN', snapshot),
  ])

  assert.equal(reads.mock.callCount(), 0)
  assert.equal(fetch.mock.callCount(), 3)
  assert.ok(
    fetch.mock.calls.every((call) => call.arguments[0].startsWith('https://snapshot.example/')),
  )
})

test('websocket conversation requests reuse a supplied config snapshot', async (t) => {
  const reads = t.mock.method(globalThis.chrome.storage.local, 'get')
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({
    json: async () => ({
      conversation_id: 'TEST_CONVERSATION',
      websocket_request_id: 'TEST_REQUEST',
    }),
  }))
  t.mock.method(console, 'debug', () => {})

  await sendWebsocketConversation(
    'TEST_TOKEN',
    { method: 'POST' },
    {
      customChatGptWebApiUrl: 'https://snapshot.example',
    },
  )

  assert.equal(reads.mock.callCount(), 0)
  assert.equal(
    fetch.mock.calls[0].arguments[0],
    'https://snapshot.example/backend-api/conversation',
  )
})
