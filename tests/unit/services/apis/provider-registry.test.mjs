import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getOpenAICompatibleRequestDiagnostic,
  getCustomOpenAIProviders,
  getProviderById,
  resolveEndpointTypeForSession,
  resolveOpenAICompatibleRequest,
} from '../../../../src/services/apis/provider-registry.mjs'

test('resolveEndpointTypeForSession prefers apiMode when present', () => {
  const session = {
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'gpt-4o-mini',
    },
    modelName: 'gptApiInstruct',
  }

  assert.equal(resolveEndpointTypeForSession(session), 'chat')
})

test('resolveEndpointTypeForSession returns completion for gptApiModelKeys apiMode', () => {
  const session = {
    apiMode: {
      groupName: 'gptApiModelKeys',
      itemName: 'text-davinci-003',
    },
    modelName: 'chatgptApi4oMini',
  }

  assert.equal(resolveEndpointTypeForSession(session), 'completion')
})

test('resolveEndpointTypeForSession falls back to legacy modelName when apiMode is missing', () => {
  const session = {
    modelName: 'gptApiInstruct-text-davinci-003',
  }

  assert.equal(resolveEndpointTypeForSession(session), 'completion')
})

test('resolveOpenAICompatibleRequest resolves custom provider from normalized session provider id', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: ' MyProxy ',
      customName: 'proxy-model',
      customUrl: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'myproxy')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})

test('getOpenAICompatibleRequestDiagnostic reports safe context for missing custom provider', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'missing-provider',
        name: 'Disabled Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        enabled: false,
      },
    ],
  }
  const session = {
    modelName: 'customModel',
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: ' Missing Provider ',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
    },
  }

  const diagnostic = getOpenAICompatibleRequestDiagnostic(config, session)

  assert.equal(diagnostic.groupName, 'customApiModelKeys')
  assert.equal(diagnostic.rawProviderId, ' Missing Provider ')
  assert.equal(diagnostic.normalizedProviderId, 'missing-provider')
  assert.equal(diagnostic.modelName, 'customModel')
  assert.equal(diagnostic.hasCustomUrl, true)
  assert.equal(diagnostic.hasMatchingCustomProvider, false)
  assert.equal(diagnostic.hasDisabledMatchingCustomProvider, true)
  assert.equal(diagnostic.hasMatchingCustomProviderByLegacyUrl, false)
  assert.equal(diagnostic.hasDisabledMatchingCustomProviderByLegacyUrl, true)
})

test('getCustomOpenAIProviders defaults allowLegacyResponseField to true when absent', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const providers = getCustomOpenAIProviders(config)

  assert.equal(providers[0].allowLegacyResponseField, true)
})

test('getCustomOpenAIProviders preserves explicit false allowLegacyResponseField', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
        allowLegacyResponseField: false,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const providers = getCustomOpenAIProviders(config)

  assert.equal(providers[0].allowLegacyResponseField, false)
})

test('resolveOpenAICompatibleRequest resolves provider secret when session providerId is not canonical', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'MyProxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'proxy-key')
})

test('resolveOpenAICompatibleRequest treats empty providerSecrets entries as authoritative', () => {
  const config = {
    providerSecrets: {
      openai: '',
    },
    apiKey: 'legacy-openai-key',
  }
  const session = {
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'gpt-4o-mini',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.apiKey, '')
})

test('resolveOpenAICompatibleRequest ignores stale session apiKey for non-custom providers', () => {
  const config = {}
  const session = {
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'gpt-4o-mini',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.apiKey, '')
})

test('resolveOpenAICompatibleRequest keeps empty configured custom provider secret entry over legacy session key', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: '',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'myproxy',
        customName: 'proxy-model',
        apiKey: '',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'legacy-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, '')
})

test('resolveOpenAICompatibleRequest keeps empty configured custom provider secret entry when no legacy session key exists', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: '',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'myproxy',
        customName: 'proxy-model',
        apiKey: '',
        active: true,
      },
    ],
  }
  const session = {
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

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, '')
})

