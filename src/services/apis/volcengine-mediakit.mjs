const BASE_URL = 'https://mediakit.cn-beijing.volces.com'
const UPLOAD_TARGET_PATH = '/api/v1/tools-sync/request-media-upload-url'
const ASR_PATH = '/api/v1/tools/asr-subtitles'
const TASK_PATH_PREFIX = '/api/v1/tasks/'

export class MediaKitError extends Error {
  constructor(message, details = {}) {
    super(message)
    // Preserve the historical error name for existing probe callers and tests.
    this.name = 'MediaKitProbeError'
    Object.assign(this, details)
  }
}

function authorization(apiKey) {
  if (!apiKey) throw new MediaKitError('MEDIAKIT_API_KEY_REQUIRED')
  return { Authorization: `Bearer ${apiKey}` }
}

async function readJson(response) {
  return response.json().catch(() => ({}))
}

function requestIdOf(response, data) {
  return data?.request_id || response.headers.get('x-request-id') || null
}

function assertSuccess(operation, response, data) {
  if (response.ok && data?.success !== false) return
  const providerError = data?.error || data
  throw new MediaKitError(providerError?.message || `${response.status} ${response.statusText}`, {
    operation,
    httpStatus: response.status,
    providerCode: providerError?.code || null,
    requestId: requestIdOf(response, data),
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  })
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function secondsToMs(value) {
  const seconds = toFiniteNumber(value)
  return seconds === null ? null : Math.round(seconds * 1000)
}

function normalizeSegmentId(input, index) {
  const rawId =
    input?.id ?? input?.segment_id ?? input?.segmentId ?? input?.utterance_id ?? input?.utteranceId
  const normalized = toOptionalString(rawId)
  return normalized || `segment-${index + 1}`
}

function normalizeSegment(input, index) {
  const explicitStartMs = toFiniteNumber(input?.startMs ?? input?.begin_time)
  const explicitEndMs = toFiniteNumber(input?.endMs ?? input?.stop_time)
  return {
    id: normalizeSegmentId(input, index),
    startMs: explicitStartMs ?? secondsToMs(input?.start_time ?? input?.start),
    endMs: explicitEndMs ?? secondsToMs(input?.end_time ?? input?.end),
    text: String(
      input?.text ?? input?.subtitle_text ?? input?.utterance ?? input?.transcript ?? '',
    ).trim(),
    speaker: toOptionalString(input?.speaker ?? input?.speaker_id ?? input?.speakerId),
    confidence: toFiniteNumber(input?.confidence),
  }
}

function detectSegmentList(result) {
  if (Array.isArray(result?.utterances)) return result.utterances
  if (Array.isArray(result?.segments)) return result.segments
  if (Array.isArray(result?.subtitles)) return result.subtitles
  return []
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(60000, Math.max(0, seconds * 1000))
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.min(60000, Math.max(0, dateMs - now)) : null
}

export function sanitizeMediaUrl(input) {
  const url = new URL(input)
  return {
    origin: url.origin,
    pathname: url.pathname,
    queryKeys: [...new Set(url.searchParams.keys())].sort(),
  }
}

export async function requestMediaUploadTarget({ apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE_URL}${UPLOAD_TARGET_PATH}`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await readJson(response)
  assertSuccess('request-upload-target', response, data)
  const result = data.result || {}
  const rawFileId = String(result.file_id || '')
  if (!rawFileId || !result.upload_url || result.method !== 'PUT') {
    throw new MediaKitError('INVALID_UPLOAD_TARGET_RESPONSE', {
      operation: 'request-upload-target',
      requestId: requestIdOf(response, data),
    })
  }
  return {
    fileReference: rawFileId.startsWith('mediakit://') ? rawFileId : `mediakit://${rawFileId}`,
    method: result.method,
    uploadUrl: result.upload_url,
    headers: Object.fromEntries(
      (result.upload_headers || []).map(({ key, value }) => [key, value]),
    ),
  }
}

export async function uploadMediaBlob({ target, blob, fetchImpl = fetch }) {
  const response = await fetchImpl(target.uploadUrl, {
    method: target.method,
    headers: target.headers,
    body: blob,
  })
  if (!response.ok) {
    throw new MediaKitError(`${response.status} ${response.statusText}`, {
      operation: 'upload-media',
      httpStatus: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    })
  }
}

export async function submitMediaKitAsr({
  apiKey,
  audioUrl,
  clientToken,
  speakerIdentification = true,
  confirmed,
  fetchImpl = fetch,
}) {
  if (confirmed !== true) throw new MediaKitError('PAID_REQUEST_NOT_CONFIRMED')
  if (!clientToken) throw new MediaKitError('CLIENT_TOKEN_REQUIRED')
  const response = await fetchImpl(`${BASE_URL}${ASR_PATH}`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      content_type: 'speech',
      enable_speaker_info: speakerIdentification === true,
      enable_confidence: true,
      client_token: clientToken,
    }),
  })
  const data = await readJson(response)
  assertSuccess('submit-asr', response, data)
  if (!data.task_id) {
    throw new MediaKitError('MISSING_MEDIAKIT_TASK_ID', {
      operation: 'submit-asr',
      requestId: requestIdOf(response, data),
    })
  }
  return { taskId: data.task_id, requestId: requestIdOf(response, data) }
}

export async function queryMediaKitTask({ apiKey, taskId, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE_URL}${TASK_PATH_PREFIX}${encodeURIComponent(taskId)}`, {
    headers: authorization(apiKey),
  })
  const data = await readJson(response)
  assertSuccess('query-asr', response, data)
  return data
}

export function normalizeMediaKitTranscription(result) {
  const rawResult =
    result?.result && typeof result.result === 'object' && !Array.isArray(result.result)
      ? result.result
      : result
  const segments = detectSegmentList(rawResult)
    .map((segment, index) => normalizeSegment(segment, index))
    .filter((segment) => segment.text || segment.startMs !== null || segment.endMs !== null)
  const detectedLanguage =
    toOptionalString(rawResult?.detectedLanguage) ||
    toOptionalString(rawResult?.language) ||
    toOptionalString(rawResult?.lang)
  const durationMs =
    toFiniteNumber(rawResult?.durationMs) ??
    secondsToMs(rawResult?.duration) ??
    segments.reduce((maxDuration, segment) => Math.max(maxDuration, segment.endMs ?? 0), 0)

  return {
    durationMs: durationMs ?? 0,
    detectedLanguage,
    segments,
  }
}
