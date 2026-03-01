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

export function parseChatCompletionsEndpointUrl(value) {
  const normalizedUrl = normalizeProviderEndpointUrl(value)
  if (!normalizedUrl) return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }

  let parsedUrl
  try {
    parsedUrl = new URL(normalizedUrl)
  } catch {
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
