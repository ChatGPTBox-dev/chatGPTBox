import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySelectedProviderToApiMode,
  applyDeletedProviderSecrets,
  applyPendingProviderChanges,
  buildEditedProvider,
  createProviderId,
  getConversationAiName,
  getApiModeDisplayLabel,
  getSelectedApiModeOptionValue,
  getConfiguredCustomApiModesForSessionRecovery,
  getProviderDeleteDisabledReasonKey,
  getProviderReferenceCheckApiModes,
  getReferencedCustomProviderIdsFromSessions,
  getSelectableProviders,
  isProviderDeleteDisabled,
  isProviderReferencedByApiModes,
  parseChatCompletionsEndpointUrl,
  loadSavedConversationState,
  persistApiModeConfigUpdate,
  removePendingProviderDeletion,
  resolveEditingProviderSelection,
  resolveEditingProviderIdForGroupChange,
  resolveSelectableProviderId,
  resolveProviderChatEndpointUrl,
  sanitizeApiModeForSave,
  shouldIncludeSelectedApiModeInReferenceCheck,
  shouldPersistDeletedProviderChanges,
  shouldPersistPendingProviderChanges,
  UNMATCHED_API_MODE_VALUE,
  validateProviderEndpointDraft,
} from '../../../src/popup/sections/api-modes-provider-utils.mjs'

test('getSelectedApiModeOptionValue returns the selected active mode index', () => {
  const apiModes = [
    {
      groupName: 'claudeWebModelKeys',
      itemName: 'claude2WebFree',
      active: true,
    },
    {
      groupName: 'openRouterApiModelKeys',
      itemName: 'openRouter_auto',
      active: true,
    },
  ]

  assert.equal(getSelectedApiModeOptionValue(apiModes, { apiMode: { ...apiModes[1] } }), '1')
})

test('getSelectedApiModeOptionValue preserves an unmatched modelName', () => {
  const apiModes = [
    {
      groupName: 'claudeWebModelKeys',
      itemName: 'claude2WebFree',
      active: true,
    },
  ]

  assert.equal(
    getSelectedApiModeOptionValue(apiModes, { modelName: 'chatgptFree35', apiMode: null }),
    UNMATCHED_API_MODE_VALUE,
  )
})

test('getSelectedApiModeOptionValue preserves an unmatched apiMode', () => {
  const apiModes = [
    {
      groupName: 'openRouterApiModelKeys',
      itemName: 'openRouter_auto',
      active: true,
    },
  ]
  const selectedApiMode = {
    groupName: 'openRouterApiModelKeys',
    itemName: 'openRouter_openai_gpt_5_5',
    active: true,
  }

  assert.equal(
    getSelectedApiModeOptionValue(apiModes, { apiMode: selectedApiMode }),
    UNMATCHED_API_MODE_VALUE,
  )
})

test('getSelectedApiModeOptionValue preserves a selection when no modes are active', () => {
  const selectedApiMode = {
    groupName: 'openRouterApiModelKeys',
    itemName: 'openRouter_openai_gpt_5_5',
    active: true,
  }

  assert.equal(
    getSelectedApiModeOptionValue([], { apiMode: selectedApiMode }),
    UNMATCHED_API_MODE_VALUE,
  )
})

test('getSelectedApiModeOptionValue preserves an ambiguous selection', () => {
  const duplicateApiMode = {
    groupName: 'openRouterApiModelKeys',
    itemName: 'openRouter_auto',
    active: true,
  }

  assert.equal(
    getSelectedApiModeOptionValue([{ ...duplicateApiMode }, { ...duplicateApiMode }], {
      apiMode: duplicateApiMode,
    }),
    UNMATCHED_API_MODE_VALUE,
  )
})

test('getSelectedApiModeOptionValue keeps the custom model option selected', () => {
  assert.equal(getSelectedApiModeOptionValue([], { modelName: 'customModel', apiMode: null }), '-1')
})

test('createProviderId avoids reserved and existing ids', () => {
  const existingProviders = [{ id: 'foo' }, { id: 'foo-2' }]
  const reservedProviderIds = ['openai', 'deepseek']

  assert.equal(createProviderId('OpenAI', existingProviders, reservedProviderIds), 'openai-2')
  assert.equal(createProviderId('Foo', existingProviders, reservedProviderIds), 'foo-3')
})

test('createProviderId does not reuse ids reserved by staged provider deletions', () => {
  const existingProviders = [{ id: 'my-proxy' }]
  const reservedProviderIds = ['my-proxy', 'my-proxy-2']

  assert.equal(createProviderId('My Proxy', existingProviders, reservedProviderIds), 'my-proxy-3')
})

