import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithOpenAICompatible } from '../../../../src/services/apis/openai-compatible-core.mjs'
import { canApplyTemperatureOverride } from '../../../../src/services/apis/temperature-params.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

function createConfig() {
  return {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 16384,
    temperatureOverrideEnabled: true,
    temperature: 0.2,
  }
}

function sse(delta, finishReason = null) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`
}

test('direct K3 preserves reasoning history and omits temperature overrides', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const bodies = []
  let requestCount = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    requestCount += 1
    if (requestCount === 1) {
      return createMockSseResponse([
        sse({ reasoning_content: 'first thought' }),
        sse({ content: 'First answer' }, 'stop'),
      ])
    }
    return createMockSseResponse([sse({ content: 'Second answer' }, 'stop')])
  })

  const session = { conversationRecords: [], isRetry: false }
  await generateAnswersWithOpenAICompatible({
    port: createFakePort(),
    question: 'First question',
    session,
    endpointType: 'chat',
    requestUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k3',
    apiKey: 'test-key',
    config: createConfig(),
    extraBody: { temperature: 0.8 },
  })

  assert.equal(Object.hasOwn(bodies[0], 'temperature'), false)
  assert.deepEqual(session.conversationRecords[0], {
    question: 'First question',
    answer: 'First answer',
    reasoningContent: 'first thought',
  })

  await generateAnswersWithOpenAICompatible({
    port: createFakePort(),
    question: 'Follow-up',
    session,
    endpointType: 'chat',
    requestUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k3',
    apiKey: 'test-key',
    config: createConfig(),
  })

  assert.deepEqual(bodies[1].messages.slice(0, 2), [
    { role: 'user', content: 'First question' },
    {
      role: 'assistant',
      content: 'First answer',
      reasoning_content: 'first thought',
    },
  ])
})

test('direct K3 preserves partial reasoning when generation is aborted', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const port = createFakePort()
  port._sessionRequestGeneration = 1
  const session = { conversationRecords: [], isRetry: false }

  t.mock.method(globalThis, 'fetch', async () => {
    const response = createMockSseResponse([
      sse({ reasoning_content: 'partial thought' }),
      sse({ content: 'Partial answer' }),
    ])
    const reader = response.body.getReader()
    response.body.getReader = () => ({
      async read() {
        const result = await reader.read()
        if (!result.done) return result
        port.emitMessage({ stop: true, stopGenerationId: 1 })
        throw new DOMException('Aborted', 'AbortError')
      },
    })
    return response
  })

  await generateAnswersWithOpenAICompatible({
    port,
    question: 'Question',
    session,
    endpointType: 'chat',
    requestUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k3',
    apiKey: 'test-key',
    config: createConfig(),
  })

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Question',
      answer: 'Partial answer',
      reasoningContent: 'partial thought',
    },
  ])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('K3 temperature restriction is limited to the direct model ID', () => {
  assert.equal(canApplyTemperatureOverride('kimi-k3'), false)
  assert.equal(canApplyTemperatureOverride('Kimi-K3'), true)
  assert.equal(canApplyTemperatureOverride(' kimi-k3 '), true)
  assert.equal(canApplyTemperatureOverride('moonshotai/kimi-k3'), true)
  assert.equal(canApplyTemperatureOverride('moonshot/kimi-k3'), true)
  assert.equal(canApplyTemperatureOverride('openai/kimi-k3'), true)
  assert.equal(canApplyTemperatureOverride('kimi-k3-preview'), true)
})
