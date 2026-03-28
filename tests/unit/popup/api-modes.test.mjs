import assert from 'node:assert/strict'
import test from 'node:test'
import {
  shouldHandleSavedConversationStorageChange,
  shouldRenderApiModeRow,
} from '../../../src/popup/sections/api-modes-provider-utils.mjs'

test('shouldHandleSavedConversationStorageChange only accepts local sessions updates', () => {
  assert.equal(
    shouldHandleSavedConversationStorageChange({ sessions: { newValue: [] } }, 'local'),
    true,
  )
  assert.equal(
    shouldHandleSavedConversationStorageChange({ sessions: { newValue: [] } }, 'sync'),
    false,
  )
  assert.equal(
    shouldHandleSavedConversationStorageChange({ other: { newValue: [] } }, 'local'),
    false,
  )
  assert.equal(shouldHandleSavedConversationStorageChange(null, 'local'), false)
})

test('shouldRenderApiModeRow keeps AlwaysCustomGroups modes even when itemName is empty', () => {
  assert.equal(
    shouldRenderApiModeRow({
      groupName: 'ollamaApiModelKeys',
      itemName: '',
      customName: 'llama3.2',
    }),
    true,
  )
  assert.equal(
    shouldRenderApiModeRow({
      groupName: 'azureOpenAiApiModelKeys',
      itemName: '',
      customName: 'azure-deploy',
    }),
    true,
  )
  assert.equal(
    shouldRenderApiModeRow({
      groupName: 'chatgptApi',
      itemName: '',
      customName: 'gpt-5.4-mini',
    }),
    false,
  )
})
