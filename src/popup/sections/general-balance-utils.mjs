export function formatFiniteBalance(value) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null
  }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return null
  }

  return numericValue.toFixed(2)
}

export function normalizeBillingApiBaseUrl(apiUrl) {
  const normalizedUrl = String(apiUrl || '').trim()
  return normalizedUrl.replace(/\/v1\/?$/i, '')
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')

  return `${year}-${month}-${day}`
}

function parseFiniteBillingNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === 'string') {
    if (value.trim() === '') {
      return null
    }

    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : null
  }

  return null
}

export async function checkBilling(apiKey, apiUrl, fetchImpl = globalThis.fetch) {
  const now = new Date()
  let startDate = new Date(now - 90 * 24 * 60 * 60 * 1000)
  const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const subDate = new Date(now)
  subDate.setDate(1)

  const urlSubscription = `${apiUrl}/v1/dashboard/billing/subscription`
  let urlUsage = `${apiUrl}/v1/dashboard/billing/usage?start_date=${formatDate(
    startDate,
  )}&end_date=${formatDate(endDate)}`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  try {
    let response = await fetchImpl(urlSubscription, { headers })
    if (!response.ok) {
      console.log('Your account has been suspended. Please log in to OpenAI to check.')
      return [null, null, null]
    }
    const subscriptionData = await response.json()
    const totalAmount = parseFiniteBillingNumber(subscriptionData?.hard_limit_usd)
    if (totalAmount === null) {
      return [null, null, null]
    }

    if (totalAmount > 20) {
      startDate = subDate
    }

    urlUsage = `${apiUrl}/v1/dashboard/billing/usage?start_date=${formatDate(
      startDate,
    )}&end_date=${formatDate(endDate)}`

    response = await fetchImpl(urlUsage, { headers })
    if (!response.ok) {
      return [null, null, null]
    }
    const usageData = await response.json()
    const totalUsageValue = parseFiniteBillingNumber(usageData?.total_usage)
    if (totalUsageValue === null) {
      return [null, null, null]
    }
    const totalUsage = totalUsageValue / 100
    const remaining = totalAmount - totalUsage

    return [totalAmount, totalUsage, remaining]
  } catch (error) {
    console.error(error)
    return [null, null, null]
  }
}

function normalizeText(value) {
  return String(value || '').trim()
}

function resolveStandardOpenAICompatibleBillingBaseUrl(endpointUrl, endpointType = 'chat') {
  const normalizedEndpointUrl = normalizeText(endpointUrl)
  if (!normalizedEndpointUrl) return ''

  try {
    const parsedEndpointUrl = new URL(normalizedEndpointUrl)
    parsedEndpointUrl.search = ''
    parsedEndpointUrl.hash = ''
    const normalizedPathname = parsedEndpointUrl.pathname.replace(/\/+$/, '') || '/'
    const expectedPathname =
      endpointType === 'completion' ? '/v1/completions' : '/v1/chat/completions'
    if (normalizedPathname !== expectedPathname) return ''

    parsedEndpointUrl.pathname =
      endpointType === 'completion'
        ? normalizedPathname.replace(/\/completions$/i, '')
        : normalizedPathname.replace(/\/chat\/completions$/i, '')
    return normalizeBillingApiBaseUrl(parsedEndpointUrl.toString())
  } catch {
    return ''
  }
}

export function resolveOpenAIBalanceContext(
  providerRequest,
  secretTargetId = '',
  fallbackApiUrl = '',
  selectedModeSourceProviderId = '',
) {
  const provider =
    providerRequest?.provider && typeof providerRequest.provider === 'object'
      ? providerRequest.provider
      : null
  const requestProviderId = normalizeText(providerRequest?.providerId)
  const normalizedSecretTargetId = normalizeText(secretTargetId)
  const normalizedSelectedModeSourceProviderId = normalizeText(selectedModeSourceProviderId)
  const resolvedProviderId = normalizeText(provider?.id)
  const resolvedSourceProviderId = normalizeText(provider?.sourceProviderId)
  const sourceProviderId =
    resolvedSourceProviderId ||
    (requestProviderId === 'legacy-custom-default' ? normalizedSelectedModeSourceProviderId : '')
  const providerId =
    requestProviderId === 'legacy-custom-default' &&
    normalizedSecretTargetId &&
    normalizedSecretTargetId !== requestProviderId
      ? normalizedSecretTargetId
      : requestProviderId === 'legacy-custom-default' &&
        sourceProviderId &&
        sourceProviderId !== requestProviderId
      ? sourceProviderId
      : resolvedProviderId || requestProviderId
  const endpointType = providerRequest?.endpointType === 'completion' ? 'completion' : 'chat'
  const explicitEndpointUrl =
    endpointType === 'completion'
      ? normalizeText(provider?.completionsUrl)
      : normalizeText(provider?.chatCompletionsUrl)
  const apiBaseUrl =
    resolveStandardOpenAICompatibleBillingBaseUrl(providerRequest?.requestUrl, endpointType) ||
    resolveStandardOpenAICompatibleBillingBaseUrl(explicitEndpointUrl, endpointType) ||
    normalizeBillingApiBaseUrl(normalizeText(provider?.baseUrl)) ||
    normalizeBillingApiBaseUrl(fallbackApiUrl) ||
    'https://api.openai.com'

  return {
    providerId,
    sourceProviderId,
    apiBaseUrl,
  }
}

export function getBalanceCacheKey(providerId, apiKey, baseUrl) {
  return JSON.stringify([
    String(providerId || '').trim(),
    String(apiKey || '').trim(),
    String(baseUrl || '')
      .trim()
      .replace(/\/+$/, ''),
  ])
}

export function shouldOpenOpenAIUsagePage(providerId, sourceProviderId = '') {
  return providerId === 'openai' || sourceProviderId === 'openai'
}

export function isOpenAIHostedBillingBaseUrl(billingApiBaseUrl) {
  const normalizedUrl = String(billingApiBaseUrl || '').trim()
  if (!normalizedUrl) return false

  try {
    const hostname = new URL(normalizedUrl).hostname
    return hostname === 'openai.com' || hostname.endsWith('.openai.com')
  } catch {
    return false
  }
}

export function shouldOpenOpenAIUsageFallbackPage(
  providerId,
  sourceProviderId = '',
  billingApiBaseUrl = '',
  isModeOverride = false,
) {
  const normalizedProviderId = normalizeText(providerId)
  const normalizedSourceProviderId = normalizeText(sourceProviderId)

  if (normalizedProviderId === 'openai') {
    return true
  }

  if (normalizedSourceProviderId !== 'openai') {
    return false
  }

  if (isModeOverride) {
    return true
  }

  return isOpenAIHostedBillingBaseUrl(billingApiBaseUrl)
}
