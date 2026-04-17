const SENSITIVE_KEYWORDS = [
  'apikey', // Covers apiKey, customApiKey, claudeApiKey, etc.
  'token', // Covers accessToken, refreshToken, etc.
  'secret',
  'password',
  'kimimoonshotrefreshtoken',
  'credential',
  'jwt',
  'session',
]

export function isPromptOrSelectionLikeKey(lowerKey) {
  lowerKey = lowerKey.toLowerCase()
  const normalizedKey = lowerKey.replace(/[^a-z0-9]/g, '')
  return (
    normalizedKey.endsWith('question') ||
    normalizedKey.endsWith('prompt') ||
    normalizedKey.endsWith('query') ||
    normalizedKey === 'selection' ||
    normalizedKey === 'selectiontext'
  )
}

export function redactSensitiveFields(obj, recursionDepth = 0, maxDepth = 5, seen = new WeakSet()) {
  if (recursionDepth > maxDepth) {
    // Prevent infinite recursion on circular objects or excessively deep structures
    return 'REDACTED_TOO_DEEP'
  }
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  if (seen.has(obj)) {
    return 'REDACTED_CIRCULAR_REFERENCE'
  }
  seen.add(obj)

  if (Array.isArray(obj)) {
    const redactedArray = []
    for (let i = 0; i < obj.length; i++) {
      const item = obj[i]
      if (item !== null && typeof item === 'object') {
        redactedArray[i] = redactSensitiveFields(item, recursionDepth + 1, maxDepth, seen)
      } else {
        redactedArray[i] = item
      }
    }
    return redactedArray
  }

  const redactedObj = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const lowerKey = key.toLowerCase()
      let isKeySensitive = isPromptOrSelectionLikeKey(lowerKey)
      if (!isKeySensitive) {
        for (const keyword of SENSITIVE_KEYWORDS) {
          if (lowerKey.includes(keyword)) {
            isKeySensitive = true
            break
          }
        }
      }
      if (isKeySensitive) {
        redactedObj[key] = 'REDACTED'
      } else if (obj[key] !== null && typeof obj[key] === 'object') {
        redactedObj[key] = redactSensitiveFields(obj[key], recursionDepth + 1, maxDepth, seen)
      } else {
        redactedObj[key] = obj[key]
      }
    }
  }
  return redactedObj
}
