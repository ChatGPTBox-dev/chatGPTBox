import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

const commonStorage = {
  maxConversationContextLength: 3,
  maxResponseTokenLength: 256,
  temperature: 0.5,
}

const makeSession = (apiMode) => ({
  apiMode,
  conversationRecords: [],
  isRetry: false,
})

const sseChunks = ['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n']

const adapters = [
  {
    name: 'aiml-api',
    apiMode: { groupName: 'aimlModelKeys', itemName: 'aiml_openai_o3_2025_04_16' },
    providerId: 'aiml',
    expectedBaseUrl: 'https://api.aimlapi.com/v1',
    expectedApiKey: 'aiml-key',
  },
  {
    name: 'deepseek-api',
    apiMode: { groupName: 'deepSeekApiModelKeys', itemName: 'deepseek_chat' },
    providerId: 'deepseek',
    expectedBaseUrl: 'https://api.deepseek.com',
    expectedApiKey: 'ds-key',
  },
  {
    name: 'moonshot-api',
    apiMode: { groupName: 'moonshotApiModelKeys', itemName: 'moonshot_kimi_latest' },
    providerId: 'moonshot',
    expectedBaseUrl: 'https://api.moonshot.cn/v1',
    expectedApiKey: 'ms-key',
  },
  {
    name: 'openrouter-api',
    apiMode: { groupName: 'openRouterApiModelKeys', itemName: 'openRouter_openai_o3' },
    providerId: 'openrouter',
    expectedBaseUrl: 'https://openrouter.ai/api/v1',
    expectedApiKey: 'or-key',
  },
  {
    name: 'chatglm-api',
    apiMode: { groupName: 'chatglmApiModelKeys', itemName: 'chatglmTurbo' },
    providerId: 'chatglm',
    expectedBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    expectedApiKey: 'glm-key',
  },
]

for (const adapter of adapters) {
  test(`${adapter.name}: passes correct base URL and API key`, async (t) => {
    t.mock.method(console, 'debug', () => {})

    const config = {
      ...commonStorage,
      providerSecrets: {
        [adapter.providerId]: adapter.expectedApiKey,
      },
    }
    setStorage(config)

    const session = makeSession(adapter.apiMode)
    const port = createFakePort()

    let capturedInput, capturedInit
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      capturedInput = input
      capturedInit = init
      return createMockSseResponse(sseChunks)
    })

    await generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)

    assert.equal(capturedInput, `${adapter.expectedBaseUrl}/chat/completions`)
    // Verify API key reaches the Authorization header
    assert.equal(capturedInit.headers.Authorization, `Bearer ${adapter.expectedApiKey}`)
  })

  test(`${adapter.name}: delegates to compat layer and produces output`, async (t) => {
    t.mock.method(console, 'debug', () => {})

    const config = {
      ...commonStorage,
      providerSecrets: {
        [adapter.providerId]: adapter.expectedApiKey,
      },
    }
    setStorage(config)

    const session = makeSession(adapter.apiMode)
    const port = createFakePort()

    t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(sseChunks))

    await generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)

    assert.equal(
      port.postedMessages.some((m) => m.done === true && m.session === session),
      true,
    )
    assert.deepEqual(session.conversationRecords.at(-1), {
      question: 'Q',
      answer: 'OK',
    })
  })
}

test('chatglm-api: reads chatglmApiKey from config', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const config = { ...commonStorage, chatglmApiKey: 'glm-secret' }
  setStorage(config)

  const session = makeSession({
    groupName: 'chatglmApiModelKeys',
    itemName: 'chatglmTurbo',
  })
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse(sseChunks)
  })

  await generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)

  assert.equal(capturedInit.headers.Authorization, 'Bearer glm-secret')
})
