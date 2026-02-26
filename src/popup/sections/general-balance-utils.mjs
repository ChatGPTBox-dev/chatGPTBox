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

export function shouldOpenOpenAIUsagePage(providerId) {
  return providerId === 'openai'
}
