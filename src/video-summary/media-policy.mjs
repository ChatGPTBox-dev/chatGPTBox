const MAX_DURATION_MS = 10_800_000
const MIN_DURATION_TOLERANCE_MS = 2000
const MAX_REDIRECTS = 5
const UPLOAD_HOST = 'tob-upload-y.volcvod.com'
const PLATFORM_HOST_SUFFIXES = {
  bilibili: ['bilivideo.com'],
  youtube: ['googlevideo.com'],
}
const LOCAL_FETCH_RECIPE_KEYS = new Set([
  'primaryUrl',
  'backupUrls',
  'credentialMode',
  'requiredRequestOrigin',
])

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function isExactHostOrSubdomain(hostname, suffix) {
  const normalized = hostname.toLowerCase()
  return normalized === suffix || normalized.endsWith(`.${suffix}`)
}

function parseUrl(value, code) {
  try {
    return new URL(value)
  } catch {
    fail(code)
  }
}

function requireSafeHttpsUrl(value, allowedSuffixes) {
  const parsed = parseUrl(value, 'VIDEO_MEDIA_URL_REJECTED')
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    fail('VIDEO_MEDIA_URL_REJECTED')
  }
  if (!allowedSuffixes.some((suffix) => isExactHostOrSubdomain(parsed.hostname, suffix))) {
    fail('VIDEO_MEDIA_HOST_REJECTED')
  }
  return parsed.href
}

function platformSuffixes(platform) {
  const suffixes = PLATFORM_HOST_SUFFIXES[platform]
  if (!suffixes) fail('VIDEO_MEDIA_PLATFORM_REJECTED')
  return suffixes
}

export function validateCanonicalDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    fail('VIDEO_MEDIA_DURATION_REJECTED')
  }
  return durationMs
}

export function validateCandidateDuration(canonicalDurationMs, candidateDurationMs) {
  const canonical = validateCanonicalDuration(canonicalDurationMs)
  if (
    !Number.isFinite(candidateDurationMs) ||
    candidateDurationMs <= 0 ||
    candidateDurationMs > MAX_DURATION_MS
  ) {
    fail('VIDEO_MEDIA_DURATION_REJECTED')
  }
  const tolerance = Math.max(MIN_DURATION_TOLERANCE_MS, canonical * 0.01)
  if (Math.abs(candidateDurationMs - canonical) > tolerance) {
    fail('VIDEO_MEDIA_DURATION_MISMATCH')
  }
  return candidateDurationMs
}

export function validateInitialMediaUrl({ platform, url }) {
  return requireSafeHttpsUrl(url, platformSuffixes(platform))
}

export function localFetchRequiresUnsupportedHeaders(recipe) {
  return Boolean(recipe && Object.prototype.hasOwnProperty.call(recipe, 'headers'))
}

export function validateLocalFetchRecipe({ platform, recipe }) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    fail('VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED')
  }
  if (localFetchRequiresUnsupportedHeaders(recipe)) {
    fail('VIDEO_MEDIA_LOCAL_HEADERS_UNSUPPORTED')
  }
  if (Object.keys(recipe).some((key) => !LOCAL_FETCH_RECIPE_KEYS.has(key))) {
    fail('VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED')
  }
  if (!['omit', 'include', 'same-origin'].includes(recipe.credentialMode)) {
    fail('VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED')
  }
  if (
    recipe.requiredRequestOrigin !== undefined &&
    typeof recipe.requiredRequestOrigin !== 'string'
  ) {
    fail('VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED')
  }
  if (!Array.isArray(recipe.backupUrls)) fail('VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED')

  return {
    primaryUrl: validateInitialMediaUrl({ platform, url: recipe.primaryUrl }),
    backupUrls: recipe.backupUrls.map((url) => validateInitialMediaUrl({ platform, url })),
    credentialMode: recipe.credentialMode,
    ...(recipe.requiredRequestOrigin === undefined
      ? {}
      : { requiredRequestOrigin: recipe.requiredRequestOrigin }),
  }
}

export function validateRedirectLocation({ platform, currentUrl, location }) {
  if (typeof location !== 'string' || !location) fail('VIDEO_MEDIA_REDIRECT_REJECTED')
  let resolved
  try {
    resolved = new URL(location, currentUrl).href
  } catch {
    fail('VIDEO_MEDIA_REDIRECT_REJECTED')
  }
  return validateInitialMediaUrl({ platform, url: resolved })
}

export function validateUploadTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    fail('VIDEO_MEDIA_UPLOAD_TARGET_REJECTED')
  }
  const parsed = parseUrl(target.url, 'VIDEO_MEDIA_UPLOAD_URL_REJECTED')
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    fail('VIDEO_MEDIA_UPLOAD_URL_REJECTED')
  }
  if (parsed.hostname.toLowerCase() !== UPLOAD_HOST) {
    fail('VIDEO_MEDIA_UPLOAD_HOST_REJECTED')
  }
  if (!/^\/tos-vod-cn-v-[^/]+\/mediakit\/upload\/local\/[^/]+$/.test(parsed.pathname)) {
    fail('VIDEO_MEDIA_UPLOAD_PATH_REJECTED')
  }
  if (target.method !== 'PUT') fail('VIDEO_MEDIA_UPLOAD_METHOD_REJECTED')
  if (
    !target.headers ||
    typeof target.headers !== 'object' ||
    Array.isArray(target.headers) ||
    Object.keys(target.headers).length !== 0
  ) {
    fail('VIDEO_MEDIA_UPLOAD_HEADERS_REJECTED')
  }
  if (target.credentials !== 'omit') fail('VIDEO_MEDIA_UPLOAD_CREDENTIALS_REJECTED')
  if (target.redirect !== 'error') fail('VIDEO_MEDIA_UPLOAD_REDIRECT_REJECTED')
  if (typeof target.fileReference !== 'string' || !target.fileReference.startsWith('mediakit://')) {
    fail('VIDEO_MEDIA_UPLOAD_REFERENCE_REJECTED')
  }
  return {
    url: parsed.href,
    fileReference: target.fileReference,
    method: 'PUT',
    headers: {},
    credentials: 'omit',
    redirect: 'error',
  }
}

export const VIDEO_MEDIA_MAX_REDIRECTS = MAX_REDIRECTS
