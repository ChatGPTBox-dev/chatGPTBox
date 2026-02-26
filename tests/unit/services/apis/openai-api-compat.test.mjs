import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  generateAnswersWithOpenAiApi,
  generateAnswersWithOpenAiApiCompat,
  generateAnswersWithGptCompletionApi,
  generateAnswersWithOpenAICompatibleApi,
} from '../../../../src/services/apis/openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const latestCompatModelNames = [
  'chatgptApi-chat-latest',
  'chatgptApi-gpt-5-chat-latest',
  'chatgptApi-gpt-5.1-chat-latest',
  'chatgptApi-gpt-5.2-chat-latest',
  'chatgptApi-gpt-5.3-chat-latest',
]
const latestMappedModels = [
  ['chatgptApiChatLatest', 'chat-latest'],
  ['chatgptApi5Latest', 'gpt-5-chat-latest'],
  ['chatgptApi5_1Latest', 'gpt-5.1-chat-latest'],
  ['chatgptApi5_2Latest', 'gpt-5.2-chat-latest'],
  ['chatgptApi5_3Latest', 'gpt-5.3-chat-latest'],
]

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('generateAnswersWithOpenAiApiCompat sends expected request and aggregates SSE deltas', async (t) => {
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

  await generateAnswersWithOpenAiApiCompat(
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
  assert.deepEqual(port.postedMessages.at(-1), { answer: null, done: true, session })
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hello' })
})

test('generateAnswersWithOpenAiApiCompat emits fallback done message when stream ends without finish reason', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse(['data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n']),
  )

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'Partial'),
    true,
  )
  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { answer: null, done: true, session })
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'CurrentQ',
    answer: 'Partial',
  })
})

test('generateAnswersWithOpenAiApiCompat records an empty answer when stream ends before first chunk', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse([]))

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { answer: null, done: true, session })
  assert.deepEqual(session.conversationRecords, [{ question: 'CurrentQ', answer: '' }])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithOpenAiApiCompat records an empty answer when stream only sends [DONE]', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(['data: [DONE]\n\n']))

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { answer: null, done: true, session })
  assert.deepEqual(session.conversationRecords, [{ question: 'CurrentQ', answer: '' }])
})

test('generateAnswersWithOpenAiApiCompat records an empty answer when finish_reason arrives without content', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']),
  )

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { answer: null, done: true, session })
  assert.deepEqual(session.conversationRecords, [{ question: 'CurrentQ', answer: '' }])
})

test('generateAnswersWithOpenAiApiCompat ignores null deltas without coercing them into the answer', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":null}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'Helnull'),
    false,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hello' })
})

test('generateAnswersWithOpenAiApiCompat ignores non-string message content', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"message":{"content":[{"type":"text","text":"bad"}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.equal(
    port.postedMessages.some((message) => message.done === false && Array.isArray(message.answer)),
    false,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hello' })
})

test('generateAnswersWithOpenAiApiCompat treats missing conversationRecords as an empty history', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.25,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: null,
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  const body = JSON.parse(capturedInit.body)
  assert.deepEqual(body.messages, [{ role: 'user', content: 'CurrentQ' }])
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hello' })
})

test('generateAnswersWithOpenAiApiCompat uses max_completion_tokens for OpenAI latest compat models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 321,
    temperature: 0.2,
  })
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  for (const modelName of latestCompatModelNames) {
    capturedInit = undefined
    const session = {
      modelName,
      conversationRecords: [],
      isRetry: false,
    }
    const port = createFakePort()

    await generateAnswersWithOpenAiApiCompat(
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
  }
})

test('generateAnswersWithOpenAiApiCompat uses latest mapped API model values', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 111,
    temperature: 0.2,
  })
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  for (const [modelName, expectedModel] of latestMappedModels) {
    capturedInit = undefined
    const session = {
      modelName,
      conversationRecords: [],
      isRetry: false,
    }
    const port = createFakePort()

    await generateAnswersWithOpenAiApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-test',
      {},
      'openai',
    )

    const body = JSON.parse(capturedInit.body)
    assert.equal(body.model, expectedModel)
    assert.equal(body.max_completion_tokens, 111)
    assert.equal(Object.hasOwn(body, 'max_tokens'), false)
  }
})

