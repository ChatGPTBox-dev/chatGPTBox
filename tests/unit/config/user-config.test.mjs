import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { clearOldAccessToken, getUserConfig, setAccessToken } from '../../../src/config/index.mjs'

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('getUserConfig migrates legacy chat.openai.com URL to chatgpt.com', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customChatGptWebApiUrl: 'https://chat.openai.com',
  })

  const config = await getUserConfig()

  assert.equal(config.customChatGptWebApiUrl, 'https://chatgpt.com')
})

test('getUserConfig keeps modern chatgpt.com URL unchanged', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    customChatGptWebApiUrl: 'https://chatgpt.com',
  })

  const config = await getUserConfig()

  assert.equal(config.customChatGptWebApiUrl, 'https://chatgpt.com')
})

test('getUserConfig migrates legacy Claude keys to Anthropic keys and removes old keys', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    claudeApiKey: 'legacy-key',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.anthropicApiKey, 'legacy-key')
  assert.equal(config.customAnthropicApiUrl, 'https://legacy.anthropic.example')
  assert.equal(storage.anthropicApiKey, 'legacy-key')
  assert.equal(storage.customAnthropicApiUrl, 'https://legacy.anthropic.example')
  assert.equal(Object.hasOwn(storage, 'claudeApiKey'), false)
  assert.equal(Object.hasOwn(storage, 'customClaudeApiUrl'), false)
})

test('getUserConfig prefers legacy Claude keys when both legacy and Anthropic keys exist', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    anthropicApiKey: 'new-key',
    claudeApiKey: 'legacy-key',
    customAnthropicApiUrl: 'https://new.anthropic.example',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.anthropicApiKey, 'legacy-key')
  assert.equal(config.customAnthropicApiUrl, 'https://legacy.anthropic.example')
  assert.equal(storage.anthropicApiKey, 'legacy-key')
  assert.equal(storage.customAnthropicApiUrl, 'https://legacy.anthropic.example')
  assert.equal(Object.hasOwn(storage, 'claudeApiKey'), false)
  assert.equal(Object.hasOwn(storage, 'customClaudeApiUrl'), false)
})

test('getUserConfig keeps Anthropic keys unchanged when legacy Claude keys are absent', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    anthropicApiKey: 'new-key',
    customAnthropicApiUrl: 'https://new.anthropic.example',
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.anthropicApiKey, 'new-key')
  assert.equal(config.customAnthropicApiUrl, 'https://new.anthropic.example')
  assert.equal(storage.anthropicApiKey, 'new-key')
  assert.equal(storage.customAnthropicApiUrl, 'https://new.anthropic.example')
  assert.equal(Object.hasOwn(storage, 'claudeApiKey'), false)
  assert.equal(Object.hasOwn(storage, 'customClaudeApiUrl'), false)
})

test('clearOldAccessToken clears expired token older than 30 days', async (t) => {
  const now = 1_700_000_000_000
  t.mock.method(Date, 'now', () => now)

  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    accessToken: 'stale-token',
    tokenSavedOn: now - THIRTY_DAYS_MS - 1_000,
  })

  await clearOldAccessToken()

  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.equal(storage.accessToken, '')
  // tokenSavedOn write behavior is covered in the dedicated setAccessToken test below.
})

test('setAccessToken updates tokenSavedOn to Date.now', async (t) => {
  const now = 1_700_000_000_000
  t.mock.method(Date, 'now', () => now)

  await setAccessToken('new-token')

  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.equal(storage.accessToken, 'new-token')
  assert.equal(storage.tokenSavedOn, now)
})

test('clearOldAccessToken keeps recent token within 30 days', async (t) => {
  const now = 1_700_000_000_000
  t.mock.method(Date, 'now', () => now)
  const recentSavedOn = now - THIRTY_DAYS_MS + 1_000

  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    accessToken: 'fresh-token',
    tokenSavedOn: recentSavedOn,
  })

  await clearOldAccessToken()

  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.equal(storage.accessToken, 'fresh-token')
  assert.equal(storage.tokenSavedOn, recentSavedOn)
})

test('clearOldAccessToken keeps token when exactly 30 days old', async (t) => {
  const now = 1_700_000_000_000
  t.mock.method(Date, 'now', () => now)
  const savedOn = now - THIRTY_DAYS_MS

  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    accessToken: 'boundary-token',
    tokenSavedOn: savedOn,
  })

  await clearOldAccessToken()

  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.equal(storage.accessToken, 'boundary-token')
  assert.equal(storage.tokenSavedOn, savedOn)
})
