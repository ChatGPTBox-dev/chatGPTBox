import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithAzureOpenaiApi } from '../../../../src/services/apis/azure-openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('azure-openai: composes URL, strips trailing slash, sends api-key header', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com/',
    azureApiKey: 'az-key-123',
    azureDeploymentName: 'gpt-4o',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 512,
    temperature: 0.7,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithAzureOpenaiApi(port, 'Hello', session)

  assert.equal(
    capturedInput,
    'https://myinstance.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01',
  )
  assert.equal(capturedInit.headers['api-key'], 'az-key-123')
  assert.equal(capturedInit.headers['Content-Type'], 'application/json')
})

test('azure-openai: endpoint without trailing slash works', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'az-key-456',
    azureDeploymentName: 'gpt-4o',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  t.mock.method(globalThis, 'fetch', async (input) => {
    capturedInput = input
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithAzureOpenaiApi(port, 'Q', session)

  assert.equal(
    capturedInput,
    'https://myinstance.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01',
  )
})

test('azure-openai: uses resolved model value when non-empty (skips fallback)', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'az-key',
    azureDeploymentName: 'should-not-use',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.3,
  })

  // Custom model name that resolves to non-empty 'my-gpt4' via split('-').slice(1).join('-')
  const session = {
    modelName: 'azureOpenAi-my-gpt4',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  t.mock.method(globalThis, 'fetch', async (input) => {
    capturedInput = input
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithAzureOpenaiApi(port, 'Q', session)

  assert.match(capturedInput, /\/deployments\/my-gpt4\//)
  assert.ok(!capturedInput.includes('should-not-use'))
})

test('azure-openai: sends max_tokens and temperature in body', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'az-key',
    azureDeploymentName: 'gpt-4o',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 1024,
    temperature: 0.9,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithAzureOpenaiApi(port, 'Q', session)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.max_tokens, 1024)
  assert.equal(body.temperature, 0.9)
  assert.equal(body.stream, true)
})

test('azure-openai: aggregates SSE deltas and pushes record on finish', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'az-key',
    azureDeploymentName: 'gpt-4o',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA' }],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithAzureOpenaiApi(port, 'CurrentQ', session)

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Hel'),
    true,
  )
  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'Hello'),
    true,
  )
  assert.equal(
    port.postedMessages.some((m) => m.done === true && m.session === session),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { done: true })
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'CurrentQ',
    answer: 'Hello',
  })
})

test('azure-openai: cleans up listeners on end', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'az-key',
    azureDeploymentName: 'gpt-4o',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithAzureOpenaiApi(port, 'Q', session)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('azure-openai: throws on error response with JSON body', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    azureEndpoint: 'https://myinstance.openai.azure.com',
    azureApiKey: 'bad-key',
    azureDeploymentName: 'gpt-4o',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'azureOpenAi',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid subscription key' } }),
    }),
  )

  await assert.rejects(
    async () => generateAnswersWithAzureOpenaiApi(port, 'Q', session),
    /invalid subscription key/,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