test('generateAnswersWithOpenAiApi uses OpenAI token params for a latest mapped gpt-5 model', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://api.openai.example.com',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 222,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi5_2Latest',
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
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAiApi(port, 'CurrentQ', session, 'sk-test')

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://api.openai.example.com/v1/chat/completions')
  assert.equal(body.model, 'gpt-5.2-chat-latest')
  assert.equal(body.max_completion_tokens, 222)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('generateAnswersWithOpenAiApi uses max_completion_tokens for GPT-5.4 mini', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://api.openai.example.com',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 444,
    temperature: 0.3,
  })

  const session = {
    modelName: 'chatgptApi5_4Mini',
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
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAiApi(port, 'CurrentQ', session, 'sk-test')

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://api.openai.example.com/v1/chat/completions')
  assert.equal(body.model, 'gpt-5.4-mini')
  assert.equal(body.max_completion_tokens, 444)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('generateAnswersWithOpenAiApi uses max_completion_tokens for GPT-5.4 nano', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://api.openai.example.com',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 555,
    temperature: 0.3,
  })

  const session = {
    modelName: 'chatgptApi5_4Nano',
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
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAiApi(port, 'CurrentQ', session, 'sk-test')

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://api.openai.example.com/v1/chat/completions')
  assert.equal(body.model, 'gpt-5.4-nano')
  assert.equal(body.max_completion_tokens, 555)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi keeps OpenAI GPT-5 token params for materialized OpenAI providers even when built-in OpenAI URL points to a proxy', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://proxy.example.com/v1',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 666,
    temperature: 0.3,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-openai',
        name: 'Selected Mode (OpenAI)',
        baseUrl: 'https://api.openai.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        sourceProviderId: 'openai',
        enabled: true,
      },
    ],
    providerSecrets: {
      'selected-mode-openai': 'proxy-key',
    },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-openai',
      customName: 'gpt-5.4-mini',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://api.openai.com/v1/chat/completions')
  assert.equal(body.model, 'gpt-5.4-mini')
  assert.equal(body.max_completion_tokens, 666)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi uses caller config snapshot for request body settings', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 1,
    maxResponseTokenLength: 111,
    temperature: 0.1,
  })

  const config = {
    maxConversationContextLength: 2,
    maxResponseTokenLength: 777,
    temperature: 0.7,
    customOpenAIProviders: [
      {
        id: 'snapshot-provider',
        name: 'Snapshot Provider',
        baseUrl: 'https://snapshot.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'snapshot-provider': 'snapshot-key',
    },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [
      { question: 'PrevQ1', answer: 'PrevA1' },
      { question: 'PrevQ2', answer: 'PrevA2' },
      { question: 'PrevQ3', answer: 'PrevA3' },
    ],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'snapshot-provider',
      customName: 'snapshot-model',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.model, 'snapshot-model')
  assert.equal(body.max_tokens, 777)
  assert.equal(body.temperature, 0.7)
  assert.deepEqual(
    body.messages.map((message) => message.content),
    ['PrevQ2', 'PrevA2', 'PrevQ3', 'PrevA3', 'CurrentQ'],
  )
})

test('generateAnswersWithOpenAICompatibleApi keeps generic compat token params for repointed OpenAI-lineage providers', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 666,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-openai-proxy',
        name: 'Selected Mode (OpenAI Proxy)',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        sourceProviderId: 'openai',
        enabled: true,
      },
    ],
    providerSecrets: {
      'selected-mode-openai-proxy': 'proxy-key',
    },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-openai-proxy',
      customName: 'gpt-5.4-mini',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(body.model, 'gpt-5.4-mini')
  assert.equal(body.max_tokens, 666)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi keeps generic compat token params for custom providers without source lineage', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 444,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-compat',
        name: 'Selected Mode (Compat)',
        baseUrl: 'https://compat.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'selected-mode-compat': 'compat-key',
    },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-compat',
      customName: 'gpt-5.4-mini',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_tokens, 444)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi rejects native Ollama chat endpoints', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama',
        name: 'Selected Mode (Ollama)',
        baseUrl: 'http://127.0.0.1:11434',
        chatCompletionsPath: '/api/chat',
        completionsPath: '/completions',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const calls = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls.push([input, init])
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await assert.rejects(
    generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config),
    /Unsupported native Ollama chat endpoint/,
  )

  assert.equal(calls.length, 0)
})

test('generateAnswersWithOpenAICompatibleApi keeps Ollama keep_alive for materialized Ollama providers with standard compat chat path', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-compat',
        name: 'Selected Mode (Ollama Compat)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-compat',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('http://127.0.0.1:11434/v1/chat/completions'), true)
  assert.equal(requestedUrls.includes('http://127.0.0.1:11434/api/generate'), true)
})

