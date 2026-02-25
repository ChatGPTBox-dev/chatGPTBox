import {
  LEGACY_API_KEY_FIELD_BY_PROVIDER_ID,
  OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID,
} from '../../config/openai-provider-mappings.mjs'

export { OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID }

const DEFAULT_CHAT_PATH = '/v1/chat/completions'
const DEFAULT_COMPLETION_PATH = '/v1/completions'

const BUILTIN_PROVIDER_TEMPLATE = [
  {
    id: 'openai',
    name: 'OpenAI',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/v1/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'moonshot',
    name: 'Kimi.Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'aiml',
    name: 'AI/ML',
    baseUrl: 'https://api.aimlapi.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'chatglm',
    name: 'ChatGLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
  },
  {
    id: 'legacy-custom-default',
    name: 'Custom Model (Legacy)',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/completions',
    builtin: true,
    enabled: true,
    allowLegacyResponseField: true,
  },
]

function getModelNamePresetPart(modelName) {
  const value = toStringOrEmpty(modelName)
  const separatorIndex = value.indexOf('-')
  return separatorIndex === -1 ? value : value.substring(0, separatorIndex)
}

function resolveProviderIdFromLegacyModelName(modelName) {
  const rawModelName = toStringOrEmpty(modelName)
  if (!rawModelName) return null
  if (rawModelName === 'customModel') return 'legacy-custom-default'

  const preset = getModelNamePresetPart(rawModelName)

  if (
    preset === 'gptApiInstruct' ||
    preset.startsWith('chatgptApi') ||
    preset === 'gptApiModelKeys'
  ) {
    return 'openai'
  }
  if (preset.startsWith('deepseek_') || preset === 'deepSeekApiModelKeys') return 'deepseek'
  if (preset.startsWith('moonshot_') || preset === 'moonshotApiModelKeys') return 'moonshot'
  if (preset.startsWith('openRouter_') || preset === 'openRouterApiModelKeys') return 'openrouter'
  if (preset.startsWith('aiml_') || preset === 'aimlModelKeys' || preset === 'aimlApiModelKeys') {
    return 'aiml'
  }
  if (preset === 'ollama' || preset === 'ollamaModel' || preset === 'ollamaApiModelKeys') {
    return 'ollama'
  }
  if (preset.startsWith('chatglm') || preset === 'chatglmApiModelKeys') return 'chatglm'
  if (preset === 'customApiModelKeys') return 'legacy-custom-default'

  return null
}

function isLegacyCompletionModelName(modelName) {
  const preset = getModelNamePresetPart(modelName)
  return preset === 'gptApiInstruct' || preset === 'gptApiModelKeys'
}

function toStringOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