test('resolveOpenAICompatibleRequest preserves orphan custom session key override when mode is not in config', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'new-provider-key',
    },
    customApiModes: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'stale-session-key')
})

test('resolveOpenAICompatibleRequest falls back to session customUrl when referenced provider is missing', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.provider.id, 'legacy-custom-default')
  assert.equal(getProviderById(config, resolved.providerId)?.id, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest does not send missing provider secret to session customUrl', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
    providerSecrets: {
      'missing-provider': 'missing-provider-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.secretProviderId, 'missing-provider')
  assert.equal(resolved.apiKey, '')
})

test('resolveOpenAICompatibleRequest uses legacy custom secret instead of stale provider slot for session customUrl', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
    providerSecrets: {
      'missing-provider': '',
      'legacy-custom-default': 'legacy-provider-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.secretProviderId, 'missing-provider')
  assert.equal(resolved.apiKey, 'legacy-provider-key')
})

test('resolveOpenAICompatibleRequest falls back to legacy custom provider secret when missing provider has no secret', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
    providerSecrets: {
      'legacy-custom-default': 'legacy-provider-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'legacy-provider-key')
})

test('resolveOpenAICompatibleRequest preserves per-session customUrl for direct legacy sessions', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
    customModelApiUrl: 'https://new.example.com/v1/chat/completions',
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'legacy-custom-default',
      customName: 'legacy-custom',
      customUrl: 'https://stale.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://stale.example.com/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest resolves legacy custom default after providerId normalization', () => {
  const config = {
    customModelApiUrl: 'https://new.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: ' Legacy Custom Default ',
      customName: 'legacy-custom',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.provider.id, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://new.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest keeps failing when missing provider has no customUrl', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest does not use custom session fallback outside customApiModelKeys', () => {
  const config = {
    customOpenAIProviders: [],
    customApiModes: [],
  }
  const session = {
    apiMode: {
      groupName: 'gptApiModelKeys',
      itemName: 'text-davinci-003',
      providerId: 'missing-provider',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'session-key',
    },
    modelName: 'gptApiInstruct-text-davinci-003',
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.requestUrl, 'https://api.openai.com/v1/completions')
})

test('resolveOpenAICompatibleRequest preserves normalized OpenAI source provider on materialized custom providers', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-openai',
        name: 'Selected Mode (OpenAI)',
        baseUrl: 'https://proxy.example.com/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        sourceProviderId: 'openai',
        enabled: true,
      },
    ],
    providerSecrets: {
      'selected-mode-openai': 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-openai',
      customName: 'gpt-5.4-mini',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'selected-mode-openai')
  assert.equal(resolved.provider.sourceProviderId, 'openai')
})

test('resolveOpenAICompatibleRequest preserves normalized Ollama source provider on materialized custom providers', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'selected-mode-ollama',
        name: 'Selected Mode (Ollama)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        sourceProviderId: 'ollama',
        enabled: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'selected-mode-ollama',
      customName: 'llama3.2',
      customUrl: '',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'selected-mode-ollama')
  assert.equal(resolved.provider.sourceProviderId, 'ollama')
})

test('resolveOpenAICompatibleRequest prefers configured provider secret over stale custom session key', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'new-provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'new-provider-key')
})

test('resolveOpenAICompatibleRequest deduplicates selected custom mode when config copies differ only by apiKey', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'updated-mode-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'updated-mode-key',
      providerId: 'myproxy',
      active: true,
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'updated-mode-key')
})

test('resolveOpenAICompatibleRequest matches configured custom mode when session providerId needs normalization', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'new-provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: ' MyProxy ',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'new-provider-key')
})

test('resolveOpenAICompatibleRequest recovers custom provider from legacy customUrl when provider uses baseUrl and path', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        baseUrl: 'https://proxy.example.com',
        chatCompletionsPath: '/v1/chat/completions',
        completionsPath: '/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'OpenAI',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
      apiKey: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'myproxy')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})

