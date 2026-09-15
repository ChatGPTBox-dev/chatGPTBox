import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import {
  deriveChatCompletionsUrlFromResponsesUrl,
  deriveResponsesUrlFromChatUrl,
  normalizeApiProtocol,
  resolveApiProtocolForSession,
  resolveOpenAICompatibleRequest,
} from '../../../../src/services/apis/provider-registry.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('normalizeApiProtocol defaults to chat and accepts responses', () => {
  assert.equal(normalizeApiProtocol(undefined), 'chat')
  assert.equal(normalizeApiProtocol('chat'), 'chat')
  assert.equal(normalizeApiProtocol('responses'), 'responses')
  assert.equal(normalizeApiProtocol('RESPONSES'), 'responses')
  assert.equal(normalizeApiProtocol('other'), 'chat')
})

test('deriveResponsesUrlFromChatUrl replaces chat completions suffix', () => {
  assert.equal(
    deriveResponsesUrlFromChatUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/responses',
  )
  assert.equal(
    deriveResponsesUrlFromChatUrl('https://api.openai.com/v1/chat/completions/'),
    'https://api.openai.com/v1/responses',
  )
  assert.equal(
    deriveResponsesUrlFromChatUrl('https://api.openai.com/v1/responses'),
    'https://api.openai.com/v1/responses',
  )
  assert.equal(deriveResponsesUrlFromChatUrl(''), '')
})

test('resolveApiProtocolForSession prefers session override then provider setting', () => {
  assert.equal(resolveApiProtocolForSession({}, { apiProtocol: 'responses' }), 'responses')
  assert.equal(resolveApiProtocolForSession({}, {}), 'chat')
  assert.equal(
    resolveApiProtocolForSession({ apiMode: { apiProtocol: 'responses' } }, {}),
    'responses',
  )
})

test('protocol URL conversion preserves queries and fragments while rewriting only the path', () => {
  const suffix = '?api-version=2025-01-01&next=%2Fchat%2Fcompletions&value=a?b/#section'
  for (const trailingSlash of ['', '/']) {
    assert.equal(
      deriveResponsesUrlFromChatUrl(
        `https://proxy.example/v1/chat/completions${trailingSlash}${suffix}`,
      ),
      `https://proxy.example/v1/responses${suffix}`,
    )
    assert.equal(
      deriveResponsesUrlFromChatUrl(`https://proxy.example/v1/responses${trailingSlash}${suffix}`),
      `https://proxy.example/v1/responses${suffix}`,
    )
    assert.equal(
      deriveChatCompletionsUrlFromResponsesUrl(
        `https://proxy.example/v1/responses${trailingSlash}${suffix}`,
      ),
      `https://proxy.example/v1/chat/completions${suffix}`,
    )
  }
  assert.equal(
    deriveResponsesUrlFromChatUrl(`https://proxy.example/v1${suffix}`),
    `https://proxy.example/v1/responses${suffix}`,
  )
})

