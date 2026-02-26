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

function normalizeStableCustomApiModeIdentity(apiMode, providerId = apiMode?.providerId) {
  if (!apiMode || typeof apiMode !== 'object') return null
  return {
    groupName: toStringOrEmpty(apiMode.groupName).trim(),
    itemName: toStringOrEmpty(apiMode.itemName).trim(),
    isCustom: Boolean(apiMode.isCustom),
    customName: toStringOrEmpty(apiMode.customName).trim(),
    providerId: normalizeProviderId(providerId),
  }
}

function getConfiguredCustomApiModes(config) {
  const customApiModes = Array.isArray(config?.customApiModes) ? config.customApiModes : []
  const selectedApiMode =
    config?.apiMode && typeof config.apiMode === 'object' ? [config.apiMode] : []
  const seen = new Set()
  return [...customApiModes, ...selectedApiMode]
    .filter((apiMode) => apiMode?.groupName === 'customApiModelKeys')
    .filter((apiMode) => {
      const signature = JSON.stringify({
        groupName: toStringOrEmpty(apiMode.groupName).trim(),
        itemName: toStringOrEmpty(apiMode.itemName).trim(),
        isCustom: Boolean(apiMode.isCustom),
        customName: toStringOrEmpty(apiMode.customName).trim(),
        providerId: normalizeProviderId(apiMode.providerId),
      })
      if (seen.has(signature)) return false
      seen.add(signature)
      return true
    })
}

function getConfiguredCustomApiModesForProvider(config, providerId) {
  const normalizedProviderId = normalizeProviderId(providerId)
  if (!normalizedProviderId) return []
  return getConfiguredCustomApiModes(config).filter(
    (apiMode) => normalizeProviderId(apiMode?.providerId) === normalizedProviderId,
  )
}

function findConfiguredCustomApiMode(config, sessionApiMode, providerId) {
  const normalizedProviderId = normalizeProviderId(providerId)
  const normalizedSessionApiMode = normalizeStableCustomApiModeIdentity(sessionApiMode, providerId)
  if (!normalizedSessionApiMode || normalizedSessionApiMode.groupName !== 'customApiModelKeys') {
    return null
  }

  const providerCandidates = getConfiguredCustomApiModesForProvider(config, normalizedProviderId)
  const exactCandidates = providerCandidates.filter((apiMode) => {
    const normalizedCandidate = normalizeStableCustomApiModeIdentity(apiMode)
    return (
      normalizedCandidate &&
      JSON.stringify(normalizedCandidate) === JSON.stringify(normalizedSessionApiMode)
    )
  })

  if (exactCandidates.length === 1) return exactCandidates[0]
  return null
}

function findConfiguredCustomApiModeBySessionLabel(config, sessionApiMode) {
  if (!sessionApiMode || typeof sessionApiMode !== 'object') return null
  if (toStringOrEmpty(sessionApiMode.groupName).trim() !== 'customApiModelKeys') return null

  const normalizedSessionLabel = {
    groupName: toStringOrEmpty(sessionApiMode.groupName).trim(),
    itemName: toStringOrEmpty(sessionApiMode.itemName).trim(),
    isCustom: Boolean(sessionApiMode.isCustom),
    customName: toStringOrEmpty(sessionApiMode.customName).trim(),
  }
  const allCandidates = getConfiguredCustomApiModes(config).filter((apiMode) => {
    if (!apiMode || typeof apiMode !== 'object') return false
    return (
      toStringOrEmpty(apiMode.groupName).trim() === normalizedSessionLabel.groupName &&
      toStringOrEmpty(apiMode.customName).trim() === normalizedSessionLabel.customName
    )
  })

  const exactCandidates = allCandidates.filter(
    (apiMode) =>
      toStringOrEmpty(apiMode.itemName).trim() === normalizedSessionLabel.itemName &&
      Boolean(apiMode.isCustom) === normalizedSessionLabel.isCustom,
  )
  if (exactCandidates.length === 1) return exactCandidates[0]

  const isLegacyCustomShape = !normalizedSessionLabel.itemName
  if (isLegacyCustomShape && allCandidates.length === 1) return allCandidates[0]

  return null
}

function trimSlashes(value) {
  return toStringOrEmpty(value).trim().replace(/\/+$/, '')
}

