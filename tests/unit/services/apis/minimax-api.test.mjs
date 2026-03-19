import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithMiniMaxApi } from '../../../../src/services/apis/minimax-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('generateAnswersWithMiniMaxApi sends request to MiniMax base URL', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.7,
  })

  const session = {
    modelName: 'minimax_m27',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA' }],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithMiniMaxApi(port, 'Hello', session, 'sk-minimax-test')

  assert.equal(capturedInput, 'https://api.minimax.io/v1/chat/completions')
  assert.equal(capturedInit.method, 'POST')
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-minimax-test')

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 256)
  assert.equal(body.temperature, 0.7)
  assert.equal(Array.isArray(body.messages), true)
  assert.deepEqual(body.messages[0], { role: 'user', content: 'PrevQ' })
  assert.deepEqual(body.messages[1], { role: 'assistant', content: 'PrevA' })
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'Hello' })
})

test('generateAnswersWithMiniMaxApi aggregates SSE deltas and posts messages', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.5,
  })

  const session = {
    modelName: 'minimax_m25',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithMiniMaxApi(port, 'Test', session, 'sk-test')

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
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'Test',
    answer: 'Hello',
  })
})

test('generateAnswersWithMiniMaxApi throws on non-ok response', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.5,
  })

  const session = {
    modelName: 'minimax_m25_highspeed',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid api key' } }),
    }),
  )

  await assert.rejects(async () => {
    await generateAnswersWithMiniMaxApi(port, 'Test', session, 'sk-bad')
  }, /invalid api key/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithMiniMaxApi supports message.content fallback', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'minimax_m27',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"message":{"content":"Full response"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithMiniMaxApi(port, 'Question', session, 'sk-test')

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Full response'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'Question',
    answer: 'Full response',
  })
})

test('generateAnswersWithMiniMaxApi throws on network error', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.5,
  })

  const session = {
    modelName: 'minimax_m27',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch')
  })

  await assert.rejects(async () => {
    await generateAnswersWithMiniMaxApi(port, 'Test', session, 'sk-test')
  }, /Failed to fetch/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