test('parseChatCompletionsEndpointUrl accepts full chat endpoint url', () => {
  const parsed = parseChatCompletionsEndpointUrl('https://api.example.com/v1/chat/completions/')

  assert.equal(parsed.valid, true)
  assert.equal(parsed.chatCompletionsUrl, 'https://api.example.com/v1/chat/completions')
  assert.equal(parsed.completionsUrl, 'https://api.example.com/v1/completions')
})

test('parseChatCompletionsEndpointUrl accepts non-standard full endpoint url', () => {
  const parsed = parseChatCompletionsEndpointUrl('https://api.example.com/v1/messages')

  assert.equal(parsed.valid, true)
  assert.equal(parsed.chatCompletionsUrl, 'https://api.example.com/v1/messages')
  assert.equal(parsed.completionsUrl, '')
})

test('validateProviderEndpointDraft accepts non-standard endpoint for new providers', () => {
  const draft = validateProviderEndpointDraft('https://api.anthropic.com/v1/messages')

  assert.equal(draft.valid, true)
  assert.equal(draft.parsedEndpoint.valid, true)
  assert.equal(draft.parsedEndpoint.chatCompletionsUrl, 'https://api.anthropic.com/v1/messages')
})

test('validateProviderEndpointDraft rejects native Ollama chat endpoint', () => {
  const draft = validateProviderEndpointDraft('https://localhost:11434/api/chat')

  assert.equal(draft.valid, false)
  assert.equal(draft.parsedEndpoint.valid, false)
})

test('parseChatCompletionsEndpointUrl rejects root and version-only base urls', () => {
  const rootParsed = parseChatCompletionsEndpointUrl('https://api.example.com/')
  const versionParsed = parseChatCompletionsEndpointUrl('https://api.example.com/v1')

  assert.equal(rootParsed.valid, false)
  assert.equal(versionParsed.valid, false)
})

test('parseChatCompletionsEndpointUrl rejects non-http(s) schemes', () => {
  const ftpParsed = parseChatCompletionsEndpointUrl('ftp://api.example.com/v1/chat/completions')
  const fileParsed = parseChatCompletionsEndpointUrl('file:///v1/chat/completions')
  assert.equal(ftpParsed.valid, false)
  assert.equal(fileParsed.valid, false)
})

test('parseChatCompletionsEndpointUrl rejects embedded URL credentials', () => {
  const parsed = parseChatCompletionsEndpointUrl(
    'https://user:secret@api.example.com/v1/chat/completions',
  )

  assert.equal(parsed.valid, false)
})

test('parseChatCompletionsEndpointUrl keeps query string when deriving completions endpoint', () => {
  const parsed = parseChatCompletionsEndpointUrl(
    'https://api.example.com/v1/chat/completions?api-version=1',
  )
  assert.equal(parsed.valid, true)
  assert.equal(
    parsed.chatCompletionsUrl,
    'https://api.example.com/v1/chat/completions?api-version=1',
  )
  assert.equal(parsed.completionsUrl, 'https://api.example.com/v1/completions?api-version=1')
})

test('resolveProviderChatEndpointUrl prefers explicit chatCompletionsUrl', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    chatCompletionsUrl: 'https://proxy.example.com/chat/completions',
  })

  assert.equal(endpoint, 'https://proxy.example.com/chat/completions')
})

test('resolveProviderChatEndpointUrl builds endpoint from baseUrl and path', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1/',
    chatCompletionsPath: 'chat/completions',
    chatCompletionsUrl: '',
  })

  assert.equal(endpoint, 'https://api.example.com/v1/chat/completions')
})

test('resolveProviderChatEndpointUrl avoids duplicated v1 for default paths', () => {
  const explicitDefaultPathEndpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1/',
    chatCompletionsPath: '/v1/chat/completions',
    chatCompletionsUrl: '',
  })
  const baseUrlOnlyEndpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1/',
    chatCompletionsUrl: '',
  })

  assert.equal(explicitDefaultPathEndpoint, 'https://api.example.com/v1/chat/completions')
  assert.equal(baseUrlOnlyEndpoint, 'https://api.example.com/v1/chat/completions')
})

test('resolveProviderChatEndpointUrl applies default chat path for baseUrl-only providers', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com',
    chatCompletionsUrl: '',
  })

  assert.equal(endpoint, 'https://api.example.com/v1/chat/completions')
})

test('resolveProviderChatEndpointUrl mirrors runtime when completion path is non-default', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1/',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/custom-completions',
    chatCompletionsUrl: '',
  })

  assert.equal(endpoint, 'https://api.example.com/v1/v1/chat/completions')
})

test('resolveProviderChatEndpointUrl mirrors runtime when explicit completion url exists', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1/',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/v1/completions',
    chatCompletionsUrl: '',
    completionsUrl: 'https://api.example.com/v1/completions',
  })

  assert.equal(endpoint, 'https://api.example.com/v1/v1/chat/completions')
})

