import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithAzureOpenaiApi } from '../../../../src/services/apis/azure-openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('Azure temperature override does not treat deployment aliases as canonical model IDs', async (t) => {
  t.mock.method(console, 'debug', () => {})
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'az-key',
    azureDeploymentName: 'gemini-4-flash',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperatureOverrideEnabled: true,
    temperature: 0.9,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [],
    isRetry: false,
  }
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithAzureOpenaiApi(createFakePort(), 'Q', session)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.temperature, 0.9)
})