for (const {
  chatEndpoint,
  responsesUrl,
  expectedResponsesUrl = responsesUrl,
  expectedChatUrl,
  tokenParameter = 'max_tokens',
} of [
  {
    chatEndpoint: { chatCompletionsUrl: 'https://chat.example/custom/chat?api-version=1' },
    responsesUrl: 'https://responses.example/custom/respond?api-version=2',
    expectedChatUrl: 'https://chat.example/custom/chat?api-version=1',
  },
  {
    chatEndpoint: {
      baseUrl: 'https://chat.example',
      chatCompletionsPath: '/custom/chat?api-version=1',
    },
    responsesUrl: 'https://responses.example/custom/respond?api-version=2',
    expectedChatUrl: 'https://chat.example/custom/chat?api-version=1',
  },
  {
    chatEndpoint: { chatCompletionsUrl: 'https://chat.example/custom/chat/?api-version=1' },
    responsesUrl: 'https://responses.example/custom/respond?api-version=2',
    expectedChatUrl: 'https://chat.example/custom/chat/?api-version=1',
  },
  {
    chatEndpoint: { chatCompletionsUrl: 'https://chat.example/v1/responses/?api-version=1' },
    expectedResponsesUrl: 'https://chat.example/v1/responses?api-version=1',
    expectedChatUrl: 'https://chat.example/v1/responses/?api-version=1',
  },
  {
    chatEndpoint: {
      sourceProviderId: 'openai',
      chatCompletionsUrl: 'https://api.openai.com/v1/chat/completions',
    },
    responsesUrl: 'https://responses.example/v1/responses',
    expectedChatUrl: 'https://api.openai.com/v1/chat/completions',
    tokenParameter: 'max_completion_tokens',
  },
  {
    chatEndpoint: {
      sourceProviderId: 'openai',
      chatCompletionsUrl: 'https://chat.example/v1/chat/completions',
    },
    responsesUrl: 'https://api.openai.com/v1/responses',
    expectedChatUrl: 'https://chat.example/v1/chat/completions',
  },
]) {
  test(`Responses fallback uses configured Chat endpoint: ${JSON.stringify(
    chatEndpoint,
  )}`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    t.mock.method(console, 'warn', () => {})
    setStorage({ maxResponseTokenLength: 256 })
    const config = {
      customOpenAIProviders: [
        {
          id: 'separate-endpoints',
          name: 'Separate endpoints',
          apiProtocol: 'responses',
          responsesUrl,
          ...chatEndpoint,
        },
      ],
      providerSecrets: { 'separate-endpoints': 'key-test' },
    }
    const session = {
      modelName: 'customModel',
      conversationRecords: [],
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'separate-endpoints',
        customName: 'gpt-5',
      },
    }
    const requestedUrls = []
    const requestedBodies = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requestedUrls.push(url)
      requestedBodies.push(JSON.parse(init.body))
      if (requestedUrls.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 })
      }
      return createMockSseResponse([
        'data: {"choices":[{"delta":{"content":"Fallback"},"finish_reason":"stop"}]}\n\n',
      ])
    })
    await generateAnswersWithOpenAICompatibleApi(createFakePort(), 'Question', session, config)
    assert.deepEqual(requestedUrls, [expectedResponsesUrl, expectedChatUrl])
    assert.equal(requestedBodies[1][tokenParameter], 256)
    const otherTokenParameter =
      tokenParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
    assert.equal(Object.hasOwn(requestedBodies[1], otherTokenParameter), false)
    assert.deepEqual(session.conversationRecords, [{ question: 'Question', answer: 'Fallback' }])
  })
}

test('resolveOpenAICompatibleRequest derives responses URL for responses providers', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'responses-proxy',
        name: 'Responses Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        apiProtocol: 'responses',
        enabled: true,
      },
    ],
    providerSecrets: { 'responses-proxy': 'key-1' },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'responses-proxy',
      customName: 'gpt-5.6',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const request = resolveOpenAICompatibleRequest(config, session)
  assert.equal(request.apiProtocol, 'responses')
  assert.equal(request.requestUrl, 'https://proxy.example.com/v1/responses')
})

test('resolveOpenAICompatibleRequest keeps chat URL by default', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'chat-proxy',
        name: 'Chat Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: true,
      },
    ],
    providerSecrets: { 'chat-proxy': 'key-1' },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'chat-proxy',
      customName: 'gpt-5.6',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const request = resolveOpenAICompatibleRequest(config, session)
  assert.equal(request.apiProtocol, 'chat')
  assert.equal(request.requestUrl, 'https://proxy.example.com/v1/chat/completions')
})

test('generateAnswersWithOpenAICompatibleApi routes responses providers to responses endpoint', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ maxConversationContextLength: 3, maxResponseTokenLength: 111 })
  const config = {
    customOpenAIProviders: [
      {
        id: 'responses-proxy',
        name: 'Responses Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        apiProtocol: 'responses',
        enabled: true,
      },
    ],
    providerSecrets: { 'responses-proxy': 'key-1' },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'responses-proxy',
      customName: 'gpt-5.6',
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
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.equal(capturedInput, 'https://proxy.example.com/v1/responses')
  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_output_tokens, 111)
  assert.equal(Object.hasOwn(body, 'messages'), false)
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hi' })
})

test('generateAnswersWithOpenAICompatibleApi falls back to chat when responses is unsupported', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({ maxConversationContextLength: 3, maxResponseTokenLength: 222 })
  const config = {
    customOpenAIProviders: [
      {
        id: 'responses-proxy',
        name: 'Responses Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        apiProtocol: 'responses',
        enabled: true,
      },
    ],
    providerSecrets: { 'responses-proxy': 'key-1' },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'responses-proxy',
      customName: 'gpt-5.6',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()
  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    if (String(input).endsWith('/v1/responses')) {
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 })
    }
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Fallback"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config)

  assert.deepEqual(requestedUrls, [
    'https://proxy.example.com/v1/responses',
    'https://proxy.example.com/v1/chat/completions',
  ])
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'CurrentQ',
    answer: 'Fallback',
  })
})

