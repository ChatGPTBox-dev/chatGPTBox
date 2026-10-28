import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const ATTRIBUTION_HEADER_NAMES = ['X-AIMLAPI-Source', 'X-AIMLAPI-Partner-ID']

function createConfig(overrides = {}) {
  return {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperatureOverrideEnabled: false,
    temperature: 1,
    ...overrides,
  }
}

function createCustomProviderSession(providerId) {
  return {
    modelName: 'customModel',
    conversationRecords: [],
    isRetry: false,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId,
      customName: 'openai/gpt-5-5',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }
}

function createCustomProviderConfig(providerId, baseUrl, extraProviderFields = {}) {
  return createConfig({
    customOpenAIProviders: [
      {
        id: providerId,
        name: providerId,
        baseUrl,
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: true,
        ...extraProviderFields,
      },
    ],
    providerSecrets: {
      [providerId]: 'custom-key',
    },
  })
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

  await generateAnswersWithOpenAICompatibleApi(createFakePort(), 'CurrentQ', session, config)

  return { capturedInput, capturedInit }
}

function assertAimlAttribution(headers) {
  assert.equal(headers['X-AIMLAPI-Source'], 'agent/chatgptbox')
  assert.equal(headers['X-AIMLAPI-Partner-ID'], 'part_suAsqzeIpC2a5yS8K1leCNtf')
}

function assertNoAimlAttribution(headers) {
  for (const headerName of ATTRIBUTION_HEADER_NAMES) {
    assert.equal(Object.hasOwn(headers, headerName), false, headerName)
  }
}

test('adds attribution headers for built-in AI/ML requests', async (t) => {
  const config = createConfig({
    providerSecrets: {
      aiml: 'aiml-test-key',
    },
  })
  const session = {
    modelName: 'aiml_openai_gpt_5_5',
    conversationRecords: [],
    isRetry: false,
  }

  const { capturedInput, capturedInit } = await captureRequest(t, config, session)

  assert.equal(capturedInput, 'https://api.aimlapi.com/v1/chat/completions')
  assert.equal(capturedInit.headers.Authorization, 'Bearer aiml-test-key')
  assertAimlAttribution(capturedInit.headers)
  assert.equal(Object.hasOwn(capturedInit.headers, 'X-OpenRouter-Title'), false)

  const body = JSON.parse(capturedInit.body)
  for (const headerName of ATTRIBUTION_HEADER_NAMES) {
    assert.equal(Object.hasOwn(body, headerName), false)
  }
})

test('adds attribution headers for custom providers that call AI/ML directly', async (t) => {
  const config = createCustomProviderConfig('direct-aiml', 'https://api.aimlapi.com/v1')
  const session = createCustomProviderSession('direct-aiml')

  const { capturedInput, capturedInit } = await captureRequest(t, config, session)

  assert.equal(capturedInput, 'https://api.aimlapi.com/v1/chat/completions')
  assert.equal(capturedInit.headers.Authorization, 'Bearer custom-key')
  assertAimlAttribution(capturedInit.headers)
})

const nonAimlBaseUrls = [
  ['third-party proxy', 'https://proxy.example.com/v1'],
  ['look-alike host', 'https://api.aimlapi.com.example.com/v1'],
  ['look-alike prefix', 'https://notapi.aimlapi.com/v1'],
  ['subdomain', 'https://eu.api.aimlapi.com/v1'],
  ['parent domain', 'https://aimlapi.com/v1'],
  ['host in path', 'https://proxy.example.com/api.aimlapi.com/v1'],
]

for (const [label, baseUrl] of nonAimlBaseUrls) {
  test(`omits AI/ML attribution headers for a ${label} copied from the AI/ML provider`, async (t) => {
    const config = createCustomProviderConfig('aiml-proxy', baseUrl, { sourceProviderId: 'aiml' })
    const session = createCustomProviderSession('aiml-proxy')

    const { capturedInput, capturedInit } = await captureRequest(t, config, session)

    assert.equal(capturedInput, `${baseUrl}/chat/completions`)
    assert.equal(capturedInit.headers.Authorization, 'Bearer custom-key')
    assertNoAimlAttribution(capturedInit.headers)
  })
}

test('omits AI/ML attribution headers for other built-in providers', async (t) => {
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
  assertNoAimlAttribution(capturedInit.headers)
  assert.equal(capturedInit.headers['X-OpenRouter-Title'], 'ChatGPTBox')
})
