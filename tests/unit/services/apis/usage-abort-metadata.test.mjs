import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithOpenAICompatible } from '../../../../src/services/apis/openai-compatible-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'

const baseConfig = {
  maxConversationContextLength: 3,
  maxResponseTokenLength: 256,
}

function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

test('aborted OpenAI-compatible stream reposts retained metadata with terminal session', async (t) => {
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

  const terminalMessages = port.postedMessages.filter((message) => message.done === true)
  assert.equal(terminalMessages.length, 2)
  assert.equal(terminalMessages[0].session, undefined)
  assert.equal(terminalMessages[1].session, session)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
