import assert from 'node:assert/strict'
import test from 'node:test'
import Browser from 'webextension-polyfill'
import { defaultApiModeIds, defaultConfig, getUserConfig } from '../../../src/config/index.mjs'
import {
  importDataIntoStorage,
  prepareImportData,
} from '../../../src/popup/sections/import-data-cleanup.mjs'

test('prepareImportData normalizes a legacy-only backup to Anthropic keys and removes legacy keys later', () => {
  const { normalizedData, keysToRemove } = prepareImportData({
    claudeApiKey: 'legacy-key',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
  })

  assert.deepEqual(normalizedData, {
    claudeApiKey: 'legacy-key',
    anthropicApiKey: 'legacy-key',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
    customAnthropicApiUrl: 'https://legacy.anthropic.example',
  })
  assert.deepEqual(keysToRemove, ['claudeApiKey', 'customClaudeApiUrl'])
})

test('prepareImportData normalizes an Anthropic-only backup and still removes legacy keys later', () => {
  const { normalizedData, keysToRemove } = prepareImportData({
    anthropicApiKey: 'new-key',
    customAnthropicApiUrl: 'https://new.anthropic.example',
  })

  assert.deepEqual(normalizedData, {
    claudeApiKey: 'new-key',
    anthropicApiKey: 'new-key',
    customClaudeApiUrl: 'https://new.anthropic.example',
    customAnthropicApiUrl: 'https://new.anthropic.example',
  })
  assert.deepEqual(keysToRemove, ['claudeApiKey', 'customClaudeApiUrl'])
})

test('prepareImportData resolves each conflicting field pair independently', () => {
  const { normalizedData, keysToRemove } = prepareImportData({
    anthropicApiKey: 'new-key',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
  })

  assert.deepEqual(normalizedData, {
    claudeApiKey: 'new-key',
    anthropicApiKey: 'new-key',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
    customAnthropicApiUrl: 'https://legacy.anthropic.example',
  })
  assert.deepEqual(keysToRemove, ['claudeApiKey', 'customClaudeApiUrl'])
})

test('prepareImportData keeps imported values unchanged when both key families are already present', () => {
  const input = {
    anthropicApiKey: 'new-key',
    claudeApiKey: 'legacy-key',
    customAnthropicApiUrl: 'https://new.anthropic.example',
    customClaudeApiUrl: 'https://legacy.anthropic.example',
  }
  const { normalizedData, keysToRemove } = prepareImportData(input)

  assert.deepEqual(normalizedData, input)
  assert.deepEqual(keysToRemove, [])
})

test('prepareImportData leaves unrelated imports untouched', () => {
  const { normalizedData, keysToRemove } = prepareImportData({
    apiKey: 'openai-key',
  })

  assert.deepEqual(normalizedData, { apiKey: 'openai-key' })
  assert.deepEqual(keysToRemove, [])
})

test('prepareImportData migrates legacy model keys in imported config and sessions', () => {
  const { normalizedData, keysToRemove } = prepareImportData({
    modelName: 'chatgptFree4o',
    activeApiModes: ['chatgptFree4o', 'chatgptFree4oMini', 'moonshot_k2'],
    apiMode: {
      groupName: 'openRouterApiModelKeys',
      itemName: 'openRouter_deepseek_deepseek_chat_v3_0324_free',
      isCustom: false,
      customName: '',
      customUrl: '',
      apiKey: '',
      providerId: '',
      active: true,
    },
    customApiModes: [
      {
        groupName: 'aimlApiModelKeys',
        itemName: 'aiml_openai_o3_2025_04_16',
        isCustom: false,
        customName: '',
        customUrl: '',
        apiKey: '',
        providerId: '',
        active: true,
      },
    ],
    sessions: [
      {
        sessionId: 'legacy-session',
        modelName: 'claude2Api',
        apiMode: {
          groupName: 'claudeApiModelKeys',
          itemName: 'claude2Api',
          isCustom: false,
          customName: '',
          customUrl: '',
          apiKey: '',
          providerId: '',
          active: true,
        },
        conversationRecords: [{ role: 'assistant', answer: 'legacy' }],
      },
    ],
  })

  assert.equal(normalizedData.modelName, 'chatgptFree4oMini')
  assert.deepEqual(normalizedData.activeApiModes, ['chatgptFree4oMini', 'moonshot_k2_5'])
  assert.equal(normalizedData.knownApiModeDefaultIds, null)
  assert.equal(normalizedData.apiMode.itemName, 'openRouter_deepseek_v4_flash')
  assert.equal(normalizedData.customApiModes[0].groupName, 'aimlModelKeys')
  assert.equal(normalizedData.customApiModes[0].itemName, 'aiml_openai_gpt_5_5')
  assert.equal(normalizedData.sessions[0].modelName, 'claudeSonnet46Api')
  assert.equal(normalizedData.sessions[0].apiMode.itemName, 'claudeSonnet46Api')
  assert.deepEqual(normalizedData.sessions[0].conversationRecords, [
    { role: 'assistant', answer: 'legacy' },
  ])
  assert.deepEqual(keysToRemove, [])
})

