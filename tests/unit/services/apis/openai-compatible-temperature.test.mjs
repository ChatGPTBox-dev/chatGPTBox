import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithOpenAICompatible } from '../../../../src/services/apis/openai-compatible-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

function createSession() {
  return {
    conversationRecords: [],
    isRetry: false,
  }
}

function createConfig(overrides = {}) {
  return {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperatureOverrideEnabled: false,
    temperature: 0.7,
    ...overrides,
  }
}

test('OpenAI-compatible extra body cannot enable temperature while override is disabled', async (t) => {
  t.mock.method(console, 'debug', () => {})
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatible({
    port: createFakePort(),
    question: 'Q',
    session: createSession(),
    endpointType: 'chat',
    requestUrl: 'https://api.example.com/v1/chat/completions',
    model: 'gpt-4.1',
    apiKey: 'test-key',
    config: createConfig(),
    extraBody: { temperature: 0.2 },
  })

  const body = JSON.parse(capturedInit.body)
  assert.equal(Object.hasOwn(body, 'temperature'), false)
})

test('OpenAI-compatible configured override takes precedence over extra-body temperature', async (t) => {
  t.mock.method(console, 'debug', () => {})
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAICompatible({
    port: createFakePort(),
    question: 'Q',
    session: createSession(),
    endpointType: 'chat',
    requestUrl: 'https://api.example.com/v1/chat/completions',
    model: 'gpt-4.1',
    apiKey: 'test-key',
    config: createConfig({ temperatureOverrideEnabled: true }),
    extraBody: { temperature: 0.2 },
  })

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.temperature, 0.7)
})

test('OpenAI-compatible completion extra body cannot enable temperature while override is disabled', async (t) => {
  t.mock.method(console, 'debug', () => {})
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse(['data: {"choices":[{"text":"OK","finish_reason":"stop"}]}\n\n'])
  })

  await generateAnswersWithOpenAICompatible({
    port: createFakePort(),
    question: 'Q',
    session: createSession(),
    endpointType: 'completion',
    requestUrl: 'https://api.example.com/v1/completions',
    model: 'gpt-3.5-turbo-instruct',
    apiKey: 'test-key',
    config: createConfig(),
    extraBody: { temperature: 0.2 },
  })

  const body = JSON.parse(capturedInit.body)
  assert.equal(Object.hasOwn(body, 'temperature'), false)
})

test('OpenAI-compatible completion override takes precedence over extra-body temperature', async (t) => {
  t.mock.method(console, 'debug', () => {})
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse(['data: {"choices":[{"text":"OK","finish_reason":"stop"}]}\n\n'])
  })

  await generateAnswersWithOpenAICompatible({
    port: createFakePort(),
    question: 'Q',
    session: createSession(),
    endpointType: 'completion',
    requestUrl: 'https://api.example.com/v1/completions',
    model: 'gpt-3.5-turbo-instruct',
    apiKey: 'test-key',
    config: createConfig({ temperatureOverrideEnabled: true }),
    extraBody: { temperature: 0.2 },
  })

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.temperature, 0.7)
})