test('resolveOpenAICompatibleRequest recovers by legacy customUrl when provider direct chat url changed but derived url still matches', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://direct.example.com/v1/chat/completions',
        baseUrl: 'https://derived.example.com',
        chatCompletionsPath: '/v1/chat/completions',
        completionsUrl: 'https://direct.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'OpenAI',
      customName: 'proxy-model',
      customUrl: 'https://derived.example.com/v1/chat/completions',
      apiKey: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://derived.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, '')
})

test('resolveOpenAICompatibleRequest does not fall back when the referenced custom provider is disabled', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        enabled: false,
      },
    ],
    providerSecrets: {
      'legacy-custom-default': 'legacy-provider-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest does not fall back when customUrl points at a disabled custom provider', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'disabled-provider',
        name: 'Disabled Provider',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        enabled: false,
      },
    ],
    customApiModes: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest uses recovered provider url instead of stale legacy customUrl', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://new.example.com/v1/chat/completions',
        completionsUrl: 'https://new.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: '',
      isCustom: false,
      providerId: '',
      customName: 'proxy-model',
      customUrl: 'https://old.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'myproxy')
  assert.equal(resolved.requestUrl, 'https://new.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'provider-key')
})

test('resolveOpenAICompatibleRequest preserves per-session customUrl for unrecovered legacy custom sessions', () => {
  const config = {
    customModelApiUrl: 'https://global-default.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: '',
      customName: 'orphaned-self-hosted',
      customUrl: 'https://self-hosted.example.com/v1/chat/completions',
      apiKey: 'session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://self-hosted.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest uses global customModelApiUrl for direct legacy sessions without customUrl', () => {
  const config = {
    customModelApiUrl: 'https://global-default.example.com/v1/chat/completions',
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'legacy-custom-default',
      customName: 'legacy-custom',
      customUrl: '',
      apiKey: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://global-default.example.com/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest uses recovered provider url when configured provider reuses legacy-custom-default id', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'legacy-custom-default',
        name: 'Recovered Legacy Provider',
        chatCompletionsUrl: 'https://new.example.com/v1/chat/completions',
        completionsUrl: 'https://new.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'legacy-custom-default': 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: '',
        isCustom: false,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'legacy-custom-default',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: '',
      isCustom: false,
      providerId: '',
      customName: 'proxy-model',
      customUrl: 'https://old.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://new.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'provider-key')
})

test('resolveOpenAICompatibleRequest uses global legacy custom url when label recovery lands on legacy-custom-default', () => {
  const config = {
    customModelApiUrl: 'https://global-default.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: '',
        isCustom: false,
        customName: 'legacy-proxy',
        customUrl: '',
        apiKey: '',
        providerId: 'legacy-custom-default',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: '',
      isCustom: false,
      providerId: '',
      customName: 'legacy-proxy',
      customUrl: 'https://saved-session.example.com/v1/chat/completions',
      apiKey: 'session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://global-default.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest falls back to provider secret when custom mode label changes', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'updated-provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'renamed-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'old-model-name',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'updated-provider-key')
})

test('resolveOpenAICompatibleRequest does not treat the only provider mode as a renamed session mode', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'replacement-mode',
        customUrl: '',
        apiKey: 'replacement-mode-key',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'deleted-mode',
      customUrl: '',
      apiKey: 'session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest preserves session key when multiple custom modes share one provider', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'shared-provider',
        name: 'Shared Provider',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'shared-provider': 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-a',
        customUrl: '',
        apiKey: '',
        providerId: 'shared-provider',
        active: true,
      },
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-b',
        customUrl: '',
        apiKey: 'mode-b-key',
        providerId: 'shared-provider',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'shared-provider',
      customName: 'old-session-name',
      customUrl: '',
      apiKey: 'session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest matches the correct custom mode by customName when multiple modes share one provider', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'shared-provider',
        name: 'Shared Provider',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'shared-provider': 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-a',
        customUrl: '',
        apiKey: '',
        providerId: 'shared-provider',
        active: true,
      },
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-b',
        customUrl: '',
        apiKey: 'mode-b-key',
        providerId: 'shared-provider',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'shared-provider',
      customName: 'mode-b',
      customUrl: '',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'mode-b-key')
})

