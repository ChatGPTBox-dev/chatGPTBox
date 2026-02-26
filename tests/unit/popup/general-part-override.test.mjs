import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSelectedModeProviderSecretOverrideUpdate } from '../../../src/popup/sections/provider-secret-utils.mjs'

test('resolveOverrideCommitContext reads committed config from a single accessor', async () => {
  const { resolveOverrideCommitContext } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const latestConfig = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'gpt-4',
      customName: 'My Proxy Mode',
      isCustom: true,
      providerId: 'myproxy',
      apiKey: '',
    },
    customApiModes: [],
    providerSecrets: {
      myproxy: 'old-key',
      teammate: 'newer-key',
    },
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        baseUrl: 'https://new-proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
      },
      {
        id: 'teammate',
        name: 'Teammate Proxy',
        baseUrl: 'https://teammate.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
      },
    ],
  }

  let committedConfigReadCount = 0
  const contextPromise = resolveOverrideCommitContext(async () => {
    committedConfigReadCount += 1
    await Promise.resolve()
    return latestConfig
  }, 'myproxy')
  const { committedConfig, existingProviders, committedSelectedProvider } = await contextPromise

  assert.equal(committedConfigReadCount, 1)
  assert.equal(committedSelectedProvider.baseUrl, 'https://new-proxy.example.com/v1')
  assert.equal(committedConfig.providerSecrets.teammate, 'newer-key')
  assert.ok(
    existingProviders.some((provider) => provider.id === 'teammate'),
    'committed custom providers should be read after config writes settle',
  )
})

test('resolveCommittedMigratedSessions reapplies migration to latest stored sessions', async () => {
  const { resolveCommittedMigratedSessions } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const concurrentSession = {
    sessionId: 'session-c',
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'gpt-4',
      customName: 'Teammate Mode',
      isCustom: true,
      providerId: 'teammate',
      apiKey: '',
    },
  }
  const latestStoredSessions = [
    {
      sessionId: 'session-a',
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'gpt-4',
        customName: 'Recovered Proxy Mode',
        isCustom: true,
        providerId: 'missing-provider',
        apiKey: 'stale-key',
      },
    },
    {
      sessionId: 'session-b',
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'gpt-4',
        customName: 'Other Mode',
        isCustom: true,
        providerId: 'other-provider',
        apiKey: '',
      },
    },
    concurrentSession,
  ]

  const resolved = await resolveCommittedMigratedSessions(
    () => Promise.resolve({ ok: true, sessions: latestStoredSessions }),
    {
      fromProviderId: 'missing-provider',
      toProviderId: 'mode-override-provider',
      identity: {
        groupName: 'customApiModelKeys',
        itemName: 'gpt-4',
        customName: 'Recovered Proxy Mode',
        isCustom: true,
      },
    },
  )

  assert.equal(resolved.ok, true)
  assert.equal(resolved.sessions, latestStoredSessions)
  assert.equal(resolved.migratedSessions.length, 3)
  assert.equal(resolved.migratedSessions[0].sessionId, 'session-a')
  assert.equal(resolved.migratedSessions[0].apiMode.providerId, 'mode-override-provider')
  assert.equal(resolved.migratedSessions[2], concurrentSession)
})

test('buildProviderOverrideFinalConfigUpdate skips cleanup when preserving current selection', async () => {
  const { buildProviderOverrideFinalConfigUpdate } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const configUpdate = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'Selected Mode',
      isCustom: true,
      providerId: 'myproxy',
      apiKey: '',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        customName: 'Selected Mode',
        isCustom: true,
        providerId: 'myproxy',
        apiKey: '',
      },
    ],
  }

  const result = buildProviderOverrideFinalConfigUpdate(
    'selected-mode-2',
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        customName: 'Selected Mode',
        isCustom: true,
        providerId: 'selected-mode-2',
        apiKey: '',
      },
      customApiModes: [],
      providerSecrets: {
        myproxy: 'shared-key',
        'selected-mode-2': 'override-key',
      },
      customOpenAIProviders: [
        { id: 'myproxy', name: 'Shared Provider' },
        { id: 'selected-mode-2', name: 'Shared Provider (selected-mode)' },
      ],
    },
    configUpdate,
    [],
    true,
  )

  assert.equal('apiMode' in result, false)
  assert.equal(result.providerSecrets, undefined)
  assert.equal(result.customOpenAIProviders, undefined)
  assert.equal(result.customApiModes[0].providerId, 'myproxy')
})

