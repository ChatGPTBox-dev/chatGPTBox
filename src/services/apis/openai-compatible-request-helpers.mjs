const OPENROUTER_API_ORIGIN = 'https://openrouter.ai'
const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://github.com/ChatGPTBox-dev/chatGPTBox',
  'X-OpenRouter-Title': 'ChatGPTBox',
  'X-OpenRouter-Categories': 'general-chat,writing-assistant',
}

function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
}

function hasNativeOpenAIRequestUrl(requestUrl) {
  const normalizedRequestUrl = normalizeUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const pathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return (
      parsedRequestUrl.hostname.toLowerCase() === 'api.openai.com' &&
      (pathname === '/v1/chat/completions' || pathname === '/v1/completions')
    )
  } catch {
    return false
  }
}

function shouldUseOpenAIRequestShaping(request) {
  if (request?.providerId === 'openai') return true

  const hasOpenAILineage =
    request?.provider?.sourceProviderId === 'openai' || request?.secretProviderId === 'openai'
  return hasOpenAILineage && hasNativeOpenAIRequestUrl(request?.requestUrl)
}

export function resolveProviderRequestShapingId(request) {
  if (shouldUseOpenAIRequestShaping(request)) return 'openai'
  return request?.providerId
}

export function isNativeOllamaChatRequestUrl(requestUrl) {
  const normalizedRequestUrl = normalizeUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const pathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return /(^|\/)api\/chat$/i.test(pathname)
  } catch {
    return false
  }
}

export function getOpenRouterAttributionHeaders(requestUrl) {
  try {
    if (new URL(requestUrl).origin !== OPENROUTER_API_ORIGIN) return {}
  } catch {
    return {}
  }
  return OPENROUTER_ATTRIBUTION_HEADERS
}
