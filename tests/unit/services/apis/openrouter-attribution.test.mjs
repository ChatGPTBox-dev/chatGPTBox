import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  generateAnswersWithOpenAICompatibleApi,
} from '../../../../src/services/apis/openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const ATTRIBUTION_HEADER_NAMES = [
  'HTTP-Referer',
  'X-OpenRouter-Title',
  'X-OpenRouter-Categories',
]

function createConfig(overrides = {}) {
  return {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperatureOverrideEnabled: false,
    temperature: 1,
    ...overrides,
  }
}

async function captureRequest(t, config, session) {
  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatibleApi(
    createFakePort(),
    'CurrentQ',
    session,
    config,
  )

  return { capturedInput, capturedInit }
}

function assertOpenRouterAttribution(headers) {
  assert.equal(headers['HTTP-Referer'], 'https://github.com/ChatGPTBox-dev/chatGPTBox')
  assert.equal(headers['X-OpenRouter-Title'], 'ChatGPTBox')
  assert.equal(headers['X-OpenRouter-Categories'], 'general-chat,writing-assistant')
}

function assertNoOpenRouterAttribution(headers) {
  for (const headerName of ATTRIBUTION_HEADER_NAMES) {
    assert.equal(Object.hasOwn(headers, headerName), false)
  }
}

test('adds app attribution headers for built-in OpenRouter requests', async (t) => {
  const config = createConfig({
    providerSecrets: {
      openrouter: 'sk-or-test',
    },
  })
  const session = {
    modelName: 'openRouter_auto',
    conversationRecords: [],
    isRetry: false,
  }

  const { capturedInput, capturedInit } = await captureRequest(t, config, session)

  assert.equal(capturedInput, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-or-test')
  assertOpenRouterAttribution(capturedInit.headers)

  const body = JSON.parse(capturedInit.body)
  for (const headerName of ATTRIBUTION_HEADER_NAMES) {
    assert.equal(Object.hasOwn(body, headerName), false)
  }
})

test('adds app attribution headers for custom providers that call OpenRouter directly', async (t) => {
  const config = createConfig({
    customOpenAIProviders: [
      {
        id: 'direct-openrouter',
        name: 'Direct OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'direct-openrouter': 'direct-key',
    },
  })
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'direct-openrouter',
      customName: 'openai/gpt-5.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  const { capturedInput, capturedInit } = await captureRequest(t, config, session)

  assert.equal(capturedInput, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(capturedInit.headers.Authorization, 'Bearer direct-key')
  assertOpenRouterAttribution(capturedInit.headers)
})

test('omits OpenRouter attribution headers for third-party proxy endpoints', async (t) => {
  const config = createConfig({
    customOpenAIProviders: [
      {
        id: 'openrouter-proxy',
        name: 'OpenRouter Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        sourceProviderId: 'openrouter',
        enabled: true,
      },
    ],
    providerSecrets: {
      'openrouter-proxy': 'proxy-key',
    },
  })
  const session = {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openrouter-proxy',
      customName: 'openai/gpt-5.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  const { capturedInput, capturedInit } = await captureRequest(t, config, session)

  assert.equal(capturedInput, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(capturedInit.headers.Authorization, 'Bearer proxy-key')
  assertNoOpenRouterAttribution(capturedInit.headers)
})