test('buildEditedProvider preserves existing provider endpoint shape when api url is unchanged', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
    sourceProviderId: 'openai',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl(
    'https://api.example.com/v1/chat/completions',
  )

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://api.example.com/v1/chat/completions',
  )

  assert.deepEqual(updatedProvider, {
    id: 'myproxy',
    name: 'My Proxy Updated',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
    sourceProviderId: 'openai',
  })
})

test('buildEditedProvider preserves default baseUrl provider when api url is unchanged', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/v1/completions',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl(
    'https://api.example.com/v1/chat/completions',
  )

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://api.example.com/v1/chat/completions',
  )

  assert.deepEqual(updatedProvider, {
    id: 'myproxy',
    name: 'My Proxy Updated',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/v1/completions',
  })
})

test('buildEditedProvider rewrites mixed endpoint provider when runtime url differs', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/custom-completions',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl(
    'https://api.example.com/v1/chat/completions',
  )

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://api.example.com/v1/chat/completions',
  )

  assert.equal(updatedProvider.id, 'myproxy')
  assert.equal(updatedProvider.name, 'My Proxy Updated')
  assert.equal(updatedProvider.baseUrl, '')
  assert.equal(updatedProvider.chatCompletionsUrl, 'https://api.example.com/v1/chat/completions')
  assert.equal(updatedProvider.completionsUrl, 'https://api.example.com/v1/completions')
  assert.equal(updatedProvider.completionsPath, '/custom-completions')
})

test('buildEditedProvider rewrites endpoint fields when api url changes', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
    sourceProviderId: 'openai',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl(
    'https://proxy.example.com/v2/chat/completions',
  )

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://proxy.example.com/v2/chat/completions',
  )

  assert.equal(updatedProvider.id, 'myproxy')
  assert.equal(updatedProvider.name, 'My Proxy Updated')
  assert.equal(updatedProvider.baseUrl, '')
  assert.equal(updatedProvider.chatCompletionsUrl, 'https://proxy.example.com/v2/chat/completions')
  assert.equal(updatedProvider.completionsUrl, 'https://proxy.example.com/v2/completions')
  assert.equal(updatedProvider.sourceProviderId, 'openai')
})

test('buildEditedProvider preserves non-standard endpoint shape when api url is unchanged', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: '',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    chatCompletionsUrl: 'https://api.example.com/v1/messages',
    completionsUrl: '',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl('https://api.example.com/v1/messages')

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://api.example.com/v1/messages',
  )

  assert.deepEqual(updatedProvider, {
    id: 'myproxy',
    name: 'My Proxy Updated',
    baseUrl: '',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    chatCompletionsUrl: 'https://api.example.com/v1/messages',
    completionsUrl: '',
  })
})

test('buildEditedProvider clears completions url when non-standard endpoint changes', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl('https://proxy.example.com/v2/messages')

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://proxy.example.com/v2/messages',
  )

  assert.equal(updatedProvider.id, 'myproxy')
  assert.equal(updatedProvider.name, 'My Proxy Updated')
  assert.equal(updatedProvider.baseUrl, '')
  assert.equal(updatedProvider.chatCompletionsUrl, 'https://proxy.example.com/v2/messages')
  assert.equal(updatedProvider.completionsUrl, '')
})

test('resolveSelectableProviderId falls back when provider is missing or invalid', () => {
  const fallbackId = 'legacy-custom-default'
  const providers = [
    { id: 'myproxy' },
    { id: 'another-provider' },
    { id: 'disabled-provider', enabled: false },
  ]

  assert.equal(resolveSelectableProviderId(' myproxy ', providers, fallbackId), 'myproxy')
  assert.equal(resolveSelectableProviderId('unknown-provider', providers, fallbackId), fallbackId)
  assert.equal(resolveSelectableProviderId('disabled-provider', providers, fallbackId), fallbackId)
  assert.equal(resolveSelectableProviderId('   ', providers, fallbackId), fallbackId)
})

test('resolveSelectableProviderId matches normalized provider ids and returns canonical id', () => {
  const providers = [{ id: 'my-proxy' }]

  assert.equal(resolveSelectableProviderId(' My Proxy ', providers, ''), 'my-proxy')
})

test('resolveEditingProviderSelection keeps legacy provider selection for empty or legacy values', () => {
  const providers = [{ id: 'myproxy' }]

  assert.equal(
    resolveEditingProviderSelection('', providers, 'legacy-custom-default'),
    'legacy-custom-default',
  )
  assert.equal(
    resolveEditingProviderSelection('legacy-custom-default', providers, 'legacy-custom-default'),
    'legacy-custom-default',
  )
})

