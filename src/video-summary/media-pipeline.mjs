import { normalizeMediaKitTranscription } from '../services/apis/volcengine-mediakit.mjs'
import { logPipelineEvent, sanitizePipelineCandidate, serializePipelineError } from './logging.mjs'
import {
  localFetchRequiresUnsupportedHeaders,
  validateCandidateDuration,
  validateCanonicalDuration,
  validateInitialMediaUrl,
  validateLocalFetchRecipe,
  validateUploadTarget,
} from './media-policy.mjs'

const DIRECT_REFRESH_REASON = 'DIRECT_DOWNLOAD_FAILED'
const EXPIRY_REFRESH_REASON = 'SIGNED_URL_EXPIRED'
const POLL_MIN_DELAY_MS = 2000
const POLL_MAX_DELAY_MS = 30000
const POLL_DEADLINE_MS = 2 * 60 * 60 * 1000
const POLL_MAX_CONSECUTIVE_TRANSIENT_FAILURES = 5

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
}

function createDefaultClock() {
  return {
    now: () => Date.now(),
    sleep(ms, { signal } = {}) {
      throwIfAborted(signal)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          reject(signal.reason || new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

function clampPollDelay(value) {
  return Math.min(POLL_MAX_DELAY_MS, Math.max(POLL_MIN_DELAY_MS, value))
}

function jitterPollDelay(value, random) {
  return clampPollDelay(Math.round(clampPollDelay(value) * (0.8 + random() * 0.4)))
}

function isTransientPollingFailure(error) {
  return (
    error?.transient === true ||
    error instanceof TypeError ||
    error?.httpStatus === 408 ||
    error?.httpStatus === 429 ||
    error?.httpStatus >= 500
  )
}

function createPollDeadlineError() {
  const error = new Error('MEDIAKIT_POLL_DEADLINE_EXCEEDED')
  error.code = 'MEDIAKIT_POLL_DEADLINE_EXCEEDED'
  return error
}

function emitEvent(onEvent, event) {
  if (typeof onEvent === 'function') onEvent(structuredClone(event))
}

function isAmbiguousSubmissionFailure(error) {
  return error instanceof TypeError
}

function toSubmissionUnknownError(error) {
  const wrapped = new Error('VIDEO_SUMMARY_SUBMISSION_UNKNOWN')
  wrapped.code = 'VIDEO_SUMMARY_SUBMISSION_UNKNOWN'
  wrapped.stage = 'submission-unknown'
  wrapped.cause = error
  return wrapped
}

function hasUsableSegments(value) {
  return Array.isArray(value?.segments)
}

function requireCandidate(sourceSnapshot) {
  const candidate = sourceSnapshot?.mediaCandidates?.[0]
  if (!candidate) throw new Error('VIDEO_MEDIA_CANDIDATE_NOT_FOUND')
  return candidate
}

function validateSourceMedia({ sourceSnapshot, owner }) {
  const candidates = sourceSnapshot?.mediaCandidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('VIDEO_MEDIA_CANDIDATE_NOT_FOUND')
  }
  const canonicalDurationMs = validateCanonicalDuration(sourceSnapshot?.durationMs)
  const platform =
    sourceSnapshot?.pageIdentity?.platform ?? sourceSnapshot?.platform ?? owner?.platform
  for (const candidate of candidates) {
    validateCandidateDuration(canonicalDurationMs, candidate?.mediaMetadata?.durationMs)
    validateInitialMediaUrl({ platform, url: candidate?.remoteCandidate?.url })
    if (localFetchRequiresUnsupportedHeaders(candidate?.localFetchRecipe)) {
      throw new Error('VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED')
    }
    validateLocalFetchRecipe({ platform, recipe: candidate?.localFetchRecipe })
  }
  return platform
}

function isSignedCandidateExpired(candidate, nowMs) {
  return (
    Number.isFinite(candidate?.remoteCandidate?.expiresAt) &&
    candidate.remoteCandidate.expiresAt <= nowMs
  )
}

function isDocumentedDirectDownloadFailure(error) {
  return (
    error?.message === 'MEDIAKIT_DIRECT_DOWNLOAD_FAILED' ||
    error?.providerCode === 'URL_DOWNLOAD_FAILED' ||
    error?.providerCode === 'AUDIO_URL_DOWNLOAD_FAILED'
  )
}

function isFallbackEligible(error) {
  return isDocumentedDirectDownloadFailure(error)
}

async function requestRefreshedSnapshot({
  owner,
  sourceSnapshot,
  taskId,
  requestSourceRefresh,
  reason,
}) {
  const refreshedSnapshot = await requestSourceRefresh({
    owner,
    taskId,
    expectedPlatform: owner?.platform ?? sourceSnapshot?.platform ?? null,
    expectedVideoId: owner?.videoId ?? sourceSnapshot?.videoId ?? null,
    reason,
  })

  const expectedPlatform = owner?.platform ?? sourceSnapshot?.platform ?? null
  const expectedVideoId = owner?.videoId ?? sourceSnapshot?.videoId ?? null
  if (
    (expectedPlatform && refreshedSnapshot?.platform !== expectedPlatform) ||
    (expectedVideoId && refreshedSnapshot?.videoId !== expectedVideoId)
  ) {
    throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
  }

  requireCandidate(refreshedSnapshot)
  return refreshedSnapshot
}

async function settleTranscription({ pollMediaKitTask, submission, signal, onEvent }) {
  if (hasUsableSegments(submission)) return normalizeMediaKitTranscription(submission)

  if (!submission?.taskId) {
    throw new Error('MEDIAKIT_TASK_QUERY_UNAVAILABLE')
  }

  emitEvent(onEvent, { stage: 'transcribing' })
  const result = await pollMediaKitTask({ taskId: submission.taskId, signal, onEvent })
  return normalizeMediaKitTranscription(result?.result ?? result)
}

function createPollMediaKitTask({ mediaKitGateway, clock, random }) {
  return async function pollMediaKitTask({ taskId, signal }) {
    if (typeof mediaKitGateway?.queryTask !== 'function') {
      throw new Error('MEDIAKIT_TASK_QUERY_UNAVAILABLE')
    }

    const deadline = clock.now() + POLL_DEADLINE_MS
    let baseDelayMs = POLL_MIN_DELAY_MS
    let consecutiveTransientFailures = 0

    for (;;) {
      throwIfAborted(signal)
      const remainingMs = deadline - clock.now()
      if (remainingMs <= 0) throw createPollDeadlineError()

      const delayMs = Math.min(jitterPollDelay(baseDelayMs, random), remainingMs)
      await clock.sleep(delayMs, { signal })
      throwIfAborted(signal)
      if (clock.now() >= deadline) throw createPollDeadlineError()

      try {
        const result = await mediaKitGateway.queryTask({ taskId, signal })
        consecutiveTransientFailures = 0

        if (result?.status === 'failed') {
          const error = new Error(result?.error?.message || 'MEDIAKIT_TASK_FAILED')
          error.providerCode = result?.error?.code || null
          throw error
        }
        if (result?.status === 'completed' || hasUsableSegments(result) || result?.result) {
          return result
        }

        baseDelayMs = Number.isFinite(result?.retryAfterMs)
          ? clampPollDelay(result.retryAfterMs)
          : Math.min(baseDelayMs * 2, POLL_MAX_DELAY_MS)
      } catch (error) {
        if (!isTransientPollingFailure(error)) throw error
        consecutiveTransientFailures += 1
        if (consecutiveTransientFailures >= POLL_MAX_CONSECUTIVE_TRANSIENT_FAILURES) throw error
        if (Number.isFinite(error?.retryAfterMs)) {
          baseDelayMs = clampPollDelay(error.retryAfterMs)
        }
      }
    }
  }
}

async function submitDirect({
  mediaKitGateway,
  candidate,
  taskId,
  settingsSnapshot,
  signal,
  onEvent,
  logger,
}) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
  emitEvent(onEvent, { stage: 'submitting-url' })

  logPipelineEvent(logger, 'info', {
    event: 'video-summary-media-pipeline.submit-direct',
    candidate: sanitizePipelineCandidate(candidate),
  })

  try {
    return await mediaKitGateway.submitDirectAsr({
      audioUrl: candidate.remoteCandidate.url,
      clientToken: taskId,
      speakerIdentification: settingsSnapshot?.speakerIdentification === true,
      confirmed: true,
      signal,
    })
  } catch (error) {
    if (isAmbiguousSubmissionFailure(error)) throw toSubmissionUnknownError(error)
    throw error
  }
}

async function runLocalUploadFallback({
  mediaKitGateway,
  pollMediaKitTask,
  opfsStoreFactory,
  logger,
  taskId,
  owner,
  candidate,
  platform,
  settingsSnapshot,
  signal,
  onEvent,
}) {
  const opfsStore = opfsStoreFactory({ taskId, owner })

  try {
    await opfsStore.ensureQuota({
      requiredBytes: candidate?.mediaMetadata?.contentLength ?? null,
      candidate,
    })

    const download = await opfsStore.downloadCandidate({
      platform,
      candidate,
      signal,
      onProgress(progress) {
        emitEvent(onEvent, { stage: 'downloading', ...progress })
      },
    })

    const target = validateUploadTarget(await mediaKitGateway.requestUploadTarget())
    await opfsStore.uploadBlob({
      target,
      blob: download.blob,
      signal,
      onProgress(progress) {
        emitEvent(onEvent, { stage: 'uploading', ...progress })
      },
    })

    emitEvent(onEvent, { stage: 'submitting-upload' })
    let submission
    try {
      submission = await mediaKitGateway.submitDirectAsr({
        audioUrl: target.fileReference,
        clientToken: taskId,
        speakerIdentification: settingsSnapshot?.speakerIdentification === true,
        confirmed: true,
        signal,
      })
    } catch (error) {
      if (isAmbiguousSubmissionFailure(error)) throw toSubmissionUnknownError(error)
      throw error
    }

    return settleTranscription({ pollMediaKitTask, submission, signal, onEvent })
  } finally {
    try {
      const cleanup = await opfsStore.cleanup()
      logPipelineEvent(logger, 'info', {
        event: 'video-summary-media-pipeline.cleanup',
        taskId,
        cleanup: {
          attempts: cleanup?.attempts ?? null,
          retrySucceeded: cleanup?.retrySucceeded ?? false,
          initialError: serializePipelineError(cleanup?.initialError),
        },
      })
    } catch (cleanupError) {
      logPipelineEvent(logger, 'warn', {
        event: 'video-summary-media-pipeline.cleanup-failed',
        taskId,
        error: serializePipelineError(cleanupError),
      })
    }
  }
}

export function createMediaPipeline({
  mediaKitGateway,
  opfsStoreFactory,
  logger,
  clock = createDefaultClock(),
  random = Math.random,
}) {
  const pollMediaKitTask = createPollMediaKitTask({ mediaKitGateway, clock, random })

  return {
    pollMediaKitTask,
    async transcribeFromSource({
      taskId,
      owner,
      sourceSnapshot,
      settingsSnapshot,
      requestSourceRefresh,
      signal,
      onEvent,
    }) {
      let currentSnapshot = sourceSnapshot
      let platform = validateSourceMedia({ sourceSnapshot: currentSnapshot, owner })
      let currentCandidate = requireCandidate(currentSnapshot)
      let refreshed = false

      if (isSignedCandidateExpired(currentCandidate, clock.now())) {
        currentSnapshot = await requestRefreshedSnapshot({
          owner,
          sourceSnapshot: currentSnapshot,
          taskId,
          requestSourceRefresh,
          reason: EXPIRY_REFRESH_REASON,
        })
        platform = validateSourceMedia({ sourceSnapshot: currentSnapshot, owner })
        currentCandidate = requireCandidate(currentSnapshot)
        refreshed = true
      }

      try {
        const submission = await submitDirect({
          mediaKitGateway,
          candidate: currentCandidate,
          taskId,
          settingsSnapshot,
          signal,
          onEvent,
          logger,
        })
        return settleTranscription({ pollMediaKitTask, submission, signal, onEvent })
      } catch (error) {
        logPipelineEvent(logger, 'warn', {
          event: 'video-summary-media-pipeline.direct-failed',
          taskId,
          candidate: sanitizePipelineCandidate(currentCandidate),
          error: serializePipelineError(error),
        })

        if (isDocumentedDirectDownloadFailure(error) && !refreshed) {
          currentSnapshot = await requestRefreshedSnapshot({
            owner,
            sourceSnapshot: currentSnapshot,
            taskId,
            requestSourceRefresh,
            reason: DIRECT_REFRESH_REASON,
          })
          currentCandidate = requireCandidate(currentSnapshot)
          refreshed = true

          try {
            const refreshedSubmission = await submitDirect({
              mediaKitGateway,
              candidate: currentCandidate,
              taskId,
              settingsSnapshot,
              signal,
              onEvent,
              logger,
            })
            return settleTranscription({
              pollMediaKitTask,
              submission: refreshedSubmission,
              signal,
              onEvent,
            })
          } catch (refreshedError) {
            logPipelineEvent(logger, 'warn', {
              event: 'video-summary-media-pipeline.direct-refreshed-failed',
              taskId,
              candidate: sanitizePipelineCandidate(currentCandidate),
              error: serializePipelineError(refreshedError),
            })

            if (!isFallbackEligible(refreshedError)) throw refreshedError
            return runLocalUploadFallback({
              mediaKitGateway,
              pollMediaKitTask,
              opfsStoreFactory,
              logger,
              taskId,
              owner,
              candidate: currentCandidate,
              platform,
              settingsSnapshot,
              signal,
              onEvent,
            })
          }
        }

        if (!isFallbackEligible(error)) throw error
        return runLocalUploadFallback({
          mediaKitGateway,
          pollMediaKitTask,
          opfsStoreFactory,
          logger,
          taskId,
          owner,
          candidate: currentCandidate,
          platform,
          settingsSnapshot,
          signal,
          onEvent,
        })
      }
    },
  }
}
