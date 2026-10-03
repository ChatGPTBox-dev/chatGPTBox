import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  getConversationTitleConfig,
  isConversationTitleConfigLoadCurrent,
  setConversationTitleConfig,
} from '../../../src/hooks/use-conversation-title-config.mjs'

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('title generation is disabled and has no model by default', async () => {
  assert.deepEqual(await getConversationTitleConfig(), {
    autoGenerateConversationTitle: false,
    conversationTitleApiMode: null,
  })
})

test('persists only the model reference and strips copied API keys', async () => {
  await setConversationTitleConfig({
    autoGenerateConversationTitle: true,
    conversationTitleApiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'chatgptApi4oMini',
      isCustom: false,
      customName: '',
      customUrl: '',
      apiKey: 'do-not-copy',
      providerId: '',
      active: true,
    },
  })
  const config = await getConversationTitleConfig()
  assert.equal(config.autoGenerateConversationTitle, true)
  assert.equal(config.conversationTitleApiMode.itemName, 'chatgptApi4oMini')
  assert.equal(config.conversationTitleApiMode.apiKey, '')
})

test('loading normalizes legacy data without writing the stale snapshot back', async () => {
  const storedMode = {
    groupName: 'chatgptApiModelKeys',
    itemName: 'chatgptApi4oMini',
    apiKey: 'legacy-copy',
    active: true,
  }
  globalThis.__TEST_BROWSER_SHIM__.setStorage({
    autoGenerateConversationTitle: true,
    conversationTitleApiMode: storedMode,
  })

  const loaded = await getConversationTitleConfig()
  const rawStorage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(loaded.conversationTitleApiMode.apiKey, '')
  assert.equal(rawStorage.conversationTitleApiMode.apiKey, 'legacy-copy')
})

test('a storage update invalidates an older initial-load revision', () => {
  assert.equal(isConversationTitleConfigLoadCurrent(0, 0), true)
  assert.equal(isConversationTitleConfigLoadCurrent(0, 1), false)
  assert.equal(isConversationTitleConfigLoadCurrent(2, 2), true)
})