test('resolveEditingProviderSelection leaves missing custom providers unselected', () => {
  const providers = [{ id: 'myproxy' }, { id: 'disabled-provider', enabled: false }]

  assert.equal(
    resolveEditingProviderSelection('missing-provider', providers, 'legacy-custom-default'),
    '',
  )
  assert.equal(
    resolveEditingProviderSelection('disabled-provider', providers, 'legacy-custom-default'),
    '',
  )
  assert.equal(
    resolveEditingProviderSelection('myproxy', providers, 'legacy-custom-default'),
    'myproxy',
  )
})

test('applyPendingProviderChanges overlays edited providers and preserves order', () => {
  const providers = [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B' },
  ]

  const result = applyPendingProviderChanges(providers, {
    'provider-b': { id: 'provider-b', name: 'Provider B Updated' },
  })

  assert.deepEqual(result, [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B Updated' },
  ])
})

test('applyPendingProviderChanges appends a pending new provider', () => {
  const providers = [{ id: 'provider-a', name: 'Provider A' }]

  const result = applyPendingProviderChanges(
    providers,
    {},
    { id: 'provider-b', name: 'Provider B' },
  )

  assert.deepEqual(result, [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B' },
  ])
})

test('applyPendingProviderChanges prefers pending new provider when id already exists', () => {
  const providers = [{ id: 'provider-a', name: 'Provider A' }]

  const result = applyPendingProviderChanges(
    providers,
    {},
    { id: 'provider-a', name: 'Provider A Draft' },
  )

  assert.deepEqual(result, [{ id: 'provider-a', name: 'Provider A Draft' }])
})

test('applyPendingProviderChanges removes deleted providers and skips deleted pending provider', () => {
  const providers = [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B' },
  ]

  const result = applyPendingProviderChanges(
    providers,
    {},
    { id: 'provider-b', name: 'Provider B Draft' },
    ['provider-b'],
  )

  assert.deepEqual(result, [{ id: 'provider-a', name: 'Provider A' }])
})

test('getSelectableProviders excludes disabled providers', () => {
  const providers = [
    { id: 'provider-a', enabled: true },
    { id: 'provider-b', enabled: false },
    { id: 'provider-c' },
  ]

  assert.deepEqual(getSelectableProviders(providers), [
    { id: 'provider-a', enabled: true },
    { id: 'provider-c' },
  ])
})

test('shouldPersistPendingProviderChanges persists whenever there are pending provider changes', () => {
  assert.equal(shouldPersistPendingProviderChanges(true), true)
  assert.equal(shouldPersistPendingProviderChanges(false), false)
})

test('provider edits stay pending even if the outer api mode switches away from custom type', () => {
  const hasPendingProviderChanges = true
  const nextApiMode = { groupName: 'gptApiModelKeys' }

  assert.equal(nextApiMode.groupName === 'customApiModelKeys', false)
  assert.equal(shouldPersistPendingProviderChanges(hasPendingProviderChanges), true)
})

test('shouldPersistDeletedProviderChanges persists staged deletes regardless of mode group', () => {
  assert.equal(shouldPersistDeletedProviderChanges(['provider-a']), true)
  assert.equal(shouldPersistDeletedProviderChanges([]), false)
})

test('resolveEditingProviderIdForGroupChange preserves custom provider draft across type switches', () => {
  assert.equal(
    resolveEditingProviderIdForGroupChange('gptApiModelKeys', 'myproxy', 'legacy-custom-default'),
    'myproxy',
  )
  assert.equal(
    resolveEditingProviderIdForGroupChange(
      'customApiModelKeys',
      'myproxy',
      'legacy-custom-default',
    ),
    'myproxy',
  )
  assert.equal(
    resolveEditingProviderIdForGroupChange('customApiModelKeys', '', 'legacy-custom-default'),
    'legacy-custom-default',
  )
})

test('sanitizeApiModeForSave clears custom-provider metadata for non-custom modes', () => {
  const sanitizedApiMode = sanitizeApiModeForSave({
    groupName: 'moonshotApiModelKeys',
    providerId: 'custom-provider',
    apiKey: 'sk-test',
    customUrl: 'https://proxy.example.com/v1/chat/completions',
    sourceProviderId: 'openai',
  })

  assert.deepEqual(sanitizedApiMode, {
    groupName: 'moonshotApiModelKeys',
    providerId: '',
    apiKey: '',
    customUrl: '',
  })
})

test('sanitizeApiModeForSave preserves custom-provider metadata for custom modes', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    providerId: 'custom-provider',
    apiKey: 'sk-test',
    sourceProviderId: 'openai',
  }

  assert.deepEqual(sanitizeApiModeForSave(apiMode), apiMode)
})

