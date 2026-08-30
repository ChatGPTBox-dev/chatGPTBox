import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithClaudeApi } from '../../../../src/services/apis/claude-api.mjs'
import {
  generateAnswersWithOpenAICompatible,
} from '../../../../src/services/apis/openai-compatible-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'

const baseConfig = {
  maxConversationContextLength: 3,
  maxResponseTokenLength: 256,
}

function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function assertMetadataSessionFollowsStopAcknowledgement(port, session) {
  const acknowledgementIndex = port.postedMessages.findIndex(
    (message) => message.done === true && message.session === undefined,
  )
  const sessionIndex = port.postedMessages.findIndex((message) => message.session === session)

  assert.notEqual(acknowledgementIndex, -1)
  assert.notEqual(sessionIndex, -1)
  assert.equal(port.postedMessages[sessionIndex].done, true)
  assert.equal(acknowledgementIndex < sessionIndex, true)
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

test('OpenAI-compatible abort reposts retained metadata in a terminal session', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = {
    aiName: 'Custom provider',
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
                    sseData({
                      model: 'reported-model',
                      choices: [{ delta: { content: 'Partial' } }],
                      usage: {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                        total_tokens: 12,
                      },
                    }),
                  ),
                }
              }

              port.emitMessage({ stop: true })
              const error = new Error('aborted')
              error.name = 'AbortError'
              throw error
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
    requestUrl: 'https://proxy.example/v1/chat/completions',
    model: 'selected-model',
    apiKey: 'test-key',
    config: baseConfig,
    provider: 'compat',
  })

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Hi',
      answer: 'Partial',
      meta: {
        selectedModel: 'selected-model',
        reportedModel: 'reported-model',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
        },
      },
    },
  ])
  assertMetadataSessionFollowsStopAcknowledgement(port, session)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('aborted Claude stream reposts retained metadata with terminal session', async (t) => {
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
                    }) +
                      sseData({
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: 'Partial' },
                      }),
                  ),
                }
              }

              port.emitMessage({ stop: true })
              const error = new Error('aborted')
              error.name = 'AbortError'
              throw error
            },
          }
        },
      },
    }
  })

  await generateAnswersWithClaudeApi(port, 'Hello', session)

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Hello',
      answer: 'Partial',
      meta: {
        selectedModel: 'claude-sonnet-5',
        reportedModel: 'claude-sonnet-5-20260801',
        usage: {
          inputTokens: 60,
          outputTokens: 1,
          totalTokens: 61,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 30,
        },
      },
    },
  ])
  assertMetadataSessionFollowsStopAcknowledgement(port, session)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