test('generateAnswersWithOpenAICompatibleApi honors the OpenAI responses toggle', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    customOpenAiApiUrl: 'https://api.openai.com',
    openaiApiProtocol: 'responses',
    providerSecrets: { openai: 'sk-test' },
  })
  const session = {
    modelName: 'chatgptApi5_6',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'chatgptApi5_6',
      isCustom: false,
    },
  }
  const port = createFakePort()
  let capturedInput
  t.mock.method(globalThis, 'fetch', async (input) => {
    capturedInput = input
    return createMockSseResponse([
      'data: {"type":"response.completed","response":{"output_text":"Answer"}}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    customOpenAiApiUrl: 'https://api.openai.com',
    openaiApiProtocol: 'responses',
    providerSecrets: { openai: 'sk-test' },
  })

  assert.equal(capturedInput, 'https://api.openai.com/v1/responses')
})

test('generateAnswersWithOpenAICompatibleApi keeps legacy completions on chat endpoint', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    customOpenAiApiUrl: 'https://api.openai.com',
    openaiApiProtocol: 'responses',
    providerSecrets: { openai: 'sk-test' },
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
    return createMockSseResponse(['data: {"choices":[{"text":"done","finish_reason":"stop"}]}\n\n'])
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 333,
    customOpenAiApiUrl: 'https://api.openai.com',
    openaiApiProtocol: 'responses',
    providerSecrets: { openai: 'sk-test' },
  })

  assert.equal(capturedInput, 'https://api.openai.com/v1/completions')
})

test('generateAnswersWithOpenAICompatibleApi does not fall back after mid-stream errors', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
  setStorage({ maxConversationContextLength: 3, maxResponseTokenLength: 222 })
  const config = {
    customOpenAIProviders: [
      {
        id: 'responses-proxy',
        name: 'Responses Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        apiProtocol: 'responses',
        enabled: true,
      },
    ],
    providerSecrets: { 'responses-proxy': 'key-1' },
  }
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'responses-proxy',
      customName: 'gpt-5.6',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
  const port = createFakePort()
  const requestedUrls = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    requestedUrls.push(String(input))
    return createMockSseResponse([
      'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
      'data: {"type":"error","message":"boom","error":{"message":"boom"}}\n\n',
    ])
  })

  await assert.rejects(
    generateAnswersWithOpenAICompatibleApi(port, 'CurrentQ', session, config),
    /boom/,
  )
  assert.deepEqual(requestedUrls, ['https://proxy.example.com/v1/responses'])
})

for (const chatPath of ['/api/chat', '/v1/chat/completions']) {
  test(`Responses fallback preserves Ollama behavior for ${chatPath}`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    t.mock.method(console, 'warn', () => {})
    const config = {
      customOpenAIProviders: [
        {
          id: 'ollama-proxy',
          sourceProviderId: 'ollama',
          apiProtocol: 'responses',
          responsesUrl: 'https://responses.example/v1/responses',
          chatCompletionsUrl: `https://ollama.example${chatPath}`,
        },
      ],
      providerSecrets: { 'ollama-proxy': 'ollama-test-key' },
      ollamaKeepAliveTime: '-1',
    }
    const session = {
      modelName: 'customModel',
      conversationRecords: [],
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'ollama-proxy',
        customName: 'llama-test',
      },
    }
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      if (requests.length === 1) return new Response('{}', { status: 404 })
      return createMockSseResponse([
        'data: {"choices":[{"delta":{"content":"Fallback"},"finish_reason":"stop"}]}\n\n',
      ])
    })
    const result = generateAnswersWithOpenAICompatibleApi(
      createFakePort(),
      'Question',
      session,
      config,
    )
    if (chatPath === '/api/chat') {
      await assert.rejects(result, /Unsupported native Ollama chat endpoint/)
      assert.equal(requests.length, 1)
      assert.deepEqual(session.conversationRecords, [])
    } else {
      await result
      assert.deepEqual(
        requests.map(({ url }) => url),
        [
          'https://responses.example/v1/responses',
          'https://ollama.example/v1/chat/completions',
          'https://ollama.example/api/generate',
        ],
      )
      assert.equal(requests[2].body.keep_alive, -1)
      assert.deepEqual(session.conversationRecords, [{ question: 'Question', answer: 'Fallback' }])
    }
  })
}
