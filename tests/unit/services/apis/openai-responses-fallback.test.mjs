import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import { generateAnswersWithAzureOpenaiApi } from '../../../../src/services/apis/azure-openai-api.mjs'
import { isResponsesRouteUnsupportedError } from '../../../../src/services/apis/openai-responses-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const cases = [
  [404, 'Not found', true],
  [400, 'Unknown URL /v1/responses', true],
  [400, 'The api-version is invalid for /openai/responses', true],
  [400, 'The api-version "2025-01-01" is unsupported for /openai/responses', true],
  [400, 'The model is not supported with the Responses API', true],
  [400, 'The model "old-model" does not support /v1/responses', true],
  [405, 'The endpoint /v1/responses is not supported', true],
  [501, 'Unsupported endpoint /openai/responses', true],
  [400, 'The Responses API is not supported', true],
  [501, 'The Responses API is not supported', true],
  [400, 'The model gpt-4o does not support the Responses API', true],
  [400, 'The api-version 2025-04-01-preview is invalid for /openai/responses', true],
  [401, 'Invalid API key for /v1/responses', false],
  [403, 'Access to /v1/responses does not exist for this API key', false],
  [429, 'Unknown URL /v1/responses', false],
  [500, 'Unknown URL /v1/responses', false],
  [503, 'Unsupported endpoint /openai/responses', false],
  [400, 'Invalid input schema for /v1/responses', false],
  [400, 'Unknown parameter model for /v1/responses', false],
  [400, 'Unsupported parameter api-version for /openai/responses', false],
  [400, 'The model requires an invalid input schema for /v1/responses', false],
  [400, 'The model is supported by /v1/responses but input is invalid', false],
  [400, 'The model does not support temperature in the Responses API.', false],
  [400, 'The endpoint /v1/responses does not support temperature', false],
  [400, 'The Responses API does not support this parameter', false],
  [400, 'Previous response does not exist for /v1/responses', false],
  [400, 'File not found for /v1/responses', false],
  [400, 'Unknown URL /v1/chat/completions', false],
  [undefined, 'Unknown URL /v1/responses', false],
]

beforeEach((t) => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
})

for (const [status, message, fallback] of cases) {
  test(`Responses fallback classifier: ${status} ${message}`, () => {
    assert.equal(isResponsesRouteUnsupportedError({ status, message }), fallback)
    assert.equal(
      isResponsesRouteUnsupportedError({ status, message: JSON.stringify({ error: { message } }) }),
      fallback,
    )
  })
}

test('Responses fallback ignores route and error words in unrelated JSON metadata', () => {
  assert.equal(
    isResponsesRouteUnsupportedError({
      status: 400,
      message: JSON.stringify({
        error: { message: 'Invalid input' },
        request: { path: '/v1/responses' },
        hint: 'Unknown URL /v1/responses',
      }),
    }),
    false,
  )
})

for (const [provider, format] of ['OpenAI-compatible', 'Azure'].flatMap((provider) =>
  ['json', 'text'].map((format) => [provider, format]),
)) {
  for (const [status, message, fallback] of cases.filter(([status]) => status !== undefined)) {
    test(`${provider} ${format} initial HTTP ${status}: ${message}`, async (t) => {
      const config = {
        azureUseResponses: true,
        azureEndpoint: 'https://azure.example',
        azureApiKey: 'test-key',
        azureDeploymentName: 'gpt-4o',
        customOpenAIProviders: [
          {
            id: 'fallback-test',
            name: 'Fallback test',
            apiProtocol: 'responses',
            responsesUrl: 'https://responses.example/v1/responses',
            chatCompletionsUrl: 'https://chat.example/custom/chat',
          },
        ],
        providerSecrets: { 'fallback-test': 'test-key' },
      }
      globalThis.__TEST_BROWSER_SHIM__.replaceStorage(config)
      const history = [{ question: 'Previous question', answer: 'Previous answer' }]
      const session = {
        modelName: provider === 'Azure' ? 'azureOpenAi' : 'customModel',
        conversationRecords: structuredClone(history),
        isRetry: false,
        ...(provider === 'Azure'
          ? {}
          : {
              apiMode: {
                groupName: 'customApiModelKeys',
                itemName: 'customModel',
                isCustom: true,
                providerId: 'fallback-test',
                customName: 'gpt-4o',
                active: true,
              },
            }),
      }
      const port = createFakePort()
      const calls = []
      const errorBody = format === 'text' ? message : JSON.stringify({ error: { message } })
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, signal: options.signal })
        if (calls.length === 1) return new Response(errorBody, { status })
        return createMockSseResponse([
          'data: {"choices":[{"delta":{"content":"Fallback"},"finish_reason":"stop"}]}\n\n',
        ])
      })
      const request =
        provider === 'Azure'
          ? generateAnswersWithAzureOpenaiApi(port, 'Question', session)
          : generateAnswersWithOpenAICompatibleApi(port, 'Question', session, config)
      if (fallback) {
        await request
        assert.equal(calls.length, 2)
        assert.equal(
          calls[1].url,
          provider === 'Azure'
            ? 'https://azure.example/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01'
            : 'https://chat.example/custom/chat',
        )
        assert.equal(calls[1].signal, calls[0].signal)
        assert.deepEqual(session.conversationRecords, [
          ...history,
          { question: 'Question', answer: 'Fallback' },
        ])
      } else {
        await assert.rejects(
          request,
          (error) => error.status === status && error.message === errorBody,
        )
        assert.equal(calls.length, 1)
        assert.deepEqual(session.conversationRecords, history)
        assert.equal(
          port.postedMessages.some((message) => message.done),
          false,
        )
      }
      assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
    })
  }
}