function normalizeProviderId(value) {
  return toStringOrEmpty(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeEndpointUrlForCompare(value) {
  return toStringOrEmpty(value).trim().replace(/\/+$/, '')
}

function trimSlashes(value) {
  return toStringOrEmpty(value).trim().replace(/\/+$/, '')
}

function ensureLeadingSlash(value, fallback) {
  const raw = toStringOrEmpty(value).trim()
  if (!raw) return fallback
  return raw.startsWith('/') ? raw : `/${raw}`
}

function joinUrl(baseUrl, path) {
  if (!baseUrl) return ''
  return `${trimSlashes(baseUrl)}${ensureLeadingSlash(path, '')}`
}

function buildBuiltinProviders(config) {
  return BUILTIN_PROVIDER_TEMPLATE.map((provider) => {
    if (provider.id === 'openai') {
      return {
        ...provider,
        baseUrl: trimSlashes(config.customOpenAiApiUrl || 'https://api.openai.com'),
      }
    }
    if (provider.id === 'ollama') {
      return {
        ...provider,
        baseUrl: `${trimSlashes(config.ollamaEndpoint || 'http://127.0.0.1:11434')}/v1`,
      }
    }
    if (provider.id === 'legacy-custom-default') {
      return {
        ...provider,
        chatCompletionsUrl:
          toStringOrEmpty(config.customModelApiUrl).trim() ||
          'http://localhost:8000/v1/chat/completions',
      }
    }
    return provider
  })
}

function normalizeCustomProvider(provider, index) {
  if (!provider || typeof provider !== 'object') return null
  const id = toStringOrEmpty(provider.id).trim() || `custom-provider-${index + 1}`
  return {
    id,
    name: toStringOrEmpty(provider.name).trim() || `Custom Provider ${index + 1}`,
    baseUrl: trimSlashes(provider.baseUrl),
    chatCompletionsPath: ensureLeadingSlash(provider.chatCompletionsPath, DEFAULT_CHAT_PATH),
    completionsPath: ensureLeadingSlash(provider.completionsPath, DEFAULT_COMPLETION_PATH),
    chatCompletionsUrl: toStringOrEmpty(provider.chatCompletionsUrl).trim(),
    completionsUrl: toStringOrEmpty(provider.completionsUrl).trim(),
    builtin: false,
    enabled: provider.enabled !== false,
    allowLegacyResponseField: Boolean(provider.allowLegacyResponseField),
  }
}

export function getCustomOpenAIProviders(config) {
  const providers = Array.isArray(config.customOpenAIProviders) ? config.customOpenAIProviders : []
  return providers
    .map((provider, index) => normalizeCustomProvider(provider, index))
    .filter((provider) => provider)
}

export function getAllOpenAIProviders(config) {
  const customProviders = getCustomOpenAIProviders(config)
  return [...buildBuiltinProviders(config), ...customProviders]
}

export function resolveProviderIdForSession(session) {
  const apiMode = session?.apiMode
  if (apiMode && typeof apiMode === 'object') {
    const apiModeProviderId = toStringOrEmpty(apiMode.providerId).trim()
    if (apiMode.groupName === 'customApiModelKeys' && apiModeProviderId) return apiModeProviderId
    if (apiMode.groupName) {
      const mappedProviderId = OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID[apiMode.groupName]
      if (mappedProviderId) return mappedProviderId
    }
    if (apiModeProviderId) return apiModeProviderId
  }
  if (session?.modelName === 'customModel') return 'legacy-custom-default'
  const fromLegacyModelName = resolveProviderIdFromLegacyModelName(session?.modelName)
  if (fromLegacyModelName) return fromLegacyModelName
  return null
}

export function resolveEndpointTypeForSession(session) {
  const apiMode = session?.apiMode
  if (apiMode && typeof apiMode === 'object') {
    return apiMode.groupName === 'gptApiModelKeys' ? 'completion' : 'chat'
  }
  return isLegacyCompletionModelName(session?.modelName) ? 'completion' : 'chat'
}

export function getProviderById(config, providerId) {
  if (!providerId) return null
  const provider = getAllOpenAIProviders(config).find((item) => item.id === providerId)
  if (!provider) return null
  if (provider.enabled === false) return null
  return provider
}

export function getProviderSecret(config, providerId, session) {
  if (!providerId) return ''
  const apiModeApiKey =
    session?.apiMode && typeof session.apiMode === 'object'
      ? toStringOrEmpty(session.apiMode.apiKey).trim()
      : ''
  if (session?.apiMode?.groupName === 'customApiModelKeys' && apiModeApiKey) {
    return apiModeApiKey
  }

  const fromMap =
    config?.providerSecrets && typeof config.providerSecrets === 'object'
      ? toStringOrEmpty(config.providerSecrets[providerId]).trim()
      : ''
  if (fromMap) return fromMap
  const legacyKey = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[providerId]
  const legacyValue = legacyKey ? toStringOrEmpty(config?.[legacyKey]).trim() : ''
  if (legacyValue) return legacyValue

  return apiModeApiKey
}

function resolveUrlFromProvider(provider, endpointType, config, session) {
  if (!provider) return ''

  const apiModeCustomUrl =
    endpointType === 'chat' &&
    session?.apiMode &&
    typeof session.apiMode === 'object' &&
    session.apiMode.groupName === 'customApiModelKeys' &&
    !toStringOrEmpty(session.apiMode.providerId).trim()
      ? toStringOrEmpty(session.apiMode.customUrl).trim()
      : ''
  if (apiModeCustomUrl) return apiModeCustomUrl

  if (endpointType === 'completion') {
    if (provider.completionsUrl) return provider.completionsUrl
    if (provider.baseUrl && provider.completionsPath) {
      return joinUrl(provider.baseUrl, provider.completionsPath)
    }
  } else {
    if (provider.chatCompletionsUrl) return provider.chatCompletionsUrl
    if (provider.baseUrl && provider.chatCompletionsPath) {
      return joinUrl(provider.baseUrl, provider.chatCompletionsPath)
    }
  }

  if (provider.id === 'legacy-custom-default') {
    if (endpointType === 'completion') {
      return `${trimSlashes(config.customOpenAiApiUrl || 'https://api.openai.com')}/v1/completions`
    }
    return (
      toStringOrEmpty(config.customModelApiUrl).trim() ||
      'http://localhost:8000/v1/chat/completions'
    )
  }

  return ''
}

export function resolveOpenAICompatibleRequest(config, session) {
  const providerId = resolveProviderIdForSession(session)
  if (!providerId) return null
  let resolvedProviderId = providerId
  let provider = getProviderById(config, providerId)
  if (!provider && session?.apiMode?.groupName === 'customApiModelKeys') {
    const customProviders = getCustomOpenAIProviders(config)
    const normalizedProviderId = normalizeProviderId(providerId)
    if (normalizedProviderId) {
      const matchedByNormalizedProviderId = customProviders.find(
        (item) => item.enabled !== false && item.id === normalizedProviderId,
      )
      if (matchedByNormalizedProviderId) {
        provider = matchedByNormalizedProviderId
        resolvedProviderId = matchedByNormalizedProviderId.id
      }
    }
    if (!provider) {
      const customUrl = normalizeEndpointUrlForCompare(session?.apiMode?.customUrl)
      if (customUrl) {
        const matchedByCustomUrl = customProviders.find(
          (item) =>
            item.enabled !== false &&
            normalizeEndpointUrlForCompare(item.chatCompletionsUrl) === customUrl,
        )
        if (matchedByCustomUrl) {
          provider = matchedByCustomUrl
          resolvedProviderId = matchedByCustomUrl.id
        }
      }
    }
  }
  if (!provider) return null
  const endpointType = resolveEndpointTypeForSession(session)
  const requestUrl = resolveUrlFromProvider(provider, endpointType, config, session)
  if (!requestUrl) return null
  return {
    providerId: resolvedProviderId,
    provider,
    endpointType,
    requestUrl,
    apiKey: getProviderSecret(config, resolvedProviderId, session),
  }
}
