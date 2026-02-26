import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyProviderSecretOverrideSessionMigration,
  buildSelectionPreservingConfigUpdate,
  buildSelectedModeProviderSecretOverrideUpdate,
  buildProviderSecretUpdate,
  createProviderSecretDraftCommitSignature,
  createProviderSecretOverrideCommitSelectionSignature,
  hasSelectedModeOwnProviderSecretOverride,
  resolveProviderSecretTargetId,
  rollbackProviderSecretOverrideSessionMigration,
} from '../../../src/popup/sections/provider-secret-utils.mjs'
import { getConfiguredCustomApiModesForSessionRecovery } from '../../../src/popup/sections/api-modes-provider-utils.mjs'

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

function createSession(apiModeOverrides = {}) {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2)}`,
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'custom-model',
      providerId: 'myproxy',
      apiKey: 'session-key',
      ...apiModeOverrides,
    },
    conversationRecords: [],
  }
}

test('buildProviderSecretUpdate returns empty object for empty providerId', () => {
  assert.deepEqual(buildProviderSecretUpdate({}, '', 'key'), {})
})

test('buildProviderSecretUpdate returns empty object for whitespace providerId', () => {
  assert.deepEqual(buildProviderSecretUpdate({}, '   ', 'key'), {})
})

test('buildProviderSecretUpdate sets providerSecrets and legacy field for builtin provider', () => {
  const config = { providerSecrets: {} }
  const result = buildProviderSecretUpdate(config, 'openai', 'sk-new')

  assert.equal(result.providerSecrets.openai, 'sk-new')
  assert.equal(result.apiKey, 'sk-new')
})

test('buildProviderSecretUpdate trims provider secrets before persisting', () => {
  const config = { providerSecrets: {} }
  const result = buildProviderSecretUpdate(config, 'openai', '  sk-new\n')

  assert.equal(result.providerSecrets.openai, 'sk-new')
  assert.equal(result.apiKey, 'sk-new')
})

test('buildProviderSecretUpdate sets only providerSecrets for custom provider without legacy field', () => {
  const config = { providerSecrets: {} }
  const result = buildProviderSecretUpdate(config, 'my-custom-provider', 'sk-custom')

  assert.equal(result.providerSecrets['my-custom-provider'], 'sk-custom')
  assert.equal(result.apiKey, undefined)
})

test('buildProviderSecretUpdate ignores string-shaped providerSecrets', () => {
  const config = { providerSecrets: 'leaked' }
  const result = buildProviderSecretUpdate(config, 'my-custom-provider', 'sk-custom')

  assert.deepEqual(result.providerSecrets, {
    'my-custom-provider': 'sk-custom',
  })
})

test('buildProviderSecretUpdate ignores array-shaped providerSecrets', () => {
  const config = { providerSecrets: ['leaked-key'] }
  const result = buildProviderSecretUpdate(config, 'my-custom-provider', 'sk-custom')

  assert.deepEqual(result.providerSecrets, {
    'my-custom-provider': 'sk-custom',
  })
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

test('buildProviderSecretUpdate clears selected mode custom key when shared secret changes', () => {
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

  assert.equal(result.providerSecrets.myproxy, 'new-key')
  assert.equal(result.apiMode.apiKey, '')
  const syncedMode = result.customApiModes.find((m) => m.customName === 'selected')
  assert.equal(syncedMode.apiKey, '')
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

test('resolveProviderSecretTargetId prefers secretProviderId over providerId', () => {
  assert.equal(
    resolveProviderSecretTargetId({
      providerId: 'legacy-custom-default',
      secretProviderId: 'missing-provider',
    }),
    'missing-provider',
  )
})

test('resolveProviderSecretTargetId falls back to providerId when secretProviderId is absent', () => {
  assert.equal(
    resolveProviderSecretTargetId({
      providerId: 'openai',
    }),
    'openai',
  )
})

test('buildSelectedModeProviderSecretOverrideUpdate clears orphaned recovered mode key by secret target id', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'missing-provider',
    apiKey: 'mode-override-key',
    customName: 'selected',
  })
  const config = {
    providerSecrets: { 'missing-provider': 'shared-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'missing-provider',
    '',
    {
      id: 'legacy-custom-default',
      name: 'Legacy Custom Provider',
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
    [],
  )

  assert.equal(result.configUpdate.apiMode.providerId, 'missing-provider')
  assert.equal(result.configUpdate.apiMode.apiKey, '')
  assert.equal(result.configUpdate.providerSecrets, undefined)
  assert.equal(result.sessionMigration.fromProviderId, 'missing-provider')
  assert.equal(result.sessionMigration.toProviderId, 'missing-provider')
})

test('buildSelectedModeProviderSecretOverrideUpdate does not treat builtin legacy key as inherited for recovered proxy source', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'openai',
    apiKey: '',
    customName: 'selected',
  })
  const config = {
    apiKey: 'builtin-key',
    providerSecrets: {},
    apiMode: selectedMode,
    customApiModes: [selectedMode],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'openai',
    'builtin-key',
    {
      id: 'openai',
      sourceProviderId: 'openai',
      name: 'Recovered Proxy',
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      baseUrl: '',
      chatCompletionsPath: '',
      completionsUrl: '',
      completionsPath: '',
    },
    [],
  )

  assert.ok(
    Array.isArray(result.configUpdate.customOpenAIProviders),
    'recovered proxy override should still materialize a dedicated provider',
  )
  assert.equal(result.configUpdate.apiMode.sourceProviderId, 'openai')
})

test('hasSelectedModeOwnProviderSecretOverride returns true for selected custom mode override', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'custom-mode-key',
    customName: 'selected',
  })
  const config = {
    providerSecrets: { myproxy: 'shared-key' },
    apiMode: selectedMode,
  }

  assert.equal(hasSelectedModeOwnProviderSecretOverride(config, 'myproxy'), true)
})

test('hasSelectedModeOwnProviderSecretOverride returns false for inherited selected mode key', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'shared-key',
    customName: 'selected',
  })
  const config = {
    providerSecrets: { myproxy: 'shared-key' },
    apiMode: selectedMode,
  }

  assert.equal(hasSelectedModeOwnProviderSecretOverride(config, 'myproxy'), false)
})

test('hasSelectedModeOwnProviderSecretOverride returns true for materialized override provider', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'selected-mode-2',
    apiKey: '',
    customName: 'selected',
    sourceProviderId: 'myproxy',
  })
  const config = {
    providerSecrets: { 'selected-mode-2': 'materialized-key' },
    apiMode: selectedMode,
  }

  assert.equal(hasSelectedModeOwnProviderSecretOverride(config, 'selected-mode-2'), true)
})

test('createProviderSecretDraftCommitSignature changes when resolved base URL changes', () => {
  const signatureA = createProviderSecretDraftCommitSignature({
    providerId: 'openai',
    currentApiKey: 'sk-current',
    nextApiKey: 'sk-next',
    resolvedOpenAiApiUrl: 'https://api.openai.com',
    hasModeOverride: false,
  })
  const signatureB = createProviderSecretDraftCommitSignature({
    providerId: 'openai',
    currentApiKey: 'sk-current',
    nextApiKey: 'sk-next',
    resolvedOpenAiApiUrl: 'https://api.example.com',
    hasModeOverride: false,
  })

  assert.notEqual(signatureA, signatureB)
})

test('createProviderSecretDraftCommitSignature normalizes equivalent values', () => {
  const signatureA = createProviderSecretDraftCommitSignature({
    providerId: ' openai ',
    currentApiKey: ' sk-current ',
    nextApiKey: ' sk-next ',
    resolvedOpenAiApiUrl: 'https://api.openai.com/',
    hasModeOverride: true,
  })
  const signatureB = createProviderSecretDraftCommitSignature({
    providerId: 'openai',
    currentApiKey: 'sk-current',
    nextApiKey: 'sk-next',
    resolvedOpenAiApiUrl: 'https://api.openai.com',
    hasModeOverride: true,
  })

  assert.equal(signatureA, signatureB)
})

test('buildSelectionPreservingConfigUpdate keeps apiMode when current selection should be updated', () => {
  const configUpdate = {
    apiMode: createCustomApiMode({ providerId: 'selected-mode-2', customName: 'selected-mode' }),
    providerSecrets: { 'selected-mode-2': 'override-key' },
  }

  assert.deepEqual(buildSelectionPreservingConfigUpdate(configUpdate, false), configUpdate)
})

test('buildSelectionPreservingConfigUpdate removes apiMode when preserving current selection', () => {
  const configUpdate = {
    apiMode: createCustomApiMode({ providerId: 'selected-mode-2', customName: 'selected-mode' }),
    providerSecrets: { 'selected-mode-2': 'override-key' },
    customApiModes: [createCustomApiMode({ providerId: 'selected-mode-2' })],
  }

  const result = buildSelectionPreservingConfigUpdate(configUpdate, true)

  assert.equal('apiMode' in result, false)
  assert.deepEqual(result.providerSecrets, { 'selected-mode-2': 'override-key' })
  assert.equal(result.customApiModes.length, 1)
})

test('buildSelectedModeProviderSecretOverrideUpdate migrates sessions when clearing legacy inline override', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'legacy-inline-key',
    customName: 'selected',
  })
  const config = {
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [
      { id: 'myproxy', name: 'My Proxy', baseUrl: 'https://api.example.com' },
    ],
    providerSecrets: {},
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(config, 'myproxy', '')

  assert.deepEqual(result.sessionMigration, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'selected',
      providerId: 'myproxy',
    },
    fromProviderId: 'myproxy',
    toProviderId: 'myproxy',
  })
  assert.equal(result.cleanupCandidateProviderId, '')
})

test('applyProviderSecretOverrideSessionMigration clears session apiKey when reverting legacy inline override', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'legacy-inline-key',
    customName: 'selected',
  })
  const config = {
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [
      { id: 'myproxy', name: 'My Proxy', baseUrl: 'https://api.example.com' },
    ],
    providerSecrets: {},
  }
  const migration = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'myproxy',
    '',
  ).sessionMigration
  const sessions = [
    createSession({ providerId: 'myproxy', apiKey: 'legacy-session-key', customName: 'selected' }),
    createSession({ providerId: 'myproxy', apiKey: 'other-session-key', customName: 'other' }),
  ]

  const migratedSessions = applyProviderSecretOverrideSessionMigration(sessions, migration)

  assert.equal(migratedSessions[0].apiMode.providerId, 'myproxy')
  assert.equal(migratedSessions[0].apiMode.apiKey, '')
  assert.equal('sourceProviderId' in migratedSessions[0].apiMode, false)
  assert.equal(migratedSessions[1].apiMode.apiKey, 'other-session-key')
})

test('createProviderSecretOverrideCommitSelectionSignature changes when selection changes', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'provider-a',
    customName: 'selected-mode',
  })

  const signatureA = createProviderSecretOverrideCommitSelectionSignature(
    'provider-a',
    selectedMode,
  )
  const signatureB = createProviderSecretOverrideCommitSelectionSignature(
    'provider-b',
    selectedMode,
  )

  assert.notEqual(signatureA, signatureB)
})

test('createProviderSecretOverrideCommitSelectionSignature normalizes equivalent values', () => {
  const signatureA = createProviderSecretOverrideCommitSelectionSignature(
    ' provider-a ',
    createCustomApiMode({
      providerId: 'provider-a',
      customName: ' selected-mode ',
      itemName: ' customModel ',
    }),
  )
  const signatureB = createProviderSecretOverrideCommitSelectionSignature(
    'provider-a',
    createCustomApiMode({
      providerId: 'provider-a',
      customName: 'selected-mode',
      itemName: 'customModel',
    }),
  )

  assert.equal(signatureA, signatureB)
})

test('getConfiguredCustomApiModesForSessionRecovery keeps inactive and standalone custom modes', () => {
  const inactiveMode = createCustomApiMode({
    providerId: 'materialized-provider',
    customName: 'inactive-mode',
    active: false,
  })
  const standaloneSelectedMode = createCustomApiMode({
    providerId: 'materialized-provider',
    customName: 'selected-mode',
  })

  const result = getConfiguredCustomApiModesForSessionRecovery(
    [inactiveMode],
    standaloneSelectedMode,
  )

  assert.equal(result.length, 2)
  assert.equal(
    result.some((apiMode) => apiMode.customName === 'inactive-mode'),
    true,
  )
  assert.equal(
    result.some((apiMode) => apiMode.customName === 'selected-mode'),
    true,
  )
})

test('buildSelectedModeProviderSecretOverrideUpdate materializes a dedicated provider', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'custom-mode-key',
    customName: 'selected-mode',
  })
  const sourceProvider = {
    id: 'myproxy',
    name: 'Shared Provider',
    baseUrl: 'https://api.example.com',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/v1/completions',
    chatCompletionsUrl: 'https://api.example.com/v1/chat/completions',
    completionsUrl: 'https://api.example.com/v1/completions',
    enabled: true,
    allowLegacyResponseField: true,
  }
  const config = {
    providerSecrets: { myproxy: 'shared-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [sourceProvider],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'myproxy',
    'new-mode-key',
    sourceProvider,
    config.customOpenAIProviders,
  )

  assert.equal(result.configUpdate.customOpenAIProviders.length, 2)
  const materializedProvider = result.configUpdate.customOpenAIProviders[1]
  assert.notEqual(materializedProvider.id, 'myproxy')
  assert.equal(materializedProvider.name, 'Shared Provider (selected-mode)')
  assert.equal(materializedProvider.sourceProviderId, 'myproxy')
  assert.equal(result.configUpdate.providerSecrets[materializedProvider.id], 'new-mode-key')
  assert.equal(result.configUpdate.apiMode.providerId, materializedProvider.id)
  assert.equal(result.configUpdate.apiMode.apiKey, '')
  assert.equal(result.configUpdate.apiMode.sourceProviderId, 'myproxy')
  const migratedMode = result.configUpdate.customApiModes.find(
    (m) => m.customName === 'selected-mode',
  )
  assert.equal(migratedMode.providerId, materializedProvider.id)
  assert.equal(migratedMode.apiKey, '')
  assert.equal(migratedMode.sourceProviderId, 'myproxy')
  assert.equal(result.configUpdate.providerSecrets.myproxy, 'shared-key')
  assert.equal(result.sessionMigration.fromProviderId, 'myproxy')
  assert.equal(result.sessionMigration.toProviderId, materializedProvider.id)
})

test('buildSelectedModeProviderSecretOverrideUpdate trims override secrets before persisting', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'custom-mode-key',
    customName: 'selected-mode',
  })
  const sourceProvider = {
    id: 'myproxy',
    name: 'Shared Provider',
    baseUrl: 'https://api.example.com',
  }
  const config = {
    providerSecrets: { myproxy: 'shared-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [sourceProvider],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'myproxy',
    '  new-mode-key\n',
    sourceProvider,
    config.customOpenAIProviders,
  )

  const materializedProvider = result.configUpdate.customOpenAIProviders[1]
  assert.equal(result.configUpdate.providerSecrets[materializedProvider.id], 'new-mode-key')
})

test('buildSelectedModeProviderSecretOverrideUpdate ignores malformed providerSecrets when materializing', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'custom-mode-key',
    customName: 'selected-mode',
  })
  const sourceProvider = {
    id: 'myproxy',
    name: 'Shared Provider',
    baseUrl: 'https://api.example.com',
  }
  const config = {
    providerSecrets: ['leaked-key'],
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [sourceProvider],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'myproxy',
    'new-mode-key',
    sourceProvider,
    config.customOpenAIProviders,
  )

  const materializedProvider = result.configUpdate.customOpenAIProviders[1]
  assert.deepEqual(result.configUpdate.providerSecrets, {
    [materializedProvider.id]: 'new-mode-key',
  })
})

test('buildSelectedModeProviderSecretOverrideUpdate clears override when next key is inherited', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'myproxy',
    apiKey: 'custom-mode-key',
    customName: 'selected-mode',
  })
  const config = {
    providerSecrets: { myproxy: 'shared-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'myproxy',
    'shared-key',
    null,
    [],
  )

  assert.equal(result.configUpdate.customOpenAIProviders, undefined)
  assert.equal(result.configUpdate.providerSecrets, undefined)
  assert.equal(result.configUpdate.apiMode.providerId, 'myproxy')
  assert.equal(result.configUpdate.apiMode.apiKey, '')
  const migratedMode = result.configUpdate.customApiModes.find(
    (m) => m.customName === 'selected-mode',
  )
  assert.equal(migratedMode.providerId, 'myproxy')
  assert.equal(migratedMode.apiKey, '')
  assert.deepEqual(result.sessionMigration, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'selected-mode',
      providerId: 'myproxy',
    },
    fromProviderId: 'myproxy',
    toProviderId: 'myproxy',
  })
})

test('buildSelectedModeProviderSecretOverrideUpdate clears a materialized override back to source provider', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'selected-mode-2',
    apiKey: '',
    customName: 'selected-mode',
    sourceProviderId: 'myproxy',
  })
  const sourceProvider = {
    id: 'myproxy',
    name: 'Shared Provider',
  }
  const materializedProvider = {
    id: 'selected-mode-2',
    name: 'Shared Provider (selected-mode)',
  }
  const config = {
    providerSecrets: { myproxy: 'shared-key', 'selected-mode-2': 'override-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [sourceProvider, materializedProvider],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'selected-mode-2',
    '',
    materializedProvider,
    config.customOpenAIProviders,
  )

  assert.equal(result.configUpdate.apiMode.providerId, 'myproxy')
  assert.equal(result.configUpdate.apiMode.apiKey, '')
  assert.equal('sourceProviderId' in result.configUpdate.apiMode, false)
  const revertedMode = result.configUpdate.customApiModes.find(
    (m) => m.customName === 'selected-mode',
  )
  assert.equal(revertedMode.providerId, 'myproxy')
  assert.equal(revertedMode.apiKey, '')
  assert.equal('sourceProviderId' in revertedMode, false)
  assert.equal(result.configUpdate.providerSecrets, undefined)
  assert.equal(result.configUpdate.customOpenAIProviders, undefined)
  assert.equal(result.sessionMigration.fromProviderId, 'selected-mode-2')
  assert.equal(result.sessionMigration.toProviderId, 'myproxy')
  assert.equal(result.cleanupCandidateProviderId, 'selected-mode-2')
})

test('buildSelectedModeProviderSecretOverrideUpdate reverts materialized override when next key matches shared provider secret', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'selected-mode-2',
    apiKey: '',
    customName: 'selected-mode',
    sourceProviderId: 'myproxy',
  })
  const config = {
    providerSecrets: { myproxy: 'shared-key', 'selected-mode-2': 'override-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [
      { id: 'myproxy', name: 'Shared Provider' },
      { id: 'selected-mode-2', name: 'Shared Provider (selected-mode)' },
    ],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'selected-mode-2',
    'shared-key',
    null,
    config.customOpenAIProviders,
  )

  assert.equal(result.configUpdate.apiMode.providerId, 'myproxy')
  assert.equal(result.cleanupCandidateProviderId, 'selected-mode-2')
})

test('buildSelectedModeProviderSecretOverrideUpdate updates materialized provider secret without re-materializing', () => {
  const selectedMode = createCustomApiMode({
    providerId: 'selected-mode-2',
    apiKey: '',
    customName: 'selected-mode',
    sourceProviderId: 'myproxy',
  })
  const materializedProvider = {
    id: 'selected-mode-2',
    name: 'Shared Provider (selected-mode)',
  }
  const config = {
    providerSecrets: { myproxy: 'shared-key', 'selected-mode-2': 'override-key' },
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    customOpenAIProviders: [{ id: 'myproxy', name: 'Shared Provider' }, materializedProvider],
  }

  const result = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'selected-mode-2',
    'updated-override-key',
    materializedProvider,
    config.customOpenAIProviders,
  )

  assert.equal(result.configUpdate.customOpenAIProviders, undefined)
  assert.equal(result.configUpdate.apiMode.providerId, 'selected-mode-2')
  assert.equal(result.configUpdate.apiMode.sourceProviderId, 'myproxy')
  assert.equal(result.configUpdate.providerSecrets['selected-mode-2'], 'updated-override-key')
  const updatedMode = result.configUpdate.customApiModes.find(
    (m) => m.customName === 'selected-mode',
  )
  assert.equal(updatedMode.providerId, 'selected-mode-2')
  assert.equal(updatedMode.sourceProviderId, 'myproxy')
  assert.equal(result.sessionMigration, null)
})

test('applyProviderSecretOverrideSessionMigration migrates matching sessions to dedicated provider', () => {
  const sessions = [
    createSession({
      providerId: 'myproxy',
      itemName: 'customModel',
      customName: 'selected-mode',
      apiKey: 'legacy-session-key',
    }),
    createSession({
      providerId: 'myproxy',
      itemName: 'customModel',
      customName: 'other-mode',
      apiKey: 'leave-me-alone',
    }),
  ]

  const result = applyProviderSecretOverrideSessionMigration(sessions, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'myproxy',
    toProviderId: 'selected-mode-2',
  })

  assert.equal(result[0].apiMode.providerId, 'selected-mode-2')
  assert.equal(result[0].apiMode.apiKey, '')
  assert.equal(result[1].apiMode.providerId, 'myproxy')
  assert.equal(result[1].apiMode.apiKey, 'leave-me-alone')
})

test('applyProviderSecretOverrideSessionMigration migrates legacy sessions missing itemName and isCustom', () => {
  const sessions = [
    {
      sessionId: 'legacy-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        customName: 'selected-mode',
        providerId: 'myproxy',
        apiKey: 'legacy-session-key',
      },
      conversationRecords: [],
    },
  ]

  const result = applyProviderSecretOverrideSessionMigration(sessions, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'myproxy',
    toProviderId: 'selected-mode-2',
  })

  assert.equal(result[0].apiMode.providerId, 'selected-mode-2')
  assert.equal(result[0].apiMode.apiKey, '')
})

test('applyProviderSecretOverrideSessionMigration does not relax matching for modern sessions', () => {
  const sessions = [
    createSession({
      providerId: 'myproxy',
      itemName: 'different-model',
      isCustom: true,
      customName: 'selected-mode',
      apiKey: 'leave-me-alone',
    }),
  ]

  const result = applyProviderSecretOverrideSessionMigration(sessions, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'myproxy',
    toProviderId: 'selected-mode-2',
  })

  assert.equal(result[0].apiMode.providerId, 'myproxy')
  assert.equal(result[0].apiMode.apiKey, 'leave-me-alone')
})

test('applyProviderSecretOverrideSessionMigration reverts matching sessions back to shared provider', () => {
  const sessions = [
    createSession({
      providerId: 'selected-mode-2',
      itemName: 'customModel',
      customName: 'selected-mode',
      apiKey: 'legacy-session-key',
      sourceProviderId: 'myproxy',
    }),
  ]

  const result = applyProviderSecretOverrideSessionMigration(sessions, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'selected-mode-2',
    toProviderId: 'myproxy',
  })

  assert.equal(result[0].apiMode.providerId, 'myproxy')
  assert.equal(result[0].apiMode.apiKey, '')
  assert.equal('sourceProviderId' in result[0].apiMode, false)
})

test('rollbackProviderSecretOverrideSessionMigration reverts only sessions still on migrated provider', () => {
  const originalSessions = [
    {
      sessionId: 'selected-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'selected-mode',
        providerId: 'myproxy',
        apiKey: 'legacy-session-key',
        sourceProviderId: 'shared-openai',
      },
      conversationRecords: [],
    },
    {
      sessionId: 'other-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'selected-mode',
        providerId: 'myproxy',
        apiKey: 'leave-me-alone',
      },
      conversationRecords: [],
    },
  ]
  const currentSessions = [
    {
      sessionId: 'selected-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'selected-mode',
        providerId: 'selected-mode-2',
        apiKey: '',
      },
      conversationRecords: [{ role: 'assistant', answer: 'latest-reply' }],
    },
    {
      sessionId: 'other-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'selected-mode',
        providerId: 'selected-mode-3',
        apiKey: '',
      },
      conversationRecords: [],
    },
  ]

  const result = rollbackProviderSecretOverrideSessionMigration(currentSessions, originalSessions, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'myproxy',
    toProviderId: 'selected-mode-2',
  })

  assert.equal(result[0].apiMode.providerId, 'myproxy')
  assert.equal(result[0].apiMode.apiKey, 'legacy-session-key')
  assert.equal(result[0].apiMode.sourceProviderId, 'shared-openai')
  assert.deepEqual(result[0].conversationRecords, [{ role: 'assistant', answer: 'latest-reply' }])
  assert.equal(result[1].apiMode.providerId, 'selected-mode-3')
})

test('rollbackProviderSecretOverrideSessionMigration does not revert sessions missing original matches', () => {
  const currentSessions = [
    createSession({
      sessionId: 'selected-session',
      providerId: 'selected-mode-2',
      itemName: 'customModel',
      customName: 'selected-mode',
      apiKey: '',
    }),
  ]

  const result = rollbackProviderSecretOverrideSessionMigration(currentSessions, [], {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'myproxy',
    toProviderId: 'selected-mode-2',
  })

  assert.equal(result[0].apiMode.providerId, 'selected-mode-2')
})

test('rollbackProviderSecretOverrideSessionMigration reverts legacy sessions still on migrated provider', () => {
  const originalSessions = [
    {
      sessionId: 'legacy-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        customName: 'selected-mode',
        providerId: 'myproxy',
        apiKey: 'legacy-session-key',
        sourceProviderId: 'shared-openai',
      },
      conversationRecords: [],
    },
  ]
  const currentSessions = [
    {
      sessionId: 'legacy-session',
      apiMode: {
        groupName: 'customApiModelKeys',
        customName: 'selected-mode',
        providerId: 'selected-mode-2',
        apiKey: '',
      },
      conversationRecords: [{ role: 'assistant', answer: 'legacy-reply' }],
    },
  ]

  const result = rollbackProviderSecretOverrideSessionMigration(currentSessions, originalSessions, {
    identity: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'selected-mode',
      isCustom: true,
    },
    fromProviderId: 'myproxy',
    toProviderId: 'selected-mode-2',
  })

  assert.equal(result[0].apiMode.providerId, 'myproxy')
  assert.equal(result[0].apiMode.apiKey, 'legacy-session-key')
  assert.equal(result[0].apiMode.sourceProviderId, 'shared-openai')
  assert.deepEqual(result[0].conversationRecords, [{ role: 'assistant', answer: 'legacy-reply' }])
})
