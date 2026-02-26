import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
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

test('resolveOpenAICompatibleRequest ignores derived customUrl match when provider has a different direct chat url', () => {
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

test('resolveOpenAICompatibleRequest preserves stored customUrl for unrecovered legacy custom sessions', () => {
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

test('resolveOpenAICompatibleRequest preserves saved customUrl when label recovery lands on legacy-custom-default', () => {
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
  assert.equal(resolved.requestUrl, 'https://saved-session.example.com/v1/chat/completions')
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
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
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

test('resolveOpenAICompatibleRequest keeps URL-first fallback when only legacy custom provider secret is available', () => {
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

  assert.equal(resolved.providerId, 'proxy-a')
  assert.equal(resolved.apiKey, 'key-a')
})

test('resolveOpenAICompatibleRequest keeps URL-first fallback when legacy customUrl session has no key signal', () => {
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

  assert.equal(resolved.providerId, 'proxy-a')
  assert.equal(resolved.apiKey, 'key-a')
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
