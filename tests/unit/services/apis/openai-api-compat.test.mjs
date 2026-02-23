import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  generateAnswersWithChatgptApiCompat,
  generateAnswersWithGptCompletionApi,
} from '../../../../src/services/apis/openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('generateAnswersWithChatgptApiCompat sends expected request and aggregates SSE deltas', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
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

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(capturedInput, 'https://api.example.com/v1/chat/completions')
  assert.equal(capturedInit.method, 'POST')
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-test')

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 256)
  assert.equal(body.temperature, 0.25)
  assert.equal(Array.isArray(body.messages), true)
  assert.equal(body.messages.length >= 3, true)
  assert.deepEqual(body.messages[0], { role: 'user', content: 'PrevQ' })
  assert.deepEqual(body.messages[1], { role: 'assistant', content: 'PrevA' })
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'CurrentQ' })

  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'Hel'),
    true,
  )
  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'Hello'),
    true,
  )
  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { done: true })
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hello' })
})

test('generateAnswersWithChatgptApiCompat uses max_completion_tokens for OpenAI gpt-5 models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 321,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi-gpt-5.1-chat-latest',
    conversationRecords: [],
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

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
    {},
    'openai',
  )

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_completion_tokens, 321)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('generateAnswersWithChatgptApiCompat removes conflicting token key from extraBody', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 222,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
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

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
    {
      max_completion_tokens: 999,
      top_p: 0.9,
    },
  )

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_tokens, 222)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
  assert.equal(body.top_p, 0.9)
})

test('generateAnswersWithChatgptApiCompat removes max_tokens from extraBody for OpenAI gpt-5 models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 500,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi-gpt-5.1-chat-latest',
    conversationRecords: [],
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

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
    {
      max_tokens: 999,
      top_p: 0.8,
    },
    'openai',
  )

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_completion_tokens, 500)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
  assert.equal(body.top_p, 0.8)
})

test('generateAnswersWithChatgptApiCompat allows max_tokens override for compat provider', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 400,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
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

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
    {
      max_tokens: 333,
      top_p: 0.75,
    },
  )

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_tokens, 333)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
  assert.equal(body.top_p, 0.75)
})

test('generateAnswersWithChatgptApiCompat allows max_completion_tokens override for OpenAI gpt-5 models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 400,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi-gpt-5.1-chat-latest',
    conversationRecords: [],
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

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
    {
      max_completion_tokens: 333,
      top_p: 0.65,
    },
    'openai',
  )

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_completion_tokens, 333)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
  assert.equal(body.top_p, 0.65)
})

test('generateAnswersWithChatgptApiCompat throws on non-ok response with JSON error body', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid key' } }),
    }),
  )

  await assert.rejects(async () => {
    await generateAnswersWithChatgptApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-invalid',
    )
  }, /invalid key/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithChatgptApiCompat throws on network error', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch')
  })

  await assert.rejects(async () => {
    await generateAnswersWithChatgptApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-invalid',
    )
  }, /Failed to fetch/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithChatgptApiCompat falls back to status text when JSON error parsing fails', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
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
        throw new SyntaxError('Unexpected token <')
      },
    }),
  )

  await assert.rejects(async () => {
    await generateAnswersWithChatgptApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-invalid',
    )
  }, /502 Bad Gateway/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithChatgptApiCompat supports message.content fallback', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 256,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA' }],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"message":{"content":"Final content"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithChatgptApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some(
      (message) => message.done === false && message.answer === 'Final content',
    ),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'CurrentQ',
    answer: 'Final content',
  })
})

test('generateAnswersWithGptCompletionApi builds completion prompt and appends answer', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://api.example.com',
    maxConversationContextLength: 5,
    maxResponseTokenLength: 300,
    temperature: 0.5,
  })

  const session = {
    modelName: 'gptApiInstruct',
    conversationRecords: [{ question: 'FirstQ', answer: 'FirstA' }],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"text":"A"}]}\n\n',
      'data: {"choices":[{"text":"B","finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithGptCompletionApi(port, 'NowQ', session, 'sk-completion')

  assert.equal(capturedInput, 'https://api.example.com/v1/completions')
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-completion')

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 300)
  assert.equal(body.temperature, 0.5)
  assert.equal(body.stop, '\nHuman')
  assert.equal(body.prompt.includes('Human: FirstQ\nAI: FirstA\n'), true)
  assert.equal(body.prompt.includes('Human: NowQ\nAI: '), true)

  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'AB'),
    true,
  )
  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'NowQ', answer: 'AB' })
})