test('prepareImportData atomically clears stale API mode fields missing from an old backup', () => {
  const { normalizedData, keysToRemove } = prepareImportData({
    customApiModes: [],
  })

  assert.deepEqual(normalizedData, {
    activeApiModes: null,
    customApiModes: [],
    knownApiModeDefaultIds: null,
  })
  assert.deepEqual(keysToRemove, ['modelName', 'apiMode'])
})

test('prepareImportData canonicalizes a stored API mode default baseline', () => {
  const { normalizedData } = prepareImportData({
    activeApiModes: [],
    customApiModes: [],
    knownApiModeDefaultIds: [null, ' chatgptFree4o ', 'chatgptFree4oMini'],
  })

  assert.deepEqual(normalizedData.knownApiModeDefaultIds, ['chatgptFree4oMini'])
})

test('importDataIntoStorage writes normalized data before removing legacy keys', async () => {
  const calls = []
  const storageArea = {
    async set(data) {
      calls.push(['set', data])
    },
    async remove(keys) {
      calls.push(['remove', keys])
    },
  }

  await importDataIntoStorage(storageArea, {
    claudeApiKey: 'legacy-key',
  })

  assert.deepEqual(calls, [
    ['set', { claudeApiKey: 'legacy-key', anthropicApiKey: 'legacy-key' }],
    ['remove', ['claudeApiKey']],
  ])
})

test('importDataIntoStorage replaces stale API mode state before legacy migration', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    configSchemaVersion: 2,
    activeApiModes: [],
    customApiModes: [{ itemName: 'stale-mode' }],
    knownApiModeDefaultIds: ['stale-default'],
    modelName: 'stale-model',
    apiMode: { itemName: 'stale-mode' },
  })

  await importDataIntoStorage(Browser.storage.local, {
    configSchemaVersion: 1,
    customApiModes: [],
  })
  const importedStorage = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.equal(importedStorage.activeApiModes, null)
  assert.equal(importedStorage.knownApiModeDefaultIds, null)
  assert.equal(Object.hasOwn(importedStorage, 'modelName'), false)
  assert.equal(Object.hasOwn(importedStorage, 'apiMode'), false)

  const config = await getUserConfig()
  const migratedStorage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.deepEqual(config.activeApiModes, defaultApiModeIds)
  assert.equal(config.modelName, defaultConfig.modelName)
  assert.equal(config.apiMode, null)
  assert.equal(Object.hasOwn(migratedStorage, 'activeApiModes'), false)
  assert.equal(Object.hasOwn(migratedStorage, 'knownApiModeDefaultIds'), false)
})

test('importDataIntoStorage does not remove existing keys when set fails', async () => {
  const calls = []
  const storageArea = {
    async set() {
      calls.push(['set'])
      throw new Error('quota exceeded')
    },
    async remove(keys) {
      calls.push(['remove', keys])
    },
  }

  await assert.rejects(async () => {
    await importDataIntoStorage(storageArea, {
      claudeApiKey: 'legacy-key',
    })
  }, /quota exceeded/)

  assert.deepEqual(calls, [['set']])
})

test('importDataIntoStorage leaves normalized values in storage when remove fails after set', async () => {
  const storageState = {}
  const storageArea = {
    async set(data) {
      Object.assign(storageState, data)
    },
    async remove() {
      throw new Error('remove failed')
    },
  }

  await assert.rejects(async () => {
    await importDataIntoStorage(storageArea, {
      anthropicApiKey: 'new-key',
    })
  }, /remove failed/)

  assert.deepEqual(storageState, {
    claudeApiKey: 'new-key',
    anthropicApiKey: 'new-key',
  })
})
