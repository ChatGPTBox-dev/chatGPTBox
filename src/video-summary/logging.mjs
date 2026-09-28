import { sanitizeMediaUrl } from '../services/apis/volcengine-mediakit.mjs'

function getLoggerMethod(logger, level) {
  return typeof logger?.[level] === 'function' ? logger[level].bind(logger) : () => {}
}

function toSafeCode(value) {
  if (typeof value !== 'string') return null
  return /^[A-Z0-9_:-]+$/.test(value) ? value : null
}

export function serializePipelineError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: toSafeCode(error?.message),
    operation: typeof error?.operation === 'string' ? error.operation : null,
    httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
    providerCode: typeof error?.providerCode === 'string' ? error.providerCode : null,
    requestId: typeof error?.requestId === 'string' ? error.requestId : null,
    availableBytes: Number.isFinite(error?.availableBytes) ? error.availableBytes : null,
    requiredBytes: Number.isFinite(error?.requiredBytes) ? error.requiredBytes : null,
  }
}

export function sanitizePipelineCandidate(candidate) {
  return {
    id: typeof candidate?.id === 'string' ? candidate.id : null,
    mediaMetadata: candidate?.mediaMetadata
      ? {
          kind: candidate.mediaMetadata.kind ?? null,
          container: candidate.mediaMetadata.container ?? null,
          codec: candidate.mediaMetadata.codec ?? null,
          contentLength: Number.isFinite(candidate.mediaMetadata.contentLength)
            ? candidate.mediaMetadata.contentLength
            : null,
          durationMs: Number.isFinite(candidate.mediaMetadata.durationMs)
            ? candidate.mediaMetadata.durationMs
            : null,
        }
      : null,
    remoteReference:
      typeof candidate?.remoteCandidate?.url === 'string'
        ? sanitizeMediaUrl(candidate.remoteCandidate.url)
        : null,
    localReference:
      typeof candidate?.localFetchRecipe?.primaryUrl === 'string'
        ? sanitizeMediaUrl(candidate.localFetchRecipe.primaryUrl)
        : null,
  }
}

export function logPipelineEvent(logger, level, entry) {
  getLoggerMethod(logger, level)(entry)
}
