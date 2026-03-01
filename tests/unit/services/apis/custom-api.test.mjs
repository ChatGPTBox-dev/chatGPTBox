import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithCustomApi } from '../../../../src/services/apis/custom-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('aggregates delta.content SSE chunks and finishes on finish_reason', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'customModel',
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
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithCustomApi(
    port,
    'CurrentQ',
    session,
    'https://custom.api/v1/chat',
    'key-123',
    'custom-model',
  )

  assert.equal(capturedInput, 'https://custom.api/v1/chat')
  assert.equal(capturedInit.method, 'POST')
  assert.equal(capturedInit.headers.Authorization, 'Bearer key-123')

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.stream, true)
  assert.equal(body.model, 'custom-model')
  assert.equal(body.temperature, 0.5)
  assert.equal(Array.isArray(body.messages), true)
  assert.deepEqual(body.messages[0], { role: 'user', content: 'PrevQ' })
  assert.deepEqual(body.messages[1], { role: 'assistant', content: 'PrevA' })
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'CurrentQ' })

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
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'CurrentQ',
    answer: 'Hello',
  })
})

test('handles message.content response schema', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.3,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"message":{"content":"Full answer"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Full answer'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'Q',
    answer: 'Full answer',
  })
})

test('ignores null message.content to avoid null-prefixed answers', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.3,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"message":{"content":null}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  const partialAnswers = port.postedMessages.filter((m) => m.done === false).map((m) => m.answer)
  assert.equal(partialAnswers.some((a) => a === null), false)
  assert.equal(
    partialAnswers.some((a) => typeof a === 'string' && a.startsWith('null')),
    false,
  )
  assert.equal(partialAnswers.at(-1), 'Hi')
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'Q', answer: 'Hi' })
})

test('handles choices[].text response schema', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.2,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"text":"A"}]}\n\n',
      'data: {"choices":[{"text":"B","finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'AB'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'Q', answer: 'AB' })
})

test('handles {response} field (direct response)', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"response":"Partial"}\n\n',
      'data: {"response":"Complete answer"}\n\n',
      'data: [DONE]\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Partial'),
    true,
  )
  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Complete answer'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'Q',
    answer: 'Complete answer',
  })
})

test('handles [DONE] marker to finish stream', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Done test"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(
    port.postedMessages.some((m) => m.done === true && m.session === session),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'Q',
    answer: 'Done test',
  })
})

test('skips unparseable JSON messages gracefully', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: not-valid-json\n\n',
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'OK'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'Q', answer: 'OK' })
})

test('handles metadata-only SSE chunk without choices or response fields', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"id":"chatcmpl-xxx","model":"gpt-4"}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Hi'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'Q', answer: 'Hi' })
})

test('throws on non-ok response with JSON error body', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
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

  await assert.rejects(
    () =>
      generateAnswersWithCustomApi(
        port,
        'Q',
        session,
        'https://custom.api/v1/chat',
        'bad-key',
        'model',
      ),
    /invalid api key/,
  )

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('throws on network error', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch')
  })

  await assert.rejects(
    () =>
      generateAnswersWithCustomApi(
        port,
        'Q',
        session,
        'https://custom.api/v1/chat',
        'key',
        'model',
      ),
    /Failed to fetch/,
  )

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('falls back to status text when JSON error parsing fails', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    }),
  )

  await assert.rejects(
    () =>
      generateAnswersWithCustomApi(
        port,
        'Q',
        session,
        'https://custom.api/v1/chat',
        'key',
        'model',
      ),
    /502 Bad Gateway/,
  )

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('includes conversation history from prior records', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
      { question: 'Q3', answer: 'A3' },
    ],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithCustomApi(
    port,
    'Q4',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  const body = JSON.parse(capturedInit.body)
  // maxConversationContextLength=2 so only last 2 records are included + current question
  assert.deepEqual(body.messages[0], { role: 'user', content: 'Q2' })
  assert.deepEqual(body.messages[1], { role: 'assistant', content: 'A2' })
  assert.deepEqual(body.messages[2], { role: 'user', content: 'Q3' })
  assert.deepEqual(body.messages[3], { role: 'assistant', content: 'A3' })
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'Q4' })
})

test('retry mode overwrites last conversation record', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 5,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [{ question: 'Q1', answer: 'old answer' }],
    isRetry: true,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"new answer"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q1',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  assert.equal(session.conversationRecords.length, 1)
  assert.deepEqual(session.conversationRecords[0], { question: 'Q1', answer: 'new answer' })
})

test('delta.content with empty string is appended (no skip)', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithCustomApi(
    port,
    'Q',
    session,
    'https://custom.api/v1/chat',
    'key',
    'model',
  )

  // After empty delta, answer should still be "A" (empty appended, not skipped)
  const streaming = port.postedMessages.filter((m) => m.done === false)
  assert.equal(streaming[0].answer, 'A')
  assert.equal(streaming[1].answer, 'A') // "A" + "" = "A"
  assert.equal(streaming[2].answer, 'AB')
})
