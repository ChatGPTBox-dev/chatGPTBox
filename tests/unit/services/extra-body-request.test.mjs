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

function openAiCompatibleRequest({ endpointType = 'chat', model = 'gpt-5', extraBody }) {
  return {
    port: createFakePort(),
    question: 'hi',
    session: { conversationRecords: [] },
    endpointType,
    requestUrl: `https://example.com/v1/${
      endpointType === 'chat' ? 'chat/completions' : 'completions'
    }`,
    model,
    apiKey: 'key',
    provider: 'openai',
    config: {
      maxConversationContextLength: 9,
      maxResponseTokenLength: 1000,
      temperatureOverrideEnabled: false,
      temperature: 1,
      extraBody,
    },
  }
}

test('OpenAI-compatible requests send the extra body without losing the SSE stream', async (t) => {
  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithOpenAICompatible(
      openAiCompatibleRequest({ extraBody: '{"reasoning_effort":"high","stream":false}' }),
    ),
  )

  assert.equal(requestBody.reasoning_effort, 'high')
  assert.equal(requestBody.stream, true)
  assert.equal(requestBody.model, 'gpt-5')
})

test('OpenAI-compatible chat requests keep only the token key the model family uses', async (t) => {
  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithOpenAICompatible(
      openAiCompatibleRequest({ extraBody: '{"max_tokens":123,"max_completion_tokens":456}' }),
    ),
  )

  // gpt-5 sends max_completion_tokens, so that is where the override lands.
  assert.equal(requestBody.max_completion_tokens, 456)
  assert.equal('max_tokens' in requestBody, false)
})

test('OpenAI-compatible chat requests drop the unused token key for max_tokens models', async (t) => {
  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithOpenAICompatible(
      openAiCompatibleRequest({
        model: 'gpt-4.1',
        extraBody: '{"max_tokens":123,"max_completion_tokens":456}',
      }),
    ),
  )

  assert.equal(requestBody.max_tokens, 123)
  assert.equal('max_completion_tokens' in requestBody, false)
})

test('OpenAI-compatible completion requests stay on max_tokens', async (t) => {
  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithOpenAICompatible(
      openAiCompatibleRequest({
        endpointType: 'completion',
        model: 'gpt-3.5-turbo-instruct',
        extraBody: '{"max_tokens":123,"max_completion_tokens":456}',
      }),
    ),
  )

  assert.equal(requestBody.max_tokens, 123)
  assert.equal('max_completion_tokens' in requestBody, false)
})

test('OpenAI-compatible requests keep the conversation and model under extension control', async (t) => {
  const requestBody = await captureRequestBody(t, CHAT_CHUNKS, () =>
    generateAnswersWithOpenAICompatible(
      openAiCompatibleRequest({
        extraBody: '{"model":"gpt-4o","messages":[{"role":"user","content":"tampered"}]}',
      }),
    ),
  )

  assert.equal(requestBody.model, 'gpt-5')
  assert.deepEqual(requestBody.messages, [{ role: 'user', content: 'hi' }])
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

test('Claude requests keep the model and conversation under extension control', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    anthropicApiKey: 'key',
    extraBody: '{"model":"claude-opus-9","messages":[{"role":"user","content":"tampered"}]}',
  })

  const requestBody = await captureRequestBody(t, CLAUDE_CHUNKS, () =>
    generateAnswersWithClaudeApi(createFakePort(), 'hi', {
      modelName: 'claudeSonnet5Api',
      conversationRecords: [],
    }),
  )

  assert.equal(requestBody.model, 'claude-sonnet-5')
  assert.deepEqual(requestBody.messages, [{ role: 'user', content: 'hi' }])
})