test('applySelectedProviderToApiMode clears provider-derived fields when provider changes', () => {
  const nextApiMode = applySelectedProviderToApiMode(
    {
      groupName: 'customApiModelKeys',
      providerId: 'selected-mode-2',
      apiKey: 'override-key',
      sourceProviderId: 'openai',
      customUrl: 'https://example.com',
    },
    'myproxy',
    true,
  )

  assert.deepEqual(nextApiMode, {
    groupName: 'customApiModelKeys',
    providerId: 'myproxy',
    apiKey: '',
    customUrl: '',
  })
})

test('applySelectedProviderToApiMode preserves sourceProviderId when provider stays the same', () => {
  const nextApiMode = applySelectedProviderToApiMode(
    {
      groupName: 'customApiModelKeys',
      providerId: 'selected-mode-2',
      apiKey: '',
      sourceProviderId: 'openai',
      customUrl: 'https://example.com',
    },
    'selected-mode-2',
    false,
  )

  assert.deepEqual(nextApiMode, {
    groupName: 'customApiModelKeys',
    providerId: 'selected-mode-2',
    apiKey: '',
    sourceProviderId: 'openai',
    customUrl: '',
  })
})

test('applySelectedProviderToApiMode preserves customUrl when legacy custom provider stays selected', () => {
  const nextApiMode = applySelectedProviderToApiMode(
    {
      groupName: 'customApiModelKeys',
      providerId: 'legacy-custom-default',
      apiKey: '',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
    },
    'legacy-custom-default',
    false,
  )

  assert.deepEqual(nextApiMode, {
    groupName: 'customApiModelKeys',
    providerId: 'legacy-custom-default',
    apiKey: '',
    customUrl: 'https://proxy.example.com/v1/chat/completions',
  })
})

test('applySelectedProviderToApiMode clears customUrl for provider-managed legacy custom provider', () => {
  const nextApiMode = applySelectedProviderToApiMode(
    {
      groupName: 'customApiModelKeys',
      providerId: 'legacy-custom-default',
      apiKey: '',
      customUrl: 'http://localhost:8000/v1/chat/completions',
    },
    'legacy-custom-default',
    false,
    true,
  )

  assert.deepEqual(nextApiMode, {
    groupName: 'customApiModelKeys',
    providerId: 'legacy-custom-default',
    apiKey: '',
    customUrl: '',
  })
})

test('applySelectedProviderToApiMode clears customUrl when switching away from legacy custom provider', () => {
  const nextApiMode = applySelectedProviderToApiMode(
    {
      groupName: 'customApiModelKeys',
      providerId: 'legacy-custom-default',
      apiKey: '',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
    },
    'myproxy',
    false,
  )

  assert.deepEqual(nextApiMode, {
    groupName: 'customApiModelKeys',
    providerId: 'myproxy',
    apiKey: '',
    customUrl: '',
  })
})

test('sanitizeApiModeForSave clears customUrl for non-custom modes', () => {
  const sanitized = sanitizeApiModeForSave({
    groupName: 'chatgptApiModelKeys',
    providerId: 'myproxy',
    apiKey: 'secret',
    customUrl: 'https://proxy.example.com/v1/chat/completions',
    sourceProviderId: 'openai',
  })

  assert.deepEqual(sanitized, {
    groupName: 'chatgptApiModelKeys',
    providerId: '',
    apiKey: '',
    customUrl: '',
  })
})

test('isProviderReferencedByApiModes only matches custom modes with the same provider id', () => {
  const apiModes = [
    { groupName: 'customApiModelKeys', providerId: 'provider-a' },
    { groupName: 'gptApiModelKeys', providerId: 'provider-a' },
  ]

  assert.equal(isProviderReferencedByApiModes('provider-a', apiModes), true)
  assert.equal(isProviderReferencedByApiModes('provider-b', apiModes), false)
})

test('getProviderReferenceCheckApiModes excludes the currently edited mode from delete checks', () => {
  const apiModes = [
    { groupName: 'customApiModelKeys', providerId: 'provider-a' },
    { groupName: 'customApiModelKeys', providerId: 'provider-b' },
  ]

  const referenceCheckApiModes = getProviderReferenceCheckApiModes(apiModes, true, 0)

  assert.equal(isProviderReferencedByApiModes('provider-a', referenceCheckApiModes), false)
  assert.equal(isProviderReferencedByApiModes('provider-b', referenceCheckApiModes), true)
})

test('getProviderReferenceCheckApiModes keeps existing modes unchanged for new edits', () => {
  const apiModes = [{ groupName: 'customApiModelKeys', providerId: 'provider-a' }]

  assert.deepEqual(getProviderReferenceCheckApiModes(apiModes, true, -1), apiModes)
})

