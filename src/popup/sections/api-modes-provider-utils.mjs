function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeProviderId(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeProviderEndpointUrl(value) {
  return normalizeText(value).replace(/\/+$/, '')
}

function ensureLeadingSlash(value, fallback) {
  const normalized = normalizeText(value)
  if (!normalized) return fallback
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function createProviderId(providerName, existingProviders, reservedProviderIds = []) {
  const usedIds = new Set([
    ...reservedProviderIds.map((providerId) => normalizeProviderId(providerId)),
    ...existingProviders.map((provider) => normalizeProviderId(provider.id)),
  ])

  const baseId =
    normalizeProviderId(providerName) || `custom-provider-${existingProviders.length + 1}`
  let nextId = baseId
  let suffix = 2
  while (usedIds.has(nextId)) {
    nextId = `${baseId}-${suffix}`
    suffix += 1
  }
  return nextId
}

export function resolveSelectableProviderId(providerId, providers, fallbackProviderId = '') {
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return fallbackProviderId
  const hasMatchedProvider =
    Array.isArray(providers) &&
    providers.some((provider) => normalizeText(provider?.id) === normalizedProviderId)
  return hasMatchedProvider ? normalizedProviderId : fallbackProviderId
}

export function applyPendingProviderChanges(
  providers,
  pendingEditedProvidersById = {},
  pendingNewProvider = null,
) {
  const baseProviders = Array.isArray(providers) ? providers : []
  const editedProviders =
    pendingEditedProvidersById && typeof pendingEditedProvidersById === 'object'
      ? pendingEditedProvidersById
      : {}

  const effectiveProviders = baseProviders.map((provider) => {
    const providerId = normalizeText(provider?.id)
    return providerId && editedProviders[providerId] ? editedProviders[providerId] : provider
  })

  if (!pendingNewProvider || typeof pendingNewProvider !== 'object') {
    return effectiveProviders
  }

  const pendingNewProviderId = normalizeText(pendingNewProvider.id)
  if (!pendingNewProviderId) return effectiveProviders

  const existingProviderIndex = effectiveProviders.findIndex(
    (provider) => normalizeText(provider?.id) === pendingNewProviderId,
  )
  if (existingProviderIndex !== -1) {
    effectiveProviders[existingProviderIndex] = pendingNewProvider
    return effectiveProviders
  }

  return [...effectiveProviders, pendingNewProvider]
}

export function shouldPersistPendingProviderChanges(apiMode, hasPendingProviderChanges) {
  if (!hasPendingProviderChanges) return false
  return normalizeText(apiMode?.groupName) === 'customApiModelKeys'
}

export function resolveEditingProviderIdForGroupChange(
  groupName,
  currentProviderId,
  fallbackProviderId = '',
) {
  const normalizedProviderId = normalizeText(currentProviderId)
  if (normalizeText(groupName) === 'customApiModelKeys') {
    return normalizedProviderId || fallbackProviderId
  }
  return normalizedProviderId
}

export function parseChatCompletionsEndpointUrl(value) {
  const normalizedUrl = normalizeProviderEndpointUrl(value)
  if (!normalizedUrl) return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }

  let parsedUrl
  try {
    parsedUrl = new URL(normalizedUrl)
  } catch {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  if (parsedUrl.hash) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, '')
  if (!/\/chat\/completions$/i.test(normalizedPathname)) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  parsedUrl.pathname = normalizedPathname
  const chatCompletionsUrl = parsedUrl.toString().replace(/\/+$/, '')
  const parsedCompletionUrl = new URL(chatCompletionsUrl)
  parsedCompletionUrl.pathname = parsedCompletionUrl.pathname.replace(
    /\/chat\/completions$/i,
    '/completions',
  )
  const completionsUrl = parsedCompletionUrl.toString().replace(/\/+$/, '')
  return { valid: true, chatCompletionsUrl, completionsUrl }
}

export function resolveProviderChatEndpointUrl(provider) {
  if (!provider || typeof provider !== 'object') return ''
  const explicitUrl = normalizeProviderEndpointUrl(provider.chatCompletionsUrl)
  if (explicitUrl) return explicitUrl

  const baseUrl = normalizeProviderEndpointUrl(provider.baseUrl)
  if (!baseUrl) return ''
  const chatPath = ensureLeadingSlash(provider.chatCompletionsPath, '/v1/chat/completions')
  return `${baseUrl}${chatPath}`
}

export function buildEditedProvider(
  existingProvider,
  providerId,
  providerName,
  parsedEndpoint,
  nextApiUrl,
) {
  const normalizedNextApiUrl = normalizeProviderEndpointUrl(nextApiUrl)
  const existingApiUrl = resolveProviderChatEndpointUrl(existingProvider)
  const urlChanged = normalizedNextApiUrl !== existingApiUrl

  const updatedProvider = {
    ...(existingProvider || {}),
    id: providerId,
    name: providerName,
  }

  if (!urlChanged) return updatedProvider

  updatedProvider.baseUrl = ''
  updatedProvider.chatCompletionsUrl = parsedEndpoint.chatCompletionsUrl
  updatedProvider.completionsUrl = parsedEndpoint.completionsUrl
  return updatedProvider
}
