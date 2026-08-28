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

if (!globalThis.__TEST_BROWSER_SHIM__) {
  globalThis.__TEST_BROWSER_SHIM__ = {
    storage: {},
    clearStorage() {
      this.storage = {}
    },
    replaceStorage(values) {
      this.storage = { ...values }
    },
  }
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('native OpenAI waits for the trailing usage block and requests streamed usage', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = {
    aiName: 'OpenAI (GPT-5.6)',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"model":"gpt-5.6-2026-08-01","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
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

  const body = JSON.parse(capturedInit.body)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Hi',
      answer: 'Hello',
      meta: {
        selectedModel: 'gpt-5.6',
        reportedModel: 'gpt-5.6-2026-08-01',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 80,
        },
      },
    },
  ])
  assert.equal(
    port.postedMessages.filter((message) => message.done === false).length,
    1,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('OpenRouter is recognized by URL and records the routed model and cache usage', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = {
    aiName: 'OpenRouter Auto',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Routed"},"finish_reason":"stop"}]}\n\n',
      sseData({
        model: 'anthropic/claude-sonnet-5',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 90,
          completion_tokens: 10,
          total_tokens: 100,
          prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 15 },
        },
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
  const lastRecord = session.conversationRecords[session.conversationRecords.length - 1]
  assert.deepEqual(lastRecord.meta, {
    selectedModel: 'openrouter/auto',
    reportedModel: 'anthropic/claude-sonnet-5',
    usage: {
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 15,
    },
  })
})

test('Anthropic streaming stores cumulative output and full cache-aware input usage', async (t) => {
  t.mock.method(console, 'debug', () => {})
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customAnthropicApiUrl: 'https://api.anthropic.com',
    anthropicApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
  })
  const session = {
    aiName: 'Anthropic (Claude Sonnet 5)',
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
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":6}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Hello', session)

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Hello',
      answer: 'Claude',
      meta: {
        selectedModel: 'claude-sonnet-5',
        reportedModel: 'claude-sonnet-5-20260801',
        usage: {
          inputTokens: 60,
          outputTokens: 6,
          totalTokens: 66,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 30,
        },
      },
    },
  ])
})

test('OpenAI preserves a completed answer when the stream breaks before usage arrives', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = {
    aiName: 'OpenAI (GPT-5.6)',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  const encoder = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async () => {
    let readCount = 0
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1
              if (readCount === 1) {
                return {
                  done: false,
                  value: encoder.encode(
                    'data: {"model":"gpt-5.6","choices":[{"delta":{"content":"Complete"}}]}\n\n',
                  ),
                }
              }
              if (readCount === 2) {
                return {
                  done: false,
                  value: encoder.encode(
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
                  ),
                }
              }
              throw new Error('stream interrupted')
            },
          }
        },
      },
    }
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

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Hi',
      answer: 'Complete',
      meta: {
        selectedModel: 'gpt-5.6',
        reportedModel: 'gpt-5.6',
      },
    },
  ])
  const lastMessage = port.postedMessages[port.postedMessages.length - 1]
  assert.equal(lastMessage.done, true)
})

test('a custom OpenAI-compatible endpoint is not forced to accept stream_options', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = {
    aiName: 'Custom OpenAI endpoint',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Compatible"},"finish_reason":"stop"}]}\n\n',
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
  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Hi',
      answer: 'Compatible',
      meta: { selectedModel: 'Custom OpenAI endpoint' },
    },
  ])
})