test('generateAnswersWithOpenAICompatibleApi keeps Ollama keep_alive for edited standard compat endpoint', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-edited-ollama',
        name: 'Selected Mode (Edited Ollama)',
        baseUrl: '',
        chatCompletionsUrl: 'http://edited-ollama:11434/v1/chat/completions',
        completionsUrl: 'http://edited-ollama:11434/v1/completions',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-edited-ollama',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('http://edited-ollama:11434/v1/chat/completions'), true)
  assert.equal(requestedUrls.includes('http://edited-ollama:11434/api/generate'), true)
})

test('generateAnswersWithOpenAICompatibleApi routes materialized Ollama keep_alive to request host for non-standard messages path', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-remote',
        name: 'Selected Mode (Ollama Remote)',
        baseUrl: 'http://remote-ollama:11434/v1',
        chatCompletionsPath: '/messages',
        completionsPath: '/completions',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-remote',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('http://remote-ollama:11434/v1/messages'), true)
  assert.equal(requestedUrls.includes('http://remote-ollama:11434/api/generate'), true)
  assert.equal(requestedUrls.includes('http://127.0.0.1:11434/api/generate'), false)
})

test('generateAnswersWithOpenAICompatibleApi prefers resolved request url for non-standard Ollama keep_alive', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-direct',
        name: 'Selected Mode (Ollama Direct)',
        baseUrl: 'http://base-ollama:11434',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        chatCompletionsUrl: 'http://direct-ollama:11434/custom/v1/messages',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-direct',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('http://direct-ollama:11434/custom/v1/messages'), true)
  assert.equal(requestedUrls.includes('http://direct-ollama:11434/custom/api/generate'), true)
  assert.equal(requestedUrls.includes('http://base-ollama:11434/api/generate'), false)
})

test('generateAnswersWithOpenAICompatibleApi strips query string before non-standard Ollama keep_alive routing', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-query',
        name: 'Selected Mode (Ollama Query)',
        baseUrl: 'http://base-ollama:11434',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        chatCompletionsUrl: 'http://query-ollama:11434/ollama/v1/messages?token=abc',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-query',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(
    requestedUrls.includes('http://query-ollama:11434/ollama/v1/messages?token=abc'),
    true,
  )
  assert.equal(requestedUrls.includes('http://query-ollama:11434/ollama/api/generate'), true)
  assert.equal(
    requestedUrls.some((url) => url.includes('/messages?token=abc/api/generate')),
    false,
  )
})

test('generateAnswersWithOpenAICompatibleApi strips non-standard v1 Ollama chat path before keep_alive', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-messages',
        name: 'Selected Mode (Ollama Messages)',
        baseUrl: 'http://base-ollama:11434/v1',
        chatCompletionsUrl: 'http://messages-ollama:11434/v1/messages',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-messages',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('http://messages-ollama:11434/v1/messages'), true)
  assert.equal(requestedUrls.includes('http://messages-ollama:11434/api/generate'), true)
  assert.equal(
    requestedUrls.includes('http://messages-ollama:11434/v1/messages/api/generate'),
    false,
  )
})

test('generateAnswersWithOpenAICompatibleApi rejects explicit native Ollama chat URLs', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-chat',
        name: 'Selected Mode (Ollama Chat)',
        baseUrl: 'http://base-ollama:11434/v1',
        chatCompletionsUrl: 'http://chat-ollama:11434/api/chat',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-chat',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await assert.rejects(
    generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config),
    /Unsupported native Ollama chat endpoint/,
  )

  assert.equal(requestedUrls.length, 0)
})

test('generateAnswersWithOpenAICompatibleApi strips nested non-standard Ollama chat path before keep_alive', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama-nested',
        name: 'Selected Mode (Ollama Nested)',
        baseUrl: 'http://base-ollama:11434/v1',
        chatCompletionsUrl: 'http://nested-ollama:11434/custom/v1/messages',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama-nested',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('http://nested-ollama:11434/custom/v1/messages'), true)
  assert.equal(requestedUrls.includes('http://nested-ollama:11434/custom/api/generate'), true)
  assert.equal(
    requestedUrls.includes('http://nested-ollama:11434/custom/v1/messages/api/generate'),
    false,
  )
})

