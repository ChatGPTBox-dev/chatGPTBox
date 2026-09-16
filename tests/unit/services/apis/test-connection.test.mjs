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
