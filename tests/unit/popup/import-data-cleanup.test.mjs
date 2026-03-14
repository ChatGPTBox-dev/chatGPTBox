import assert from 'node:assert/strict'
import test from 'node:test'
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