test('getConfiguredCustomApiModesForSessionRecovery includes standalone selected custom mode once', () => {
  const apiModes = [{ groupName: 'customApiModelKeys', providerId: 'provider-a', customName: 'a' }]
  const selectedApiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'b',
    providerId: 'provider-b',
    active: true,
  }

  assert.deepEqual(getConfiguredCustomApiModesForSessionRecovery(apiModes, selectedApiMode), [
    apiModes[0],
    selectedApiMode,
  ])
  assert.deepEqual(
    getConfiguredCustomApiModesForSessionRecovery([selectedApiMode], selectedApiMode),
    [selectedApiMode],
  )
})

test('provider delete stays disabled until saved conversations finish loading', () => {
  assert.equal(isProviderDeleteDisabled(false, false), true)
  assert.equal(getProviderDeleteDisabledReasonKey(false, false), 'Loading saved conversations…')
})

test('loadSavedConversationState keeps provider guards fail-closed when saved conversations load fails', async () => {
  const result = await loadSavedConversationState(async () => {
    throw new Error('storage unavailable')
  })

  assert.deepEqual(result.sessions, [])
  assert.equal(result.sessionsLoaded, false)
  assert.match(String(result.error), /storage unavailable/)
})

test('persistApiModeConfigUpdate only runs success effects after config write succeeds', async () => {
  const payload = { customApiModes: [{ groupName: 'customApiModelKeys' }] }
  const observed = []

  await assert.rejects(
    persistApiModeConfigUpdate(
      async (nextPayload, options) => {
        observed.push(nextPayload)
        observed.push(options)
        throw new Error('persist failed')
      },
      payload,
      () => {
        observed.push('cleared')
      },
    ),
    /persist failed/,
  )

  assert.deepEqual(observed, [payload, { propagateError: true }])
})

test('provider delete uses reference reason after saved conversations load', () => {
  assert.equal(isProviderDeleteDisabled(true, true), true)
  assert.equal(
    getProviderDeleteDisabledReasonKey(true, true),
    'This provider is still used by other API modes or saved conversations',
  )
  assert.equal(isProviderDeleteDisabled(false, true), false)
  assert.equal(getProviderDeleteDisabledReasonKey(false, true), '')
})

test('shouldIncludeSelectedApiModeInReferenceCheck includes standalone selected custom mode', () => {
  const apiModes = [{ groupName: 'customApiModelKeys', providerId: 'provider-a', itemName: 'a' }]
  const selectedApiMode = {
    groupName: 'customApiModelKeys',
    providerId: 'provider-b',
    itemName: 'b',
  }

  assert.equal(
    shouldIncludeSelectedApiModeInReferenceCheck(apiModes, true, 0, selectedApiMode),
    true,
  )
})

test('shouldIncludeSelectedApiModeInReferenceCheck excludes selected mode when it is the edited mode', () => {
  const selectedApiMode = {
    groupName: 'customApiModelKeys',
    providerId: 'provider-a',
    itemName: 'customModel',
    isCustom: true,
    customName: 'alpha',
    active: true,
  }
  const apiModes = [{ ...selectedApiMode }]

  assert.equal(
    shouldIncludeSelectedApiModeInReferenceCheck(apiModes, true, 0, selectedApiMode),
    false,
  )
})

test('session recovery excludes the edited selected custom mode and uses in-flight replacement', () => {
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      providerId: 'old-provider',
      active: true,
    },
  ]
  const configApiMode = { ...apiModes[0] }
  const editingApiMode = {
    ...apiModes[0],
    providerId: 'new-provider',
  }
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        providerId: 'stale-provider-id',
        customUrl: '',
      },
    },
  ]
  const providers = [
    { id: 'old-provider', enabled: true },
    { id: 'new-provider', enabled: true },
  ]

  const recoveryApiModes = getProviderReferenceCheckApiModes(apiModes, true, 0)
  const recoverySelectedApiMode = shouldIncludeSelectedApiModeInReferenceCheck(
    apiModes,
    true,
    0,
    configApiMode,
  )
    ? configApiMode
    : editingApiMode
  const configuredApiModes = getConfiguredCustomApiModesForSessionRecovery(
    recoveryApiModes,
    recoverySelectedApiMode,
  )
  const referencedProviderIds = getReferencedCustomProviderIdsFromSessions(
    sessions,
    providers,
    configuredApiModes,
  )

  assert.deepEqual(configuredApiModes, [editingApiMode])
  assert.deepEqual(referencedProviderIds, ['new-provider'])
})