test('resolveOpenAICompatibleRequest uses provider secret when multiple custom modes share one provider but none has a mode-specific key', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'shared-provider',
        name: 'Shared Provider',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'shared-provider': 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-a',
        customUrl: '',
        apiKey: '',
        providerId: 'shared-provider',
        active: true,
      },
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-b',
        customUrl: '',
        apiKey: '',
        providerId: 'shared-provider',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'shared-provider',
      customName: 'old-session-name',
      customUrl: '',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'provider-key')
})

test('resolveOpenAICompatibleRequest preserves session key when multiple custom modes share one provider without configured keys', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'shared-provider',
        name: 'Shared Provider',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {},
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-a',
        customUrl: '',
        apiKey: '',
        providerId: 'shared-provider',
        active: true,
      },
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'mode-b',
        customUrl: '',
        apiKey: '',
        providerId: 'shared-provider',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'shared-provider',
      customName: 'old-session-name',
      customUrl: '',
      apiKey: 'session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest falls back to provider secret for custom provider when mode-level key is empty', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
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

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'provider-key')
})

test('resolveOpenAICompatibleRequest prefers configured custom mode key over provider secret', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: 'mode-key',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'mode-key')
})

test('resolveOpenAICompatibleRequest preserves session key when matched custom mode has no saved key', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {},
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest ignores active-state differences when matching configured custom mode', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'updated-provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'myproxy',
        active: false,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.apiKey, 'updated-provider-key')
})

test('resolveOpenAICompatibleRequest falls back to provider secret when providerId was migrated but provider still resolves', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Legacy OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'openai-2': 'updated-provider-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'renamed-model',
        customUrl: '',
        apiKey: '',
        providerId: 'openai-2',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'old-model-name',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai-2')
  assert.equal(resolved.apiKey, 'updated-provider-key')
})

test('resolveOpenAICompatibleRequest resolves custom provider by legacy customUrl when session provider id collides with builtin id', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Legacy OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'openai-2': 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai-2')
  assert.equal(resolved.secretProviderId, 'openai-2')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})

test('resolveOpenAICompatibleRequest recovers orphaned custom session with builtin-like stale provider id', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.secretProviderId, 'openai')
  assert.equal(resolved.provider.id, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions/')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest keeps configured mode key during builtin-like customUrl recovery', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        providerId: 'openai',
        customName: 'orphaned-proxy-model',
        customUrl: '',
        apiKey: 'configured-mode-key',
        active: true,
      },
    ],
    customOpenAIProviders: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.secretProviderId, 'openai')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions/')
  assert.equal(resolved.apiKey, 'configured-mode-key')
})

test('resolveOpenAICompatibleRequest does not send builtin secret to recovered customUrl', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      openai: 'recovered-shared-key',
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.secretProviderId, 'openai')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions/')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest uses session key for recovered customUrl before builtin secret', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      openai: 'recovered-shared-key',
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
      apiKey: 'session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.secretProviderId, 'openai')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions/')
  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest ignores empty builtin secret entry during customUrl recovery', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      openai: '',
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
      apiKey: 'session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.secretProviderId, 'openai')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions/')
  assert.equal(resolved.apiKey, 'session-key')
})

test('resolveOpenAICompatibleRequest uses legacy custom key when builtin secret entry is empty', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      openai: '',
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions/')
  assert.equal(resolved.secretProviderId, 'openai')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest matches legacy customUrl session by mode-level apiKey', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'proxy-a': 'key-a',
      'proxy-b': 'key-b',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'key-b',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'proxy-b')
  assert.equal(resolved.apiKey, 'key-b')
})

test('resolveOpenAICompatibleRequest resolves renamed custom provider before falling back to builtin provider', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Legacy OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'openai-2': 'proxy-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'openai-2',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai-2')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})

