import { normalizeMediaKitTranscription } from '../services/apis/volcengine-mediakit.mjs'
import { logPipelineEvent, sanitizePipelineCandidate, serializePipelineError } from './logging.mjs'

const DIRECT_REFRESH_REASON = 'DIRECT_DOWNLOAD_FAILED'
const EXPIRY_REFRESH_REASON = 'SIGNED_URL_EXPIRED'

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
  if (!candidate) throw new Error('BILIBILI_MEDIA_CANDIDATE_NOT_FOUND')
  return candidate
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
    expectedVideoId: owner?.videoId ?? sourceSnapshot?.videoId ?? null,
    reason,
  })

  if (owner?.videoId && refreshedSnapshot?.videoId && refreshedSnapshot.videoId !== owner.videoId) {
    throw new Error('BILIBILI_VIDEO_IDENTITY_CHANGED')
  }

  requireCandidate(refreshedSnapshot)
  return refreshedSnapshot
}

async function settleTranscription({ mediaKitGateway, submission, signal, onEvent }) {
  if (hasUsableSegments(submission)) return normalizeMediaKitTranscription(submission)

  if (!submission?.taskId) {
    throw new Error('MEDIAKIT_TASK_QUERY_UNAVAILABLE')
  }
  if (typeof mediaKitGateway?.queryTask !== 'function') {
    throw new Error('MEDIAKIT_TASK_QUERY_UNAVAILABLE')
  }

  emitEvent(onEvent, { stage: 'transcribing' })
  let completed = false

  while (!completed) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')

    const result = await mediaKitGateway.queryTask({ taskId: submission.taskId, signal })
    if (result?.status === 'failed') {
      const error = new Error(result?.error?.message || 'MEDIAKIT_TASK_FAILED')
      error.providerCode = result?.error?.code || null
      throw error
    }
    if (result?.status === 'completed') {
      completed = true
      return normalizeMediaKitTranscription(result?.result ?? result)
    }
    if (hasUsableSegments(result) || result?.result) {
      completed = true
      return normalizeMediaKitTranscription(result?.result ?? result)
    }

    await Promise.resolve()
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
  opfsStoreFactory,
  logger,
  taskId,
  owner,
  candidate,
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
      candidate,
      signal,
      onProgress(progress) {
        emitEvent(onEvent, { stage: 'downloading', ...progress })
      },
    })

    const target = await mediaKitGateway.requestUploadTarget()
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

    return settleTranscription({ mediaKitGateway, submission, signal, onEvent })
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

export function createMediaPipeline({ mediaKitGateway, opfsStoreFactory, logger, clock }) {
  return {
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
        return settleTranscription({ mediaKitGateway, submission, signal, onEvent })
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
              mediaKitGateway,
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
              opfsStoreFactory,
              logger,
              taskId,
              owner,
              candidate: currentCandidate,
              settingsSnapshot,
              signal,
              onEvent,
            })
          }
        }

        if (!isFallbackEligible(error)) throw error
        return runLocalUploadFallback({
          mediaKitGateway,
          opfsStoreFactory,
          logger,
          taskId,
          owner,
          candidate: currentCandidate,
          settingsSnapshot,
          signal,
          onEvent,
        })
      }
    },
  }
}