test('generateAnswersWithOpenAICompatibleApi uses secretProviderId lineage for recovered OpenAI sessions', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 777,
    temperature: 0.2,
  })

  const config = {
    providerSecrets: {
      openai: 'legacy-openai-key',
    },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'gpt-5.4-mini',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'legacy-openai-key',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(body.max_tokens, 777)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi keeps OpenAI token params for recovered sessions on native OpenAI URL even when built-in OpenAI URL points to a proxy', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 777,
    temperature: 0.2,
  })

  const config = {
    providerSecrets: {
      openai: 'legacy-openai-key',
    },
    customOpenAiApiUrl: 'https://proxy.example.com/v1',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'gpt-5.4-mini',
      customUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'legacy-openai-key',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_completion_tokens, 777)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi keeps generic compat token params for recovered OpenAI sessions on proxy URL even when built-in OpenAI URL matches that proxy', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 777,
    temperature: 0.2,
  })

  const config = {
    providerSecrets: {
      openai: 'legacy-openai-key',
    },
    customOpenAiApiUrl: 'https://proxy.example.com/v1',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'gpt-5.4-mini',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'legacy-openai-key',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_tokens, 777)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi keeps generic compat token params for recovered OpenAI sessions', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 777,
    temperature: 0.2,
  })

  const config = {
    providerSecrets: {
      openai: 'legacy-openai-key',
    },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'gpt-5.4-mini',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'legacy-openai-key',
      active: true,
    },
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  const body = JSON.parse(capturedInit.body)
  assert.equal(capturedInput, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(body.max_tokens, 777)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
})

test('generateAnswersWithOpenAICompatibleApi rejects recovered Ollama sessions with native path', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'ollama',
      customName: 'llama3.2',
      customUrl: 'http://recovered-ollama:11434/api/chat',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await assert.rejects(
    generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config),
    /Unsupported native Ollama chat endpoint/,
  )

  assert.equal(requestedUrls.length, 0)
})

test('generateAnswersWithOpenAICompatibleApi skips Ollama keep_alive for recovered compat sessions', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    temperature: 0.2,
  })

  const config = {
    ollamaKeepAliveTime: '5m',
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'ollama',
      customName: 'llama3.2',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/api/generate')) {
      return { ok: true }
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(requestedUrls.includes('https://proxy.example.com/v1/chat/completions'), true)
  assert.equal(
    requestedUrls.some((url) => url.endsWith('/api/generate')),
    false,
  )
})

test('generateAnswersWithOpenAiApiCompat keeps max_tokens for latest mapped models in compat provider', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 223,
    temperature: 0.2,
  })
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  for (const [modelName, expectedModel] of latestMappedModels) {
    capturedInit = undefined
    const session = {
      modelName,
      conversationRecords: [],
      isRetry: false,
    }
    const port = createFakePort()

    await generateAnswersWithOpenAiApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-test',
      {},
      'compat',
    )

    const body = JSON.parse(capturedInit.body)
    assert.equal(body.model, expectedModel)
    assert.equal(body.max_tokens, 223)
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
  }
})