test('session recovery still keeps persisted selected mode when editing a different row', () => {
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'mode-a',
      providerId: 'provider-a',
      active: true,
    },
  ]
  const configApiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'mode-b',
    providerId: 'provider-b',
    active: true,
  }
  const editingApiMode = {
    ...apiModes[0],
    providerId: 'provider-a-updated',
  }
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-b',
        providerId: 'stale-provider-id',
        customUrl: '',
      },
    },
  ]
  const providers = [
    { id: 'provider-a', enabled: true },
    { id: 'provider-b', enabled: true },
  ]

  const recoveryApiModes = getProviderReferenceCheckApiModes(apiModes, true, 0)
  const recoverySelectedApiMode = shouldIncludeSelectedApiModeInReferenceCheck(
    apiModes,
    true,
    0,
    configApiMode,
  )
    ? configApiMode
    : editingApiMode
  const configuredApiModes = getConfiguredCustomApiModesForSessionRecovery(
    recoveryApiModes,
    recoverySelectedApiMode,
  )
  const referencedProviderIds = getReferencedCustomProviderIdsFromSessions(
    sessions,
    providers,
    configuredApiModes,
  )

  assert.deepEqual(configuredApiModes, [configApiMode])
  assert.deepEqual(referencedProviderIds, ['provider-b'])
})

test('createProviderId reuses missing provider ids that only stale modes still reference', () => {
  assert.equal(createProviderId('My Proxy', [], []), 'my-proxy')
})

test('createProviderId still avoids ids reserved by staged deletes and builtin providers', () => {
  assert.equal(createProviderId('My Proxy', [], ['my-proxy', 'openai']), 'my-proxy-2')
})

test('getReferencedCustomProviderIdsFromSessions collects unique custom provider ids', () => {
  const sessions = [
    { apiMode: { groupName: 'customApiModelKeys', providerId: 'provider-a' } },
    { apiMode: { groupName: 'customApiModelKeys', providerId: ' provider-a ' } },
    { apiMode: { groupName: 'customApiModelKeys', providerId: 'provider-b' } },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions), [
    'provider-a',
    'provider-b',
  ])
})

test('getReferencedCustomProviderIdsFromSessions ignores legacy and invalid sessions', () => {
  const sessions = [
    { apiMode: { groupName: 'customApiModelKeys', providerId: 'legacy-custom-default' } },
    { apiMode: { groupName: 'chatgptWebModelKeys', providerId: 'provider-a' } },
    { apiMode: { groupName: 'customApiModelKeys', providerId: '' } },
    { apiMode: null },
    {},
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions), [])
})

test('getReferencedCustomProviderIdsFromSessions matches legacy session by direct chat url', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions/',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), ['provider-a'])
})

test('getReferencedCustomProviderIdsFromSessions matches legacy session by derived chat url', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      baseUrl: 'https://proxy.example.com/v1/',
      chatCompletionsPath: '/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), ['provider-a'])
})

test('getReferencedCustomProviderIdsFromSessions matches baseUrl-only provider default chat url', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      baseUrl: 'https://proxy.example.com/v1/',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), ['provider-a'])
})

test('getReferencedCustomProviderIdsFromSessions matches legacy session against persisted provider url', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const persistedProviders = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]
  const effectiveProviders = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy-new.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, persistedProviders), [
    'provider-a',
  ])
  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, effectiveProviders), [])
})

test('getReferencedCustomProviderIdsFromSessions resolves stale provider ids via normalization', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: ' My Proxy ',
      },
    },
  ]
  const providers = [
    {
      id: 'my-proxy',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), ['my-proxy'])
})

test('getReferencedCustomProviderIdsFromSessions falls back to legacy url when stale provider id cannot be matched', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: 'old-provider-id',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), ['provider-a'])
})

test('getReferencedCustomProviderIdsFromSessions recovers provider through configured custom mode label', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'openai',
        customName: 'proxy-model',
        customUrl: '',
      },
    },
  ]
  const providers = [
    {
      id: 'openai-2',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      providerId: 'openai-2',
      active: true,
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers, apiModes), [
    'openai-2',
  ])
})

test('getReferencedCustomProviderIdsFromSessions recovers legacy session label when it has a unique configured mode', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: 'openai',
        customName: 'proxy-model',
        customUrl: '',
      },
    },
  ]
  const providers = [
    {
      id: 'openai-2',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      providerId: 'openai-2',
      active: true,
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers, apiModes), [
    'openai-2',
  ])
})

test('getReferencedCustomProviderIdsFromSessions keeps fail-closed behavior when label recovery is ambiguous', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: 'openai',
        customName: 'shared-label',
        customUrl: '',
      },
    },
  ]
  const providers = [
    {
      id: 'proxy-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy-a.example.com/v1/chat/completions',
    },
    {
      id: 'proxy-b',
      enabled: true,
      chatCompletionsUrl: 'https://proxy-b.example.com/v1/chat/completions',
    },
  ]
  const apiModes = [
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'shared-label',
      providerId: 'proxy-a',
      active: true,
    },
    {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'shared-label',
      providerId: 'proxy-b',
      active: true,
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers, apiModes), [])
})