function normalizeBaseUrlWithoutVersionSuffix(value, fallback) {
  const normalizedValue = trimSlashes(value)
  const normalizedFallback = trimSlashes(fallback)
  return (normalizedValue || normalizedFallback).replace(/\/v1$/i, '')
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
      const baseUrl = normalizeBaseUrlWithoutVersionSuffix(
        config.customOpenAiApiUrl,
        'https://api.openai.com',
      )
      return {
        ...provider,
        baseUrl,
      }
    }
    if (provider.id === 'ollama') {
      const baseUrl = normalizeBaseUrlWithoutVersionSuffix(
        config.ollamaEndpoint,
        'http://127.0.0.1:11434',
      )
      return {
        ...provider,
        baseUrl: `${baseUrl}/v1`,
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
  const sourceProviderId = normalizeProviderId(provider.sourceProviderId)
  const chatCompletionsPath = ensureLeadingSlash(provider.chatCompletionsPath, DEFAULT_CHAT_PATH)
  const completionsPath = ensureLeadingSlash(provider.completionsPath, DEFAULT_COMPLETION_PATH)
  const chatCompletionsUrl = toStringOrEmpty(provider.chatCompletionsUrl).trim()
  const completionsUrl = toStringOrEmpty(provider.completionsUrl).trim()
  let baseUrl = trimSlashes(provider.baseUrl)

  if (!chatCompletionsUrl && !completionsUrl) {
    const usesDefaultV1Paths =
      chatCompletionsPath === DEFAULT_CHAT_PATH && completionsPath === DEFAULT_COMPLETION_PATH
    if (usesDefaultV1Paths) {
      baseUrl = normalizeBaseUrlWithoutVersionSuffix(baseUrl, '')
    }
  }
  return {
    id,
    name: toStringOrEmpty(provider.name).trim() || `Custom Provider ${index + 1}`,
    baseUrl,
    chatCompletionsPath,
    completionsPath,
    chatCompletionsUrl,
    completionsUrl,
    builtin: false,
    enabled: provider.enabled !== false,
    allowLegacyResponseField: provider.allowLegacyResponseField !== false,
    ...(sourceProviderId ? { sourceProviderId } : {}),
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
  const normalizedProviderId = normalizeProviderId(providerId)
  const provider = getAllOpenAIProviders(config).find(
    (item) => item.id === providerId || normalizeProviderId(item.id) === normalizedProviderId,
  )
  if (!provider) return null
  if (provider.enabled === false) return null
  return provider
}

function getConfiguredProviderSecret(config, providerId) {
  if (!providerId) return ''
  const hasProviderSecretsMap =
    config?.providerSecrets && typeof config.providerSecrets === 'object'
  if (hasProviderSecretsMap && Object.hasOwn(config.providerSecrets, providerId)) {
    return toStringOrEmpty(config.providerSecrets[providerId]).trim()
  }
  const legacyKey = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[providerId]
  return legacyKey ? toStringOrEmpty(config?.[legacyKey]).trim() : ''
}

function hasConfiguredProviderSecretEntry(config, providerId) {
  return Boolean(
    providerId &&
      config?.providerSecrets &&
      typeof config.providerSecrets === 'object' &&
      Object.hasOwn(config.providerSecrets, providerId),
  )
}

export function getProviderSecret(config, providerId, session) {
  if (!providerId) return ''
  const normalizedProviderId = normalizeProviderId(providerId)
  const apiModeApiKey =
    session?.apiMode && typeof session.apiMode === 'object'
      ? toStringOrEmpty(session.apiMode.apiKey).trim()
      : ''
  const hasConfiguredSecretEntry = hasConfiguredProviderSecretEntry(config, normalizedProviderId)
  const configuredSecret = getConfiguredProviderSecret(config, normalizedProviderId)
  if (session?.apiMode?.groupName === 'customApiModelKeys') {
    const configuredCustomApiMode = findConfiguredCustomApiMode(
      config,
      session.apiMode,
      normalizedProviderId,
    )
    if (configuredCustomApiMode) {
      const configuredModeApiKey = toStringOrEmpty(configuredCustomApiMode.apiKey).trim()
      if (configuredModeApiKey) return configuredModeApiKey
      if (configuredSecret || hasConfiguredSecretEntry) return configuredSecret
      return apiModeApiKey
    }
    const providerCandidates = getConfiguredCustomApiModesForProvider(config, normalizedProviderId)
    if (providerCandidates.length > 0) {
      const hasAnyModeSpecificKey = providerCandidates.some((apiMode) =>
        toStringOrEmpty(apiMode.apiKey).trim(),
      )
      if (!hasAnyModeSpecificKey && (configuredSecret || hasConfiguredSecretEntry)) {
        return configuredSecret
      }
    }
    if (apiModeApiKey) return apiModeApiKey
    return configuredSecret
  }
  if (configuredSecret || hasConfiguredSecretEntry) return configuredSecret

  return ''
}

function resolveRecoveredCustomUrlApiKey(config, recoveredProviderId, fallbackProviderId, session) {
  const normalizedRecoveredProviderId = normalizeProviderId(recoveredProviderId)
  const normalizedFallbackProviderId = normalizeProviderId(fallbackProviderId)
  if (!normalizedRecoveredProviderId) return ''
  const sessionApiKey = toStringOrEmpty(session?.apiMode?.apiKey).trim()
  const shouldIgnoreRecoveredConfiguredSecret =
    session?.apiMode?.groupName === 'customApiModelKeys' &&
    normalizedFallbackProviderId === 'legacy-custom-default'
  if (
    !normalizedFallbackProviderId ||
    normalizedFallbackProviderId === normalizedRecoveredProviderId
  ) {
    return getProviderSecret(config, normalizedRecoveredProviderId, session)
  }

  const hasRecoveredConfiguredSecretEntry = hasConfiguredProviderSecretEntry(
    config,
    normalizedRecoveredProviderId,
  )
  if (shouldIgnoreRecoveredConfiguredSecret) {
    const configuredCustomApiMode = findConfiguredCustomApiMode(
      config,
      session?.apiMode,
      normalizedRecoveredProviderId,
    )
    const configuredModeApiKey = toStringOrEmpty(configuredCustomApiMode?.apiKey).trim()
    if (configuredModeApiKey) return configuredModeApiKey
    if (sessionApiKey) return sessionApiKey
    return getProviderSecret(config, normalizedFallbackProviderId, session)
  }

  const recoveredSecret = getProviderSecret(config, normalizedRecoveredProviderId, session)
  if (recoveredSecret) return recoveredSecret
  if (hasRecoveredConfiguredSecretEntry) return recoveredSecret
  if (sessionApiKey) return sessionApiKey

  return getProviderSecret(config, normalizedFallbackProviderId, session)
}

function getCustomProvidersMatchedByLegacySessionUrl(customProviders, session) {
  const customUrl = normalizeEndpointUrlForCompare(session?.apiMode?.customUrl)
  if (!customUrl) return []

  return customProviders.filter((item) => {
    if (item.enabled === false) return false

    const directChatCompletionsUrl = normalizeEndpointUrlForCompare(item.chatCompletionsUrl)
    if (directChatCompletionsUrl && directChatCompletionsUrl === customUrl) return true
    if (directChatCompletionsUrl) return false

    const derivedChatCompletionsUrl =
      item.baseUrl && item.chatCompletionsPath
        ? normalizeEndpointUrlForCompare(joinUrl(item.baseUrl, item.chatCompletionsPath))
        : ''

    return derivedChatCompletionsUrl && derivedChatCompletionsUrl === customUrl
  })
}

function resolveCustomProviderByLegacySessionUrl(customProviders, config, session) {
  const matchedProviders = getCustomProvidersMatchedByLegacySessionUrl(customProviders, session)
  if (matchedProviders.length <= 1) {
    return matchedProviders[0] || null
  }

  const sessionApiKey = toStringOrEmpty(session?.apiMode?.apiKey).trim()
  if (sessionApiKey) {
    const matchedBySessionKey = matchedProviders.filter(
      (item) => getConfiguredProviderSecret(config, item.id) === sessionApiKey,
    )
    if (matchedBySessionKey.length === 1) {
      return matchedBySessionKey[0]
    }
  }

  return null
}

function hasAmbiguousCustomProviderMatchByLegacySessionUrl(customProviders, config, session) {
  const matchedProviders = getCustomProvidersMatchedByLegacySessionUrl(customProviders, session)
  if (matchedProviders.length <= 1) return false

  const sessionApiKey = toStringOrEmpty(session?.apiMode?.apiKey).trim()
  if (!sessionApiKey) return true

  const matchedBySessionKey = matchedProviders.filter(
    (item) => getConfiguredProviderSecret(config, item.id) === sessionApiKey,
  )
  return matchedBySessionKey.length !== 1
}

function hasDisabledCustomProviderMatchByLegacySessionUrl(customProviders, session) {
  const customUrl = normalizeEndpointUrlForCompare(session?.apiMode?.customUrl)
  if (!customUrl) return false

  return customProviders.some((item) => {
    if (item.enabled !== false) return false

    const directChatCompletionsUrl = normalizeEndpointUrlForCompare(item.chatCompletionsUrl)
    if (directChatCompletionsUrl && directChatCompletionsUrl === customUrl) return true
    if (directChatCompletionsUrl) return false

    const derivedChatCompletionsUrl =
      item.baseUrl && item.chatCompletionsPath
        ? normalizeEndpointUrlForCompare(joinUrl(item.baseUrl, item.chatCompletionsPath))
        : ''

    return derivedChatCompletionsUrl && derivedChatCompletionsUrl === customUrl
  })
}

function hasEnabledCustomProviderMatchByLegacySessionUrl(customProviders, session) {
  const customUrl = normalizeEndpointUrlForCompare(session?.apiMode?.customUrl)
  if (!customUrl) return false

  return customProviders.some((item) => {
    if (item.enabled === false) return false

    const directChatCompletionsUrl = normalizeEndpointUrlForCompare(item.chatCompletionsUrl)
    if (directChatCompletionsUrl && directChatCompletionsUrl === customUrl) return true
    if (directChatCompletionsUrl) return false

    const derivedChatCompletionsUrl =
      item.baseUrl && item.chatCompletionsPath
        ? normalizeEndpointUrlForCompare(joinUrl(item.baseUrl, item.chatCompletionsPath))
        : ''

    return derivedChatCompletionsUrl && derivedChatCompletionsUrl === customUrl
  })
}

export function getOpenAICompatibleRequestDiagnostic(config, session) {
  const apiMode = session?.apiMode && typeof session.apiMode === 'object' ? session.apiMode : null
  const rawProviderId = apiMode ? toStringOrEmpty(apiMode.providerId) : ''
  const normalizedProviderId = normalizeProviderId(rawProviderId)
  const customProviders = getCustomOpenAIProviders(config)

  return {
    groupName: apiMode ? toStringOrEmpty(apiMode.groupName).trim() : '',
    rawProviderId,
    normalizedProviderId,
    modelName: toStringOrEmpty(session?.modelName).trim(),
    hasCustomUrl: Boolean(normalizeEndpointUrlForCompare(apiMode?.customUrl)),
    hasMatchingCustomProvider: normalizedProviderId
      ? customProviders.some(
          (item) => item.enabled !== false && normalizeProviderId(item.id) === normalizedProviderId,
        )
      : false,
    hasDisabledMatchingCustomProvider: normalizedProviderId
      ? Array.isArray(config?.customOpenAIProviders) &&
        config.customOpenAIProviders.some(
          (item) =>
            item?.enabled === false && normalizeProviderId(item?.id) === normalizedProviderId,
        )
      : false,
    hasMatchingCustomProviderByLegacyUrl: hasEnabledCustomProviderMatchByLegacySessionUrl(
      customProviders,
      session,
    ),
    hasDisabledMatchingCustomProviderByLegacyUrl: hasDisabledCustomProviderMatchByLegacySessionUrl(
      customProviders,
      session,
    ),
  }
}

function resolveUrlFromProvider(
  provider,
  endpointType,
  config,
  session,
  useLegacyCustomUrlFallback = false,
) {
  if (!provider) return ''

  const apiModeCustomUrl =
    endpointType === 'chat' &&
    session?.apiMode &&
    typeof session.apiMode === 'object' &&
    session.apiMode.groupName === 'customApiModelKeys' &&
    useLegacyCustomUrlFallback
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
      const baseUrl = normalizeBaseUrlWithoutVersionSuffix(
        config.customOpenAiApiUrl,
        'https://api.openai.com',
      )
      return `${baseUrl}/v1/completions`
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
  let provider = null
  let useLegacyCustomUrlFallback = false
  let recoveredProviderId = ''
  if (session?.apiMode?.groupName === 'customApiModelKeys') {
    const customProviders = getCustomOpenAIProviders(config)
    const hasAmbiguousLegacyCustomUrlMatch = hasAmbiguousCustomProviderMatchByLegacySessionUrl(
      customProviders,
      config,
      session,
    )
    const matchedByProviderId = customProviders.find(
      (item) => item.enabled !== false && item.id === providerId,
    )
    if (matchedByProviderId) {
      provider = matchedByProviderId
      resolvedProviderId = matchedByProviderId.id
    }
    const normalizedProviderId = normalizeProviderId(providerId)
    if (!provider && normalizedProviderId) {
      const matchedByNormalizedProviderId = customProviders.find(
        (item) => item.enabled !== false && item.id === normalizedProviderId,
      )
      if (matchedByNormalizedProviderId) {
        provider = matchedByNormalizedProviderId
        resolvedProviderId = matchedByNormalizedProviderId.id
      }
    }
    if (!provider && !hasAmbiguousLegacyCustomUrlMatch) {
      const matchedByCustomUrl = resolveCustomProviderByLegacySessionUrl(
        customProviders,
        config,
        session,
      )
      if (matchedByCustomUrl) {
        provider = matchedByCustomUrl
        resolvedProviderId = matchedByCustomUrl.id
      }
    }
    if (!provider) {
      const matchedConfiguredApiMode = findConfiguredCustomApiModeBySessionLabel(
        config,
        session?.apiMode,
      )
      const matchedConfiguredProviderId = normalizeProviderId(matchedConfiguredApiMode?.providerId)
      if (matchedConfiguredProviderId) {
        const matchedConfiguredProvider = customProviders.find(
          (item) => item.enabled !== false && item.id === matchedConfiguredProviderId,
        )
        if (matchedConfiguredProvider) {
          provider = matchedConfiguredProvider
          resolvedProviderId = matchedConfiguredProvider.id
        } else if (matchedConfiguredProviderId === 'legacy-custom-default') {
          provider = getProviderById(config, matchedConfiguredProviderId)
          if (provider) {
            resolvedProviderId = matchedConfiguredProviderId
          }
        }
      }
    }
    if (!provider && hasAmbiguousLegacyCustomUrlMatch) {
      const matchedByCustomUrl = resolveCustomProviderByLegacySessionUrl(
        customProviders,
        config,
        session,
      )
      if (matchedByCustomUrl) {
        provider = matchedByCustomUrl
        resolvedProviderId = matchedByCustomUrl.id
      }
    }
    if (!provider) {
      const normalizedProviderId = normalizeProviderId(providerId)
      const hasDisabledCustomProviderMatch = Array.isArray(config?.customOpenAIProviders)
        ? config.customOpenAIProviders.some(
            (item) =>
              normalizeProviderId(item?.id) === normalizedProviderId && item?.enabled === false,
          )
        : false
      const hasDisabledCustomProviderMatchByUrl = hasDisabledCustomProviderMatchByLegacySessionUrl(
        customProviders,
        session,
      )
      const hasEnabledCustomProviderMatchByUrl = hasEnabledCustomProviderMatchByLegacySessionUrl(
        customProviders,
        session,
      )
      const matchedBuiltinProvider = normalizedProviderId
        ? getProviderById(config, normalizedProviderId)
        : null
      const canRecoverByLegacyCustomUrl =
        resolveEndpointTypeForSession(session) === 'chat' &&
        toStringOrEmpty(session?.apiMode?.customUrl).trim() &&
        !hasDisabledCustomProviderMatch &&
        !hasDisabledCustomProviderMatchByUrl &&
        !hasEnabledCustomProviderMatchByUrl &&
        (matchedBuiltinProvider?.builtin !== true ||
          session?.apiMode?.groupName === 'customApiModelKeys')
      if (normalizeProviderId(providerId) === 'legacy-custom-default') {
        provider = getProviderById(config, normalizedProviderId)
        if (provider) {
          resolvedProviderId = normalizedProviderId
        }
        if (
          provider &&
          resolveEndpointTypeForSession(session) === 'chat' &&
          toStringOrEmpty(session?.apiMode?.customUrl).trim()
        ) {
          useLegacyCustomUrlFallback = true
        }
      } else if (canRecoverByLegacyCustomUrl) {
        provider = getProviderById(config, 'legacy-custom-default')
        if (provider) {
          recoveredProviderId = resolvedProviderId
          resolvedProviderId = 'legacy-custom-default'
          useLegacyCustomUrlFallback = true
        }
      } else {
        return null
      }
    }
  }
  if (!provider) {
    provider = getProviderById(config, providerId)
  }
  if (!provider) return null
  const endpointType = resolveEndpointTypeForSession(session)
  const requestUrl = resolveUrlFromProvider(
    provider,
    endpointType,
    config,
    session,
    useLegacyCustomUrlFallback,
  )
  if (!requestUrl) return null
  return {
    providerId: resolvedProviderId,
    secretProviderId: normalizeProviderId(recoveredProviderId || resolvedProviderId),
    provider,
    endpointType,
    requestUrl,
    apiKey: recoveredProviderId
      ? resolveRecoveredCustomUrlApiKey(config, recoveredProviderId, resolvedProviderId, session)
      : getProviderSecret(config, resolvedProviderId, session),
  }
}
