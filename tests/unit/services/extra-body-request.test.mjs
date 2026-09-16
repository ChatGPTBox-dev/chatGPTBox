import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithOpenAICompatible } from '../../../src/services/apis/openai-compatible-core.mjs'
import { generateAnswersWithClaudeApi } from '../../../src/services/apis/claude-api.mjs'
import { generateAnswersWithAzureOpenaiApi } from '../../../src/services/apis/azure-openai-api.mjs'
import { createFakePort } from '../helpers/port.mjs'
import { createMockSseResponse } from '../helpers/sse-response.mjs'

const CHAT_CHUNKS = [
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
]

const CLAUDE_CHUNKS = [
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  'data: {"type":"message_stop"}\n\n',
]

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

async function captureRequestBody(t, chunks, run) {
  let requestBody
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requestBody = JSON.parse(options.body)
    return createMockSseResponse(chunks)
  })
  await run()
  return requestBody
}

test('OpenAI-compatible requests send the extra body without losing the SSE stream', async (t) => {
  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithOpenAICompatible({
      port: createFakePort(),
      question: 'hi',
      session: { conversationRecords: [] },
      endpointType: 'chat',
      requestUrl: 'https://example.com/v1/chat/completions',
      model: 'gpt-5',
      apiKey: 'key',
      provider: 'openai',
      config: {
        maxConversationContextLength: 9,
        maxResponseTokenLength: 1000,
        temperatureOverrideEnabled: false,
        temperature: 1,
        extraBody: '{"reasoning_effort":"high","stream":false}',
      },
    }),
  )

  assert.equal(requestBody.reasoning_effort, 'high')
  assert.equal(requestBody.stream, true)
  assert.equal(requestBody.model, 'gpt-5')
})

test('Azure OpenAI requests send the extra body', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    azureApiKey: 'key',
    azureEndpoint: 'https://example.openai.azure.com',
    azureDeploymentName: 'deployment',
    extraBody: '{"reasoning_effort":"high"}',
  })

  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithAzureOpenaiApi(createFakePort(), 'hi', { conversationRecords: [] }),
  )

  assert.equal(requestBody.reasoning_effort, 'high')
})

test('Claude requests let the extra body override the built-in thinking default', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    anthropicApiKey: 'key',
    extraBody: '{"thinking":{"type":"enabled","budget_tokens":2048}}',
  })

  const requestBody = await captureRequestBody(t, CLAUDE_CHUNKS, () =>
    generateAnswersWithClaudeApi(createFakePort(), 'hi', {
      // This model normally gets thinking forced off.
      modelName: 'claudeSonnet5Api',
      conversationRecords: [],
    }),
  )

  assert.equal(requestBody.model, 'claude-sonnet-5')
  assert.deepEqual(requestBody.thinking, { type: 'enabled', budget_tokens: 2048 })
})