test('getReferencedCustomProviderIdsFromSessions skips stale provider ids when no recover path matches', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: 'old-provider-id',
        customUrl: 'https://missing.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), [])
})

test('getReferencedCustomProviderIdsFromSessions does not fall back when direct url mismatches', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://other.example.com/v1/chat/completions',
      baseUrl: 'https://proxy.example.com/v1',
      chatCompletionsPath: '/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), [])
})

test('getReferencedCustomProviderIdsFromSessions ignores disabled legacy-url matches', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: false,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), [])
})

test('getReferencedCustomProviderIdsFromSessions conservatively returns all legacy-url matches', () => {
  const sessions = [
    {
      apiMode: {
        groupName: 'customApiModelKeys',
        providerId: '',
        customUrl: 'https://proxy.example.com/v1/chat/completions',
      },
    },
  ]
  const providers = [
    {
      id: 'provider-a',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
    {
      id: 'provider-b',
      enabled: true,
      chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  ]

  assert.deepEqual(getReferencedCustomProviderIdsFromSessions(sessions, providers), [
    'provider-a',
    'provider-b',
  ])
})

test('getApiModeDisplayLabel shows provider name for custom provider-backed modes', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'deepseek-v3.2',
    providerId: 'myproxy',
  }
  const providers = [{ id: 'myproxy', name: 'My Proxy' }]
  const t = (value) => value

  assert.equal(getApiModeDisplayLabel(apiMode, t, providers), 'My Proxy (deepseek-v3.2)')
})

test('getApiModeDisplayLabel matches providers by canonicalized provider id', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'deepseek-v3.2',
    providerId: ' My Proxy ',
  }
  const providers = [{ id: 'my-proxy', name: 'My Proxy' }]
  const t = (value) => value

  assert.equal(getApiModeDisplayLabel(apiMode, t, providers), 'My Proxy (deepseek-v3.2)')
})

test('getApiModeDisplayLabel falls back for legacy custom provider', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'deepseek-v3.2',
    providerId: 'legacy-custom-default',
  }
  const t = (value) => value

  assert.equal(getApiModeDisplayLabel(apiMode, t, []), 'Custom Model (deepseek-v3.2)')
})

test('getApiModeDisplayLabel falls back when a custom provider is missing', () => {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'deepseek-v3.2',
    providerId: 'missing-provider',
  }
  const t = (value) => value

  assert.equal(getApiModeDisplayLabel(apiMode, t, []), 'Custom Model (deepseek-v3.2)')
})

test('removePendingProviderDeletion removes a recreated provider id from pending deletions', () => {
  assert.deepEqual(removePendingProviderDeletion(['provider-a', 'provider-b'], ' provider-b '), [
    'provider-a',
  ])
})

test('applyDeletedProviderSecrets clears deleted provider secrets and preserves other entries', () => {
  const providerSecrets = {
    'provider-a': 'secret-a',
    'provider-b': 'secret-b',
  }

  assert.deepEqual(applyDeletedProviderSecrets(providerSecrets, ['provider-b']), {
    'provider-a': 'secret-a',
    'provider-b': '',
  })
})

test('getConversationAiName prefers current provider-aware label over stale session aiName', () => {
  const session = {
    modelName: 'customModel',
    aiName: 'Custom Model (deepseek-v3.2)',
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'deepseek-v3.2',
      providerId: 'myproxy',
    },
  }
  const providers = [{ id: 'myproxy', name: 'My Proxy' }]
  const t = (value) => value

  assert.equal(getConversationAiName(session, t, providers), 'My Proxy (deepseek-v3.2)')
})

test('getConversationAiName preserves historical aiName when custom provider is missing', () => {
  const session = {
    modelName: 'customModel',
    aiName: 'My Proxy (deepseek-v3.2)',
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'deepseek-v3.2',
      providerId: 'myproxy',
    },
  }
  const t = (value) => value

  assert.equal(getConversationAiName(session, t, []), 'My Proxy (deepseek-v3.2)')
})

test('getConversationAiName does not treat canonical provider id matches as missing', () => {
  const session = {
    modelName: 'customModel',
    aiName: 'Old Proxy (deepseek-v3.2)',
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'deepseek-v3.2',
      providerId: ' My Proxy ',
    },
  }
  const providers = [{ id: 'my-proxy', name: 'My Proxy' }]
  const t = (value) => value

  assert.equal(getConversationAiName(session, t, providers), 'My Proxy (deepseek-v3.2)')
})