test('buildProviderOverrideFinalConfigUpdate still cleans up orphaned provider when selection is stable', async () => {
  const { buildProviderOverrideFinalConfigUpdate } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const result = buildProviderOverrideFinalConfigUpdate(
    'selected-mode-2',
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        customName: 'Selected Mode',
        isCustom: true,
        providerId: 'selected-mode-2',
        apiKey: '',
      },
      customApiModes: [],
      providerSecrets: {
        myproxy: 'shared-key',
        'selected-mode-2': 'override-key',
      },
      customOpenAIProviders: [
        { id: 'myproxy', name: 'Shared Provider' },
        { id: 'selected-mode-2', name: 'Shared Provider (selected-mode)' },
      ],
    },
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        customName: 'Selected Mode',
        isCustom: true,
        providerId: 'myproxy',
        apiKey: '',
      },
      customApiModes: [
        {
          groupName: 'customApiModelKeys',
          itemName: 'customModel',
          customName: 'Selected Mode',
          isCustom: true,
          providerId: 'myproxy',
          apiKey: '',
        },
      ],
    },
    [],
    false,
  )

  assert.equal(result.apiMode.providerId, 'myproxy')
  assert.deepEqual(result.providerSecrets, {
    myproxy: 'shared-key',
  })
  assert.deepEqual(result.customOpenAIProviders, [{ id: 'myproxy', name: 'Shared Provider' }])
})

test('buildProviderOverrideFinalConfigUpdate normalizes cleanup candidate id', async () => {
  const { buildProviderOverrideFinalConfigUpdate } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const result = buildProviderOverrideFinalConfigUpdate(
    ' selected-mode-2 ',
    {
      customApiModes: [],
      providerSecrets: {
        myproxy: 'shared-key',
        'selected-mode-2': 'override-key',
      },
      customOpenAIProviders: [
        { id: 'myproxy', name: 'Shared Provider' },
        { id: 'selected-mode-2', name: 'Shared Provider (selected-mode)' },
      ],
    },
    {
      customApiModes: [
        {
          groupName: 'customApiModelKeys',
          itemName: 'customModel',
          customName: 'Selected Mode',
          isCustom: true,
          providerId: 'myproxy',
          apiKey: '',
        },
      ],
    },
    [],
    false,
  )

  assert.deepEqual(result.providerSecrets, {
    myproxy: 'shared-key',
  })
  assert.deepEqual(result.customOpenAIProviders, [{ id: 'myproxy', name: 'Shared Provider' }])
})

test('buildProviderOverrideFinalConfigUpdate ignores malformed providerSecrets during cleanup', async () => {
  const { buildProviderOverrideFinalConfigUpdate } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  for (const providerSecrets of ['bad-shape', ['array-shape']]) {
    const result = buildProviderOverrideFinalConfigUpdate(
      'selected-mode-2',
      {
        customApiModes: [],
        providerSecrets,
        customOpenAIProviders: [{ id: 'selected-mode-2', name: 'Shared Provider (selected-mode)' }],
      },
      { customApiModes: [] },
      [],
      false,
    )

    assert.deepEqual(result.providerSecrets, {})
    assert.deepEqual(result.customOpenAIProviders, [])
  }
})

test('resolveOverrideCommitContext does not fallback to a removed or disabled provider', async () => {
  const { resolveOverrideCommitContext } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const removedProviderConfig = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'gpt-4',
      customName: 'My Proxy Mode',
      isCustom: true,
      providerId: 'myproxy',
      apiKey: '',
    },
    customApiModes: [],
    providerSecrets: {},
    customOpenAIProviders: [],
  }
  const disabledProviderConfig = {
    ...removedProviderConfig,
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: false,
      },
    ],
  }

  const removedContext = await resolveOverrideCommitContext(
    () => Promise.resolve(removedProviderConfig),
    'myproxy',
  )
  const disabledContext = await resolveOverrideCommitContext(
    () => Promise.resolve(disabledProviderConfig),
    'myproxy',
  )

  assert.equal(removedContext.committedSelectedProvider, null)
  assert.equal(disabledContext.committedSelectedProvider, null)
})

test('buildSelectedModeProviderSecretOverrideUpdate materializes recovered override from recovered endpoint', () => {
  const selectedMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    customName: 'Recovered Proxy Mode',
    isCustom: true,
    providerId: 'missing-provider',
    apiKey: '',
    active: true,
  }
  const config = {
    apiMode: selectedMode,
    customApiModes: [selectedMode],
    providerSecrets: {},
    customOpenAIProviders: [],
  }

  const { configUpdate } = buildSelectedModeProviderSecretOverrideUpdate(
    config,
    'missing-provider',
    'override-key',
    {
      id: 'missing-provider',
      sourceProviderId: 'missing-provider',
      name: 'Legacy Custom Provider',
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
      completionsUrl: '',
      baseUrl: '',
      chatCompletionsPath: '',
      completionsPath: '',
      enabled: true,
      allowLegacyResponseField: true,
    },
    [],
  )

  assert.equal(
    configUpdate.customOpenAIProviders[0].chatCompletionsUrl,
    'https://proxy.example.com/v1/chat/completions',
  )
  assert.equal(configUpdate.customOpenAIProviders[0].baseUrl, '')
  assert.equal(configUpdate.apiMode.sourceProviderId, 'missing-provider')
})

