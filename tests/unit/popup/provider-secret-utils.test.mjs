import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProviderSecretUpdate } from '../../../src/popup/sections/provider-secret-utils.mjs'

function createCustomApiMode(overrides = {}) {
  return {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'custom-model',
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
    ...overrides,
  }
}

test('buildProviderSecretUpdate returns empty object for empty providerId', () => {
  assert.deepEqual(buildProviderSecretUpdate({}, '', 'key'), {})
})

test('buildProviderSecretUpdate sets providerSecrets and legacy field for builtin provider', () => {
  const config = { providerSecrets: {} }
  const result = buildProviderSecretUpdate(config, 'openai', 'sk-new')

  assert.equal(result.providerSecrets.openai, 'sk-new')
  assert.equal(result.apiKey, 'sk-new')
})

test('buildProviderSecretUpdate sets only providerSecrets for custom provider without legacy field', () => {
  const config = { providerSecrets: {} }
  const result = buildProviderSecretUpdate(config, 'my-custom-provider', 'sk-custom')

  assert.equal(result.providerSecrets['my-custom-provider'], 'sk-custom')
  assert.equal(result.apiKey, undefined)
})

test('buildProviderSecretUpdate clears inherited mode-level keys matching old provider secret', () => {
  const config = {
    providerSecrets: { myproxy: 'old-key' },
    modelName: 'chatgptApi4oMini',
    customApiModes: [
      createCustomApiMode({ providerId: 'myproxy', apiKey: 'old-key', customName: 'mode-a' }),
      createCustomApiMode({ providerId: 'myproxy', apiKey: 'unique-key', customName: 'mode-b' }),
    ],
  }
  const result = buildProviderSecretUpdate(config, 'myproxy', 'new-key')

  const modeA = result.customApiModes.find((m) => m.customName === 'mode-a')
  assert.equal(modeA.apiKey, '', 'inherited key should be cleared')
  const modeB = result.customApiModes.find((m) => m.customName === 'mode-b')
  assert.equal(
    modeB.apiKey,
    'unique-key',
    'non-inherited non-selected mode key should be unchanged',
  )
})

test('buildProviderSecretUpdate clears selected mode inherited key in config.apiMode', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'old-key',
    customName: 'selected',
  })
  const config = {
    providerSecrets: { myproxy: 'old-key' },
    apiMode: selectedMode,
    modelName: 'chatgptApi4oMini',
    customApiModes: [],
  }
  const result = buildProviderSecretUpdate(config, 'myproxy', 'new-key')

  assert.equal(result.apiMode.apiKey, '', 'selected mode inherited key should be cleared')
})

test('buildProviderSecretUpdate syncs selected mode custom key to new value', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'custom-mode-key',
    customName: 'selected',
  })
  const config = {
    providerSecrets: { myproxy: 'different-old-key' },
    apiMode: selectedMode,
    modelName: 'chatgptApi4oMini',
    customApiModes: [selectedMode],
  }
  const result = buildProviderSecretUpdate(config, 'myproxy', 'new-key')

  assert.equal(result.apiMode.apiKey, 'new-key')
  const syncedMode = result.customApiModes.find((m) => m.customName === 'selected')
  assert.equal(syncedMode.apiKey, 'new-key')
})

test('buildProviderSecretUpdate does not modify modes for unrelated providers', () => {
  const config = {
    providerSecrets: {},
    customApiModes: [
      createCustomApiMode({
        providerId: 'other-provider',
        apiKey: 'other-key',
        customName: 'unrelated',
      }),
    ],
  }
  const result = buildProviderSecretUpdate(config, 'myproxy', 'new-key')

  assert.equal(
    result.customApiModes,
    undefined,
    'customApiModes should not be in payload when unchanged',
  )
})