test('resolveOpenAICompatibleRequest does not fall back to builtin provider when custom provider cannot be safely recovered', () => {
  const config = {
    providerSecrets: {
      openai: 'builtin-openai-key',
    },
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Legacy OpenAI Proxy',
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
        customName: 'renamed-proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'openai-2',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'missing-session-label',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest does not recover builtin-like stale provider id when customUrl matches disabled custom provider', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Disabled Legacy OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: false,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'disabled-proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest recovers orphaned custom session when enabled provider direct url changed but derived url still matches', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Renamed Proxy',
        chatCompletionsUrl: 'https://new-proxy.example.com/v1/chat/completions',
        baseUrl: 'https://old-proxy.example.com',
        chatCompletionsPath: '/v1/chat/completions',
        completionsUrl: 'https://new-proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://old-proxy.example.com/v1/chat/completions',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://old-proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest recovers orphaned custom session when disabled provider direct url changed but derived url still matches', () => {
  const config = {
    customModelApiUrl: 'https://fallback.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Disabled Renamed Proxy',
        chatCompletionsUrl: 'https://new-proxy.example.com/v1/chat/completions',
        baseUrl: 'https://old-proxy.example.com',
        chatCompletionsPath: '/v1/chat/completions',
        completionsUrl: 'https://new-proxy.example.com/v1/completions',
        enabled: false,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'orphaned-proxy-model',
      customUrl: 'https://old-proxy.example.com/v1/chat/completions',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://old-proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest recovers legacy custom default provider from label-matched configured mode', () => {
  const config = {
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'legacy-proxy',
        customUrl: '',
        apiKey: '',
        providerId: 'legacy-custom-default',
        active: true,
      },
    ],
    customModelApiUrl: 'https://legacy-proxy.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'openai',
      customName: 'legacy-proxy',
      customUrl: '',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://legacy-proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest uses global legacy custom url when label recovery hits legacy-custom-default with stale session customUrl', () => {
  const config = {
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'legacy-proxy',
        customUrl: '',
        apiKey: '',
        providerId: 'legacy-custom-default',
        active: true,
      },
    ],
    customModelApiUrl: 'https://new-legacy-proxy.example.com/v1/chat/completions',
    providerSecrets: {
      'legacy-custom-default': 'legacy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-proxy',
      customName: 'legacy-proxy',
      customUrl: 'https://old-legacy-proxy.example.com/v1/chat/completions',
      apiKey: 'stale-session-key',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'legacy-custom-default')
  assert.equal(resolved.requestUrl, 'https://new-legacy-proxy.example.com/v1/chat/completions')
  assert.notEqual(resolved.requestUrl, session.apiMode.customUrl)
  assert.equal(resolved.apiKey, 'legacy-key')
})

test('resolveOpenAICompatibleRequest prefers label recovery when multiple providers share a legacy custom url', () => {
  const sharedUrl = 'https://shared-proxy.example.com/v1/chat/completions'
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: sharedUrl,
        completionsUrl: 'https://shared-proxy.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: sharedUrl,
        completionsUrl: 'https://shared-proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-b-mode',
        customUrl: '',
        apiKey: '',
        providerId: 'proxy-b',
        active: true,
      },
    ],
    providerSecrets: {
      'proxy-b': 'proxy-b-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'proxy-b-mode',
      customUrl: sharedUrl,
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'proxy-b')
  assert.equal(resolved.requestUrl, sharedUrl)
  assert.equal(resolved.apiKey, 'proxy-b-key')
})

test('resolveOpenAICompatibleRequest recovers renamed custom provider for legacy session without itemName and isCustom', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Legacy OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'openai-2': 'proxy-key',
    },
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'proxy-model',
        customUrl: '',
        apiKey: '',
        providerId: 'openai-2',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: '',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai-2')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})

