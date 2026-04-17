import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

import { generateAnswersWithAimlApi } from '../../../../src/services/apis/aiml-api.mjs'
import { generateAnswersWithDeepSeekApi } from '../../../../src/services/apis/deepseek-api.mjs'
import { generateAnswersWithMoonshotCompletionApi } from '../../../../src/services/apis/moonshot-api.mjs'
import { generateAnswersWithOpenRouterApi } from '../../../../src/services/apis/openrouter-api.mjs'
import { generateAnswersWithChatGLMApi } from '../../../../src/services/apis/chatglm-api.mjs'

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

const makeSession = () => ({
  modelName: 'chatgptApi4oMini',
  conversationRecords: [],
  isRetry: false,
})

const sseChunks = ['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n']

const adapters = [
  {
    name: 'aiml-api',
    fn: (port, q, session) => generateAnswersWithAimlApi(port, q, session, 'aiml-key'),
    expectedBaseUrl: 'https://api.aimlapi.com/v1',
    expectedApiKey: 'aiml-key',
    storage: commonStorage,
  },
  {
    name: 'deepseek-api',
    fn: (port, q, session) => generateAnswersWithDeepSeekApi(port, q, session, 'ds-key'),
    expectedBaseUrl: 'https://api.deepseek.com',
    expectedApiKey: 'ds-key',
    storage: commonStorage,
  },
  {
    name: 'moonshot-api',
    fn: (port, q, session) => generateAnswersWithMoonshotCompletionApi(port, q, session, 'ms-key'),
    expectedBaseUrl: 'https://api.moonshot.cn/v1',
    expectedApiKey: 'ms-key',
    storage: commonStorage,
  },
  {
    name: 'openrouter-api',
    fn: (port, q, session) => generateAnswersWithOpenRouterApi(port, q, session, 'or-key'),
    expectedBaseUrl: 'https://openrouter.ai/api/v1',
    expectedApiKey: 'or-key',
    storage: commonStorage,
  },
  {
    name: 'chatglm-api',
    fn: (port, q, session) => generateAnswersWithChatGLMApi(port, q, session),
    expectedBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    expectedApiKey: 'glm-key',
    storage: { ...commonStorage, chatglmApiKey: 'glm-key' },
  },
]

for (const adapter of adapters) {
  test(`${adapter.name}: passes correct base URL and API key`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    setStorage(adapter.storage)

    const session = makeSession()
    const port = createFakePort()

    let capturedInput, capturedInit
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      capturedInput = input
      capturedInit = init
      return createMockSseResponse(sseChunks)
    })

    await adapter.fn(port, 'Q', session)

    assert.equal(capturedInput, `${adapter.expectedBaseUrl}/chat/completions`)
    // Verify API key reaches the Authorization header
    assert.equal(capturedInit.headers.Authorization, `Bearer ${adapter.expectedApiKey}`)
  })

  test(`${adapter.name}: delegates to compat layer and produces output`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    setStorage(adapter.storage)

    const session = makeSession()
    const port = createFakePort()

    t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(sseChunks))

    await adapter.fn(port, 'Q', session)

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
  setStorage({ ...commonStorage, chatglmApiKey: 'glm-secret' })

  const session = makeSession()
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse(sseChunks)
  })

  await generateAnswersWithChatGLMApi(port, 'Q', session)

  assert.equal(capturedInit.headers.Authorization, 'Bearer glm-secret')
})