test('resolveCommittedOverrideSourceProvider re-resolves the latest recovered endpoint', async () => {
  const { resolveCommittedOverrideSourceProvider } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const committedConfig = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'Recovered Proxy Mode',
      isCustom: true,
      providerId: 'missing-provider',
      customUrl: 'https://new-proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
    customApiModes: [],
    providerSecrets: {},
    customOpenAIProviders: [],
    customModelApiUrl: 'https://legacy.example.com/v1/chat/completions',
  }

  const { committedSelectedProvider, overrideSourceProvider } =
    resolveCommittedOverrideSourceProvider(committedConfig, 'missing-provider')

  assert.equal(committedSelectedProvider.id, 'legacy-custom-default')
  assert.equal(
    overrideSourceProvider.chatCompletionsUrl,
    'https://new-proxy.example.com/v1/chat/completions',
  )
  assert.equal(overrideSourceProvider.completionsUrl, '')
  assert.equal(overrideSourceProvider.baseUrl, '')
  assert.equal(overrideSourceProvider.chatCompletionsPath, '')
  assert.equal(overrideSourceProvider.completionsPath, '')
})

test('resolveCommittedOverrideSourceProvider prefers a restored provider over a recovered legacy endpoint', async () => {
  const { resolveCommittedOverrideSourceProvider } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const committedConfig = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      customName: 'Recovered Proxy Mode',
      isCustom: true,
      providerId: 'missing-provider',
      customUrl: 'https://stale-proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
    customApiModes: [],
    providerSecrets: {},
    customOpenAIProviders: [
      {
        id: 'missing-provider',
        name: 'Restored Proxy',
        chatCompletionsUrl: 'https://restored-proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://restored-proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    customModelApiUrl: 'https://legacy.example.com/v1/chat/completions',
  }

  const { committedSelectedProvider, overrideSourceProvider } =
    resolveCommittedOverrideSourceProvider(committedConfig, 'missing-provider')

  assert.equal(committedSelectedProvider.id, 'missing-provider')
  assert.equal(overrideSourceProvider.id, 'missing-provider')
  assert.equal(
    overrideSourceProvider.chatCompletionsUrl,
    'https://restored-proxy.example.com/v1/chat/completions',
  )
})

test('createProviderApiKeyDraftSelectionSignature normalizes equivalent provider selections', async () => {
  const { createProviderApiKeyDraftSelectionSignature } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  assert.equal(
    createProviderApiKeyDraftSelectionSignature(' MyProxy ', ' provider-secret '),
    createProviderApiKeyDraftSelectionSignature('MyProxy', 'provider-secret'),
  )
})

test('shouldResetProviderApiKeyDraftAfterPersistFailure only resets when selection and draft still match', async () => {
  const { shouldResetProviderApiKeyDraftAfterPersistFailure } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  assert.equal(
    shouldResetProviderApiKeyDraftAfterPersistFailure(
      '{"providerId":"myproxy","secretTargetId":"provider-secret"}',
      '{"providerId":"myproxy","secretTargetId":"provider-secret"}',
      'draft-key',
      'draft-key',
    ),
    true,
  )
  assert.equal(
    shouldResetProviderApiKeyDraftAfterPersistFailure(
      '{"providerId":"other","secretTargetId":"provider-secret"}',
      '{"providerId":"myproxy","secretTargetId":"provider-secret"}',
      'draft-key',
      'draft-key',
    ),
    false,
  )
  assert.equal(
    shouldResetProviderApiKeyDraftAfterPersistFailure(
      '{"providerId":"myproxy","secretTargetId":"provider-secret"}',
      '{"providerId":"myproxy","secretTargetId":"provider-secret"}',
      'newer-draft',
      'draft-key',
    ),
    false,
  )
})

test('resolvePersistedProviderApiKeyForSelection returns the last persisted provider key', async () => {
  const { resolvePersistedProviderApiKeyForSelection } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const persistedConfig = {
    providerSecrets: {
      myproxy: 'persisted-key',
    },
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
  }
  const selectionSession = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  assert.equal(
    resolvePersistedProviderApiKeyForSelection(persistedConfig, selectionSession),
    'persisted-key',
  )
})

test('resolvePersistedProviderApiKeyForSelection ignores the in-memory draft key', async () => {
  const { resolvePersistedProviderApiKeyForSelection } = await import(
    '../../../src/popup/sections/general-provider-override-utils.mjs'
  )

  const persistedConfig = {
    providerSecrets: {},
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'myproxy',
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        active: true,
      },
    ],
  }
  const selectionSession = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'draft-key',
      active: true,
    },
  }

  assert.equal(resolvePersistedProviderApiKeyForSelection(persistedConfig, selectionSession), '')
})
