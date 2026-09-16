import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { testApiModeConnection } from '../../../../src/services/apis/test-connection.mjs'

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

  const result = await testApiModeConnection(MODE)

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

  const result = await testApiModeConnection(MODE)

  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.match(result.error, /invalid api key/)
})

test('a transport failure is reported instead of thrown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down')
  })

  const result = await testApiModeConnection(MODE)

  assert.equal(result.ok, false)
  assert.equal(result.status, undefined)
  assert.equal(result.error, 'network down')
})

test('a mode whose provider cannot be resolved is reported, not thrown', async () => {
  const result = await testApiModeConnection({
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'my-model',
    providerId: 'missing-provider',
    customUrl: '',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'unresolved-provider')
})
