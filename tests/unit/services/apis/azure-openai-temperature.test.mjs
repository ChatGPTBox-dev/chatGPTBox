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

for (const fallback of [false, true]) {
  for (const temperatureOverrideEnabled of [false, true]) {
    test(`Azure Responses preserves opaque deployment temperature policy (fallback=${fallback}, override=${temperatureOverrideEnabled})`, async (t) => {
      t.mock.method(console, 'debug', () => {})
      t.mock.method(console, 'warn', () => {})
      globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
        azureEndpoint: 'https://myinstance.openai.azure.com',
        azureApiKey: 'az-key',
        azureDeploymentName: 'gemini-4-flash',
        azureUseResponses: true,
        maxConversationContextLength: 3,
        maxResponseTokenLength: 128,
        temperatureOverrideEnabled,
        temperature: 0.9,
      })
      const session = { modelName: 'azureOpenAi', conversationRecords: [], isRetry: false }
      const requests = []
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) })
        if (fallback && requests.length === 1) return new Response('Not Found', { status: 404 })
        return createMockSseResponse([
          fallback
            ? 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'
            : 'data: {"type":"response.completed","response":{"output_text":"OK"}}\n\n',
        ])
      })

      await generateAnswersWithAzureOpenaiApi(createFakePort(), 'Q', session)

      assert.equal(requests.length, fallback ? 2 : 1)
      assert.equal(requests[0].body.model, 'gemini-4-flash')
      for (const { body } of requests) {
        assert.equal(Object.hasOwn(body, 'temperature'), temperatureOverrideEnabled)
        if (temperatureOverrideEnabled) assert.equal(body.temperature, 0.9)
      }
      assert.equal(session.conversationRecords.length, 1)
    })
  }
}
