import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  getConversationTitleConfig,
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
      itemName: 'chatgptApi35',
      apiKey: 'do-not-copy',
      active: true,
    },
  })
  const config = await getConversationTitleConfig()
  assert.equal(config.autoGenerateConversationTitle, true)
  assert.equal(config.conversationTitleApiMode.itemName, 'chatgptApi4oMini')
  assert.equal(config.conversationTitleApiMode.apiKey, '')
})
