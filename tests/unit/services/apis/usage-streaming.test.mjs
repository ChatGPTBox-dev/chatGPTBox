import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithOpenAICompatible } from '../../../../src/services/apis/openai-compatible-core.mjs'
import { generateAnswersWithClaudeApi } from '../../../../src/services/apis/claude-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const baseConfig = {
  maxConversationContextLength: 3,
  maxResponseTokenLength: 256,
}

function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('native OpenAI waits for the trailing usage block', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = { conversationRecords: [], isRetry: false }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      sseData({ model: 'gpt-5.6-20260801', choices: [{ delta: { content: 'Hello' } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sseData({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    ])
  })

  await generateAnswersWithOpenAICompatible({
    port,
    question: 'Hi',
    session,
    endpointType: 'chat',
    requestUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.6',
    apiKey: 'sk-test',
    config: baseConfig,
    provider: 'openai',
  })

  assert.deepEqual(JSON.parse(capturedInit.body).stream_options, { include_usage: true })
  assert.deepEqual(session.conversationRecords, [{ question: 'Hi', answer: 'Hello' }])
  assert.deepEqual(port.postedMessages.at(-1).meta, {
    selectedModel: 'gpt-5.6',
    reportedModel: 'gpt-5.6-20260801',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadInputTokens: 80,
    },
  })
})

test('OpenRouter records the routed model without forcing stream_options', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = { conversationRecords: [], isRetry: false }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      sseData({ choices: [{ delta: { content: 'Routed' }, finish_reason: 'stop' }] }),
      sseData({
        model: 'anthropic/claude-sonnet-5',
        choices: [],
        usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
      }),
    ])
  })

  await generateAnswersWithOpenAICompatible({
    port,
    question: 'Route this',
    session,
    endpointType: 'chat',
    requestUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'openrouter/auto',
    apiKey: 'or-test',
    config: baseConfig,
    provider: 'compat',
  })

  assert.equal(Object.hasOwn(JSON.parse(capturedInit.body), 'stream_options'), false)
  assert.equal(port.postedMessages.at(-1).meta.selectedModel, 'openrouter/auto')
  assert.equal(port.postedMessages.at(-1).meta.reportedModel, 'anthropic/claude-sonnet-5')
})

test('custom OpenAI-compatible endpoints are not forced to accept stream_options', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = { conversationRecords: [], isRetry: false }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      sseData({ choices: [{ delta: { content: 'Compatible' }, finish_reason: 'stop' }] }),
    ])
  })

  await generateAnswersWithOpenAICompatible({
    port,
    question: 'Hi',
    session,
    endpointType: 'chat',
    requestUrl: 'https://proxy.example/v1/chat/completions',
    model: 'custom-model',
    apiKey: 'sk-test',
    config: baseConfig,
    provider: 'openai',
  })

  assert.equal(Object.hasOwn(JSON.parse(capturedInit.body), 'stream_options'), false)
  assert.deepEqual(session.conversationRecords, [{ question: 'Hi', answer: 'Compatible' }])
  assert.deepEqual(port.postedMessages.at(-1).meta, { selectedModel: 'custom-model' })
})

test('Anthropic final metadata includes cumulative cache-aware usage', async (t) => {
  t.mock.method(console, 'debug', () => {})
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customAnthropicApiUrl: 'https://api.anthropic.com',
    anthropicApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
  })
  const session = {
    modelName: 'claudeSonnet5Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      sseData({
        type: 'message_start',
        message: {
          model: 'claude-sonnet-5-20260801',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
            output_tokens: 1,
          },
        },
      }),
      sseData({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude' } }),
      sseData({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 0, output_tokens: 6 },
      }),
      sseData({ type: 'message_stop' }),
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Hello', session)

  assert.deepEqual(session.conversationRecords, [{ question: 'Hello', answer: 'Claude' }])
  assert.deepEqual(port.postedMessages.at(-1).meta, {
    selectedModel: 'claude-sonnet-5',
    reportedModel: 'claude-sonnet-5-20260801',
    usage: {
      inputTokens: 60,
      outputTokens: 6,
      totalTokens: 66,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 30,
    },
  })
})