test('generateAnswersWithOpenAiApiCompat removes conflicting token key from extraBody', async (t) => {
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

  await generateAnswersWithOpenAiApiCompat(
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

test('generateAnswersWithOpenAiApiCompat removes max_tokens from extraBody for OpenAI latest compat models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 500,
    temperature: 0.2,
  })
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  for (const modelName of latestCompatModelNames) {
    capturedInit = undefined
    const session = {
      modelName,
      conversationRecords: [],
      isRetry: false,
    }
    const port = createFakePort()

    await generateAnswersWithOpenAiApiCompat(
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
  }
})

test('generateAnswersWithOpenAiApiCompat allows max_tokens override for compat provider', async (t) => {
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

  await generateAnswersWithOpenAiApiCompat(
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

test('generateAnswersWithOpenAiApiCompat allows max_completion_tokens override for OpenAI latest compat models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 400,
    temperature: 0.2,
  })
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  for (const modelName of latestCompatModelNames) {
    capturedInit = undefined
    const session = {
      modelName,
      conversationRecords: [],
      isRetry: false,
    }
    const port = createFakePort()

    await generateAnswersWithOpenAiApiCompat(
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
  }
})

test('generateAnswersWithOpenAiApiCompat throws on non-ok response with JSON error body', async (t) => {
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
    await generateAnswersWithOpenAiApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-invalid',
    )
  }, /invalid key/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithOpenAiApiCompat throws on network error', async (t) => {
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
    await generateAnswersWithOpenAiApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-invalid',
    )
  }, /Failed to fetch/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithOpenAiApiCompat falls back to status text when JSON error parsing fails', async (t) => {
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
    await generateAnswersWithOpenAiApiCompat(
      'https://api.example.com/v1',
      port,
      'CurrentQ',
      session,
      'sk-invalid',
    )
  }, /502 Bad Gateway/)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('generateAnswersWithOpenAiApiCompat supports message.content fallback', async (t) => {
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

  await generateAnswersWithOpenAiApiCompat(
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

test('generateAnswersWithGptCompletionApi avoids duplicate /v1 when customOpenAiApiUrl already has /v1', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://api.example.com/v1/',
    maxConversationContextLength: 5,
    maxResponseTokenLength: 300,
    temperature: 0.5,
  })

  const session = {
    modelName: 'gptApiInstruct',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  t.mock.method(globalThis, 'fetch', async (input) => {
    capturedInput = input
    return createMockSseResponse(['data: {"choices":[{"text":"Done","finish_reason":"stop"}]}\n\n'])
  })

  await generateAnswersWithGptCompletionApi(port, 'NowQ', session, 'sk-completion')

  assert.equal(capturedInput, 'https://api.example.com/v1/completions')
})

test('generateAnswersWithChatgptApi avoids duplicate /v1 when customOpenAiApiUrl already has /v1', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customOpenAiApiUrl: 'https://api.example.com/v1/',
    maxConversationContextLength: 2,
    maxResponseTokenLength: 128,
    temperature: 0.2,
  })

  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  t.mock.method(globalThis, 'fetch', async (input) => {
    capturedInput = input
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAiApi(port, 'NowQ', session, 'sk-chat')

  assert.equal(capturedInput, 'https://api.example.com/v1/chat/completions')
})

test('generateAnswersWithOpenAICompatibleApi uses default Ollama endpoint for keepAlive when empty', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 64,
    temperature: 0.2,
  })

  const config = {
    ollamaEndpoint: '',
    providerSecrets: {},
    customOpenAIProviders: [],
  }
  const session = {
    modelName: 'ollama',
    apiMode: {
      groupName: 'ollamaApiModelKeys',
      itemName: 'ollama',
      isCustom: false,
      customName: '',
      customUrl: '',
      apiKey: '',
      providerId: '',
      active: true,
    },
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  const requestedUrls = []

  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/chat/completions')) {
      return createMockSseResponse([
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
      ])
    }
    return { ok: true }
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'NowQ', session, config)

  assert.equal(requestedUrls.includes('http://127.0.0.1:11434/v1/chat/completions'), true)
  assert.equal(requestedUrls.includes('http://127.0.0.1:11434/api/generate'), true)
})

test('generateAnswersWithOpenAICompatibleApi ignores non-string legacy response chunks', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 2,
    maxResponseTokenLength: 64,
    temperature: 0.2,
  })

  const config = {
    providerSecrets: {
      'my-provider': 'sk-custom',
    },
    customOpenAIProviders: [
      {
        id: 'my-provider',
        name: 'My Provider',
        baseUrl: 'https://api.example.com',
        chatCompletionsPath: '/v1/chat/completions',
        completionsPath: '/v1/completions',
        enabled: true,
        allowLegacyResponseField: true,
      },
    ],
  }
  const session = {
    modelName: 'customModel',
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'my-model',
      customUrl: '',
      apiKey: '',
      providerId: 'my-provider',
      active: true,
    },
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"response":false}\n\n',
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithOpenAICompatibleApi(port, 'NowQ', session, config)

  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'false'),
    false,
  )
  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'falseOK'),
    false,
  )
  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'OK'),
    true,
  )
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'NowQ', answer: 'OK' })
})

test('generateAnswersWithOpenAICompatibleApi throws a contextual provider resolution error', async (t) => {
  t.mock.method(console, 'warn', () => {})

  const config = {
    customOpenAIProviders: [
      {
        id: 'missing-provider',
        name: 'Disabled Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        enabled: false,
      },
    ],
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithOpenAICompatibleApi(port, 'NowQ', session, config),
    (error) => {
      assert.match(
        error.message,
        /Failed to resolve OpenAI-compatible provider settings for customApiModelKeys\/missing-provider/,
      )
      assert.match(error.message, /A matching custom provider exists but is disabled/)
      assert.doesNotMatch(error.message, /https:\/\/proxy\.example\.com/)
      return true
    },
  )
})
