import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithClaudeApi } from '../../../../src/services/apis/claude-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('claude-api: sends correct URL and headers', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 512,
    temperature: 0.7,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Hello', session)

  assert.equal(capturedInput, 'https://api.anthropic.com/v1/messages')
  assert.equal(capturedInit.headers['x-api-key'], 'sk-ant-test')
  assert.equal(capturedInit.headers['anthropic-version'], '2023-06-01')
  assert.equal(capturedInit.headers['anthropic-dangerous-direct-browser-access'], true)
  assert.equal(capturedInit.headers['Content-Type'], 'application/json')
})

test('claude-api: sends model, max_tokens, temperature in body', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 1024,
    temperature: 0.9,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Q', session)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.model, 'claude-3-7-sonnet-20250219')
  assert.equal(body.max_tokens, 1024)
  assert.equal(body.temperature, 0.9)
  assert.equal(body.stream, true)
})

test('claude-api: delta.text streams accumulate and message_stop terminates', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA' }],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'CurrentQ', session)

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Hel'),
    true,
  )
  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Hello'),
    true,
  )
  assert.equal(
    port.postedMessages.some((m) => m.done === true && m.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { done: true })
})

test('claude-api: pushRecord on message_stop', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'MyQ', session)

  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'MyQ',
    answer: 'Answer',
  })
})

test('claude-api: cleans up listeners on end', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: throws on error response', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'bad-key',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid x-api-key' } }),
    }),
  )

  await assert.rejects(
    async () => generateAnswersWithClaudeApi(port, 'Q', session),
    /invalid x-api-key/,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: ignores unparseable JSON messages', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'claude37SonnetApi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: not-valid-json\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'OK'),
    true,
  )
})
