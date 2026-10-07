const OPERATIONS = new Set([
  'refreshSource',
  'submitDirectAsr',
  'requestUploadTarget',
  'uploadMedia',
  'submitUploadedAsr',
  'queryAsr',
  'generateText',
  'cleanup',
])
const CODE = /^[A-Z][A-Z0-9_:-]{0,95}$/
const EVENT = /^video-summary(?:\.[a-z0-9-]+){1,7}$/
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const LEVELS = new Set(['info', 'warn', 'error'])

export function sanitizeVideoSummaryLogEntry(entry = {}) {
  const result = {}
  if (typeof entry?.event === 'string' && entry.event.length <= 128 && EVENT.test(entry.event)) {
    result.event = entry.event
  }
  if (OPERATIONS.has(entry?.operation)) result.operation = entry.operation
  if (typeof entry?.code === 'string' && CODE.test(entry.code)) result.code = entry.code
  if (typeof entry?.providerCode === 'string' && CODE.test(entry.providerCode)) {
    result.providerCode = entry.providerCode
  }
  if (Number.isInteger(entry?.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) {
    result.httpStatus = entry.httpStatus
  }
  if (typeof entry?.requestId === 'string' && REQUEST_ID.test(entry.requestId)) {
    result.requestId = entry.requestId
  }
  for (const key of ['retryable', 'refreshed', 'uploaded']) {
    if (typeof entry?.[key] === 'boolean') result[key] = entry[key]
  }
  return result
}

export function serializePipelineError(error) {
  return sanitizeVideoSummaryLogEntry({
    operation: error?.operation,
    code: error?.code || error?.message,
    providerCode: error?.providerCode,
    httpStatus: error?.httpStatus,
    requestId: error?.requestId,
    retryable: error?.retryable,
    refreshed: error?.refreshed,
    uploaded: error?.uploaded,
  })
}

export function logPipelineEvent(logger, level, entry) {
  if (!LEVELS.has(level) || typeof logger?.[level] !== 'function') return
  logger[level](sanitizeVideoSummaryLogEntry(entry))
}