test('resolveOpenAICompatibleRequest keeps fail-closed behavior when legacy label recovery is ambiguous', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: 'https://proxy-a.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy-a.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: 'https://proxy-b.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy-b.example.com/v1/completions',
        enabled: true,
      },
    ],
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'shared-label',
        customUrl: '',
        apiKey: '',
        providerId: 'proxy-a',
        active: true,
      },
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'shared-label',
        customUrl: '',
        apiKey: '',
        providerId: 'proxy-b',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'shared-label',
      customUrl: '',
      apiKey: 'stale-session-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest fails closed when shared legacy custom url remains ambiguous', () => {
  const sharedUrl = 'https://shared-proxy.example.com/v1/chat/completions'
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: sharedUrl,
        completionsUrl: 'https://shared-proxy.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: sharedUrl,
        completionsUrl: 'https://shared-proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    customApiModes: [
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'shared-label',
        customUrl: '',
        apiKey: '',
        providerId: 'proxy-a',
        active: true,
      },
      {
        groupName: 'customApiModelKeys',
        itemName: 'customModel',
        isCustom: true,
        customName: 'shared-label',
        customUrl: '',
        apiKey: '',
        providerId: 'proxy-b',
        active: true,
      },
    ],
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'missing-provider',
      customName: 'shared-label',
      customUrl: sharedUrl,
      apiKey: '',
      active: true,
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest fails closed when legacy customUrl has only provider secrets and no session key signal', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'legacy-custom-default': 'key-b',
      'proxy-a': 'key-a',
      'proxy-b': 'key-b',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest fails closed when legacy customUrl session has no key signal', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'proxy-a': 'key-a',
      'proxy-b': 'key-b',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest fails closed when legacy customUrl key signal matches multiple providers', () => {
  const sharedUrl = 'https://proxy.example.com/v1/chat/completions'
  const config = {
    customOpenAIProviders: [
      {
        id: 'proxy-a',
        name: 'Proxy A',
        chatCompletionsUrl: sharedUrl,
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
      {
        id: 'proxy-b',
        name: 'Proxy B',
        chatCompletionsUrl: sharedUrl,
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'proxy-a': 'shared-key',
      'proxy-b': 'shared-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'proxy-model',
      customUrl: sharedUrl,
      apiKey: 'shared-key',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved, null)
})

test('resolveOpenAICompatibleRequest avoids duplicate /v1 for OpenAI base URL with /v1 suffix', () => {
  const config = {
    customOpenAiApiUrl: 'https://api.openai.com/v1/',
    providerSecrets: {
      openai: 'openai-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'chatgptApi4oMini',
      providerId: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.requestUrl, 'https://api.openai.com/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest falls back to default OpenAI base URL for whitespace config', () => {
  const config = {
    customOpenAiApiUrl: '   ',
  }
  const session = {
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'chatgptApi4oMini',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.requestUrl, 'https://api.openai.com/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest avoids duplicate /v1 for OpenAI completion URL with /v1 suffix', () => {
  const config = {
    customOpenAiApiUrl: 'https://api.openai.com/v1/',
    providerSecrets: {
      openai: 'openai-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'gptApiModelKeys',
      itemName: 'gptApiInstruct',
      providerId: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.endpointType, 'completion')
  assert.equal(resolved.requestUrl, 'https://api.openai.com/v1/completions')
})

test('resolveOpenAICompatibleRequest avoids duplicate /v1 for Ollama endpoint with /v1 suffix', () => {
  const config = {
    ollamaEndpoint: 'http://127.0.0.1:11434/v1/',
  }
  const session = {
    apiMode: {
      groupName: 'ollamaApiModelKeys',
      itemName: 'ollama',
      providerId: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'ollama')
  assert.equal(resolved.requestUrl, 'http://127.0.0.1:11434/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest falls back to default Ollama endpoint for whitespace config', () => {
  const config = {
    ollamaEndpoint: '   ',
  }
  const session = {
    apiMode: {
      groupName: 'ollamaApiModelKeys',
      itemName: 'ollama',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'ollama')
  assert.equal(resolved.requestUrl, 'http://127.0.0.1:11434/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest avoids duplicate /v1 for custom provider baseUrl with default paths', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        baseUrl: 'https://proxy.example.com/v1/',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
})

test('resolveOpenAICompatibleRequest preserves /v1 for custom provider baseUrl with explicit non-default paths', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        baseUrl: 'https://proxy.example.com/v1/',
        chatCompletionsPath: '/chat/completions',
        completionsPath: '/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      providerId: 'myproxy',
      customName: 'proxy-model',
      customUrl: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
})
