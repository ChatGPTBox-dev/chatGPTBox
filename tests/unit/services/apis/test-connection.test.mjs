import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { testConnection } from '../../../../src/services/apis/test-connection.mjs'

const ENDPOINT = 'https://api.example.com/v1/chat/completions'

const MODE = {
  groupName: 'customApiModelKeys',
  itemName: 'customModel',
  isCustom: true,
  customName: 'my-model',
  providerId: 'test-provider',
  customUrl: '',
}

function captureFetch(t) {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url, options, body: JSON.parse(options.body) })
    return { ok: true, status: 200, text: async () => '' }
  })
  return seen
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customOpenAIProviders: [
      { id: 'test-provider', name: 'Test provider', chatCompletionsUrl: ENDPOINT },
    ],
    providerSecrets: { 'test-provider': 'secret-key' },
  })
})

test('a reachable mode reports success and pings the resolved endpoint', async (t) => {
  let seen
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen = { url, body: JSON.parse(options.body) }
    return { ok: true, status: 200, text: async () => '' }
  })

  const result = await testConnection({ apiMode: MODE })

  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(typeof result.elapsedMs, 'number')
  assert.equal(seen.url, ENDPOINT)
  assert.equal(seen.body.model, 'my-model')
  assert.equal(seen.body.stream, false)
})

test('a rejected request surfaces the status and the provider message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":"invalid api key"}',
  }))

  const result = await testConnection({ apiMode: MODE })

  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.match(result.error, /invalid api key/)
})

test('a transport failure is reported instead of thrown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down')
  })

  const result = await testConnection({ apiMode: MODE })

  assert.equal(result.ok, false)
  assert.equal(result.status, undefined)
  assert.equal(result.error, 'network down')
})

test('a mode whose provider cannot be resolved is reported, not thrown', async () => {
  const result = await testConnection({
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'my-model',
      providerId: 'missing-provider',
      customUrl: '',
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'unresolved-provider')
})

test('the custom model on the General tab resolves its own URL and name', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customModelApiUrl: 'https://custom.example.com/v1/chat/completions',
    customModelName: 'my-custom-model',
    customApiKey: 'custom-key',
  })

  let seen
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) }
    return { ok: true, status: 200, text: async () => '' }
  })

  const result = await testConnection({ modelName: 'customModel' })

  assert.equal(result.ok, true)
  assert.equal(seen.url, 'https://custom.example.com/v1/chat/completions')
  assert.equal(seen.body.model, 'my-custom-model')
  assert.equal(seen.options.headers.Authorization, 'Bearer custom-key')
})

test('the configured extra request body is merged into the probe', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customOpenAIProviders: [
      { id: 'test-provider', name: 'Test provider', chatCompletionsUrl: ENDPOINT },
    ],
    providerSecrets: { 'test-provider': 'secret-key' },
    extraBody: '{"reasoning_effort":"high","stream":true,"max_tokens":99}',
  })
  const seen = captureFetch(t)

  const result = await testConnection({ apiMode: MODE })

  assert.equal(result.ok, true)
  assert.equal(seen[0].body.reasoning_effort, 'high')
  assert.equal(seen[0].body.max_tokens, 99)
  // A probe never streams, even when the extra body asks for it.
  assert.equal(seen[0].body.stream, false)
})

test('a completion mode is probed with the completion request shape', async (t) => {
  const seen = captureFetch(t)

  const result = await testConnection({
    apiMode: { groupName: 'gptApiModelKeys', itemName: 'gptApiInstruct', isCustom: false },
  })

  assert.equal(result.ok, true)
  assert.equal(seen[0].url, 'https://api.openai.com/v1/completions')
  assert.equal(typeof seen[0].body.prompt, 'string')
  assert.equal(seen[0].body.messages, undefined)
  assert.equal(seen[0].body.max_tokens, 1)
})

test('an OpenAI-derived custom provider is probed with OpenAI request shaping', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customOpenAIProviders: [
      {
        id: 'test-provider',
        name: 'Test provider',
        baseUrl: 'https://api.openai.com',
        sourceProviderId: 'openai',
      },
    ],
    providerSecrets: { 'test-provider': 'secret-key' },
  })
  const seen = captureFetch(t)

  const result = await testConnection({
    apiMode: { ...MODE, customName: 'gpt-5' },
  })

  assert.equal(result.ok, true)
  assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(seen[0].body.max_completion_tokens, 1)
  assert.equal(seen[0].body.max_tokens, undefined)
})

test('an Azure mode is probed with its deployment URL and api-key header', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    azureApiKey: 'azure-key',
    azureEndpoint: 'https://example.openai.azure.com/',
    azureDeploymentName: 'my-deployment',
    extraBody: '{"reasoning_effort":"high"}',
  })
  const seen = captureFetch(t)

  const result = await testConnection({
    apiMode: { groupName: 'azureOpenAiApiModelKeys', itemName: 'azureOpenAi', isCustom: false },
  })

  assert.equal(result.ok, true)
  assert.equal(
    seen[0].url,
    'https://example.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-02-01',
  )
  assert.equal(seen[0].options.headers['api-key'], 'azure-key')
  assert.equal(seen[0].body.reasoning_effort, 'high')
  assert.equal(seen[0].body.stream, false)
})

test('an Anthropic mode is probed with the messages endpoint and its headers', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    anthropicApiKey: 'anthropic-key',
    customAnthropicApiUrl: 'https://api.anthropic.com',
  })
  const seen = captureFetch(t)

  const result = await testConnection({
    apiMode: {
      groupName: 'claudeApiModelKeys',
      itemName: 'claudeSonnet5Api',
      isCustom: false,
    },
  })

  assert.equal(result.ok, true)
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(seen[0].options.headers['x-api-key'], 'anthropic-key')
  assert.equal(seen[0].body.model, 'claude-sonnet-5')
  assert.deepEqual(seen[0].body.thinking, { type: 'disabled' })
  assert.equal(seen[0].body.stream, false)
})

test('a cookie/web mode is not probed and reports it as unsupported', async (t) => {
  const seen = captureFetch(t)

  const result = await testConnection({
    apiMode: { groupName: 'chatgptWebModelKeys', itemName: 'chatgptPlus4', isCustom: false },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'unsupported-provider')
  assert.equal(seen.length, 0)
})

test('a native Ollama chat endpoint is reported instead of probed', async (t) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customOpenAIProviders: [
      {
        id: 'test-provider',
        name: 'Test provider',
        chatCompletionsUrl: 'http://127.0.0.1:11434/api/chat',
      },
    ],
    providerSecrets: { 'test-provider': 'secret-key' },
  })
  const seen = captureFetch(t)

  const result = await testConnection({ apiMode: MODE })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'unsupported-provider')
  assert.equal(seen.length, 0)
})

test('a redirected probe is reported as unreachable instead of followed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    type: 'opaqueredirect',
    ok: false,
    status: 0,
    text: async () => '',
  }))

  const result = await testConnection({ apiMode: MODE })

  assert.equal(result.ok, false)
  assert.match(result.error, /redirect/i)
})
