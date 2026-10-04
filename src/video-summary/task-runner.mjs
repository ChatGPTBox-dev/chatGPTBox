import { chunkTranscriptForSummary } from './summary-chunker.mjs'
import { buildStructuredSummaryResult } from './result-builder.mjs'
import {
  buildChunkSummaryMessages,
  buildFinalSummaryMessages,
  parseChunkSummaryMarkdown,
  parseFinalSummaryMarkdown,
} from './summary-markdown.mjs'
import { normalizeVideoSummaryMaxOutputTokens } from './settings.mjs'

const CHUNK_MAX_OUTPUT_TOKENS = 1200
const FINAL_MAX_OUTPUT_TOKENS = 4000

function emitEvent(emit, event) {
  if (typeof emit === 'function') emit(structuredClone(event))
}

function createAbortError() {
  return new DOMException('Aborted', 'AbortError')
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason || createAbortError()
}

function normalizeFailedRange(chunk, reason) {
  return {
    startSegmentId: chunk.primaryStartSegmentId,
    endSegmentId: chunk.primaryEndSegmentId,
    reason: typeof reason === 'string' && reason ? reason : 'SUMMARY_RANGE_FAILED',
  }
}

function clampOutputTokens(capabilities, requested) {
  const advertised = Number.isFinite(capabilities?.maxOutputTokens)
    ? capabilities.maxOutputTokens
    : requested
  return Math.max(1, Math.min(requested, advertised))
}

function resolveTaskMaxOutputTokens(command, capabilities, requested) {
  const hasTaskOutputTokenSetting = Object.prototype.hasOwnProperty.call(
    command?.settingsSnapshot || {},
    'summaryMaxOutputTokens',
  )
  const userLimit = hasTaskOutputTokenSetting
    ? normalizeVideoSummaryMaxOutputTokens(command.settingsSnapshot.summaryMaxOutputTokens)
    : requested
  const taskLimit = Math.max(1, Math.min(requested, userLimit))
  return clampOutputTokens(capabilities, taskLimit)
}

function createTranscriptOnlyResult(transcription, reason) {
  return {
    status: 'degraded',
    overview: '',
    keyPoints: [],
    keyMoments: [],
    chapters: [],
    transcriptSegments: Array.isArray(transcription?.segments)
      ? transcription.segments.map((segment) => ({ ...segment }))
      : [],
    coverage: {
      coveredDurationMs: Number.isFinite(transcription?.durationMs) ? transcription.durationMs : 0,
      totalDurationMs: Number.isFinite(transcription?.durationMs) ? transcription.durationMs : 0,
      ratio: Number.isFinite(transcription?.durationMs) && transcription.durationMs > 0 ? 1 : 0,
    },
    warnings: [reason],
    failedRanges: [],
  }
}

function createRunnerLogger(logger) {
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : () => {},
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : () => {},
  }
}

function toFiniteMs(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function createNativeSubtitleTranscription(sourceSnapshot, subtitleTrackId) {
  const tracks = Array.isArray(sourceSnapshot?.nativeSubtitleTracks)
    ? sourceSnapshot.nativeSubtitleTracks
    : []
  const normalizedTrackId = String(subtitleTrackId || '').trim()
  const track = tracks.find((item) => String(item?.id || '') === normalizedTrackId) || null
  const cues = Array.isArray(track?.cues) ? track.cues : []
  if (!track || cues.length === 0) throw new Error('BILIBILI_SUBTITLE_TRACK_NOT_FOUND')

  const segments = cues
    .map((cue, index) => ({
      id: `native-${index + 1}`,
      startMs: toFiniteMs(cue?.startMs),
      endMs: toFiniteMs(cue?.endMs),
      text: String(cue?.text || '').trim(),
      speaker: null,
      confidence: null,
    }))
    .filter((segment) => segment.text)

  if (segments.length === 0) throw new Error('BILIBILI_SUBTITLE_TRACK_NOT_FOUND')

  return {
    durationMs: Math.max(...segments.map((segment) => segment.endMs), 0),
    detectedLanguage:
      typeof track?.language === 'string' && track.language.trim() ? track.language.trim() : null,
    segments,
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError'
}

function isActionableModelError(error) {
  return ['MODEL_LOGIN_REQUIRED', 'MODEL_PROVIDER_PAGE_REQUIRED'].includes(error?.code)
}

function emitTaskFailure({ emit, taskId, owner, checkpointAvailable, error }) {
  emitEvent(emit, {
    type: 'TASK_FAILED',
    taskId,
    owner,
    checkpointAvailable,
    stage: error?.stage || null,
    errorCode: error?.code || error?.message || 'VIDEO_SUMMARY_TASK_FAILED',
    message: error?.message || 'VIDEO_SUMMARY_TASK_FAILED',
  })
}

function stripAssistantMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (message) => message?.role !== 'assistant',
  )
}

function normalizeCapabilityCode(capabilities) {
  return capabilities?.code || capabilities?.reason || 'MODEL_GATEWAY_UNSUPPORTED'
}

function isTemporaryOrUnavailableCapability(capabilities) {
  if (capabilities?.supported) return false
  if (capabilities?.temporary === true || capabilities?.temporarilyUnavailable === true) return true
  const state = String(capabilities?.state || capabilities?.status || '').toLowerCase()
  if (state === 'temporarilyunavailable' || state === 'temporary' || state === 'unavailable') {
    return true
  }
  const code = normalizeCapabilityCode(capabilities)
  return /TEMPORARILY_UNAVAILABLE|\bUNAVAILABLE\b/.test(code)
}

function createCapabilityError(capabilities, stage) {
  const code = normalizeCapabilityCode(capabilities)
  const error = new Error(code)
  error.code = code
  error.stage = stage
  return error
}

async function generateTextOnce({
  modelGateway,
  taskId,
  requestId,
  modelSnapshot,
  messages,
  maxOutputTokens,
  signal,
}) {
  assertNotAborted(signal)
  let activeRequestId = requestId
  const onAbort = () => {
    modelGateway.cancel?.({ taskId, requestId: activeRequestId })
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    activeRequestId = requestId
    const generateText =
      typeof modelGateway.generateText === 'function'
        ? modelGateway.generateText.bind(modelGateway)
        : modelGateway.generate?.bind(modelGateway)
    if (typeof generateText !== 'function') throw new Error('MODEL_GATEWAY_TEXT_CALLER_MISSING')

    const response = await generateText({
      requestId,
      taskId,
      modelSnapshot,
      messages: stripAssistantMessages(messages),
      maxOutputTokens,
    })
    assertNotAborted(signal)
    return {
      text: String(response?.text || ''),
      finishReason: typeof response?.finishReason === 'string' ? response.finishReason : null,
    }
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function chunkRangeKeyFromIds(startSegmentId, endSegmentId) {
  return `${startSegmentId || ''}\u0000${endSegmentId || ''}`
}

function chunkRangeKey(chunk) {
  return chunkRangeKeyFromIds(chunk?.primaryStartSegmentId, chunk?.primaryEndSegmentId)
}

function failedRangeKey(range) {
  return chunkRangeKeyFromIds(range?.startSegmentId, range?.endSegmentId)
}

function sortChunkResults(localChunkResults, chunks) {
  const orderByRange = new Map(chunks.map((chunk, index) => [chunkRangeKey(chunk), index]))
  return [...localChunkResults].sort((left, right) => {
    const leftOrder = orderByRange.get(
      chunkRangeKeyFromIds(left.primaryStartSegmentId, left.primaryEndSegmentId),
    )
    const rightOrder = orderByRange.get(
      chunkRangeKeyFromIds(right.primaryStartSegmentId, right.primaryEndSegmentId),
    )
    return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER)
  })
}

function buildFinalAllowedSegmentIds(localChunkResults) {
  return new Set(
    (Array.isArray(localChunkResults) ? localChunkResults : [])
      .flatMap((chunkResult) =>
        Array.isArray(chunkResult?.candidates) ? chunkResult.candidates : [],
      )
      .filter((candidate) => candidate?.anchored !== false && candidate?.segmentId)
      .map((candidate) => candidate.segmentId),
  )
}

async function summarizeChunk({
  chunk,
  chunkIndex,
  transcription,
  command,
  capabilities,
  modelGateway,
  controller,
}) {
  const { text } = await generateTextOnce({
    modelGateway,
    taskId: command.taskId,
    requestId: `chunk-${chunkIndex + 1}`,
    modelSnapshot: command.modelSnapshot,
    messages: buildChunkSummaryMessages({
      chunk,
      transcription,
      preferredLanguage: command.settingsSnapshot?.preferredLanguage,
    }),
    maxOutputTokens: resolveTaskMaxOutputTokens(command, capabilities, CHUNK_MAX_OUTPUT_TOKENS),
    signal: controller.signal,
  })
  const parsed = parseChunkSummaryMarkdown(text, {
    allowedSegmentIds: new Set(chunk.primarySegmentIds),
  })

  return {
    primaryStartSegmentId: chunk.primaryStartSegmentId,
    primaryEndSegmentId: chunk.primaryEndSegmentId,
    localSummary: String(parsed?.localSummary || '').trim(),
    keyPoints: Array.isArray(parsed?.keyPoints) ? parsed.keyPoints : [],
    candidates: Array.isArray(parsed?.candidates) ? parsed.candidates : [],
    rawText: String(parsed?.rawText || ''),
  }
}

async function synthesizeSummary({
  localChunkResults,
  command,
  capabilities,
  emit,
  modelGateway,
  controller,
}) {
  emitEvent(emit, {
    type: 'TASK_STATUS',
    taskId: command.taskId,
    owner: command.owner,
    stage: 'synthesizing-summary',
    checkpointAvailable: true,
  })

  const { text, finishReason } = await generateTextOnce({
    modelGateway,
    taskId: command.taskId,
    requestId: 'synthesis',
    modelSnapshot: command.modelSnapshot,
    messages: buildFinalSummaryMessages({
      chunkResults: localChunkResults,
      preferredLanguage: command.settingsSnapshot?.preferredLanguage,
    }),
    maxOutputTokens: resolveTaskMaxOutputTokens(command, capabilities, FINAL_MAX_OUTPUT_TOKENS),
    signal: controller.signal,
  })

  return {
    result: parseFinalSummaryMarkdown(text, {
      allowedSegmentIds: buildFinalAllowedSegmentIds(localChunkResults),
    }),
    finishReason,
  }
}

function appendResultWarning(result, warning) {
  if (!warning || result.warnings.includes(warning)) return result
  return {
    ...result,
    warnings: [...result.warnings, warning],
  }
}

async function summarizeChunks({
  transcription,
  checkpoint,
  command,
  emit,
  modelGateway,
  controller,
  retryFailedRanges = false,
}) {
  const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot)
  if (!capabilities?.supported) {
    checkpoint.successfulChunkResults = []
    checkpoint.failedRanges = []
    checkpoint.synthesisResult = null
    if (isTemporaryOrUnavailableCapability(capabilities)) {
      throw createCapabilityError(capabilities, 'summarizing-chunks')
    }

    const result = createTranscriptOnlyResult(
      transcription,
      capabilities?.reason || 'MODEL_GATEWAY_UNSUPPORTED',
    )
    emitEvent(emit, {
      type: 'TASK_RESULT',
      taskId: command.taskId,
      owner: command.owner,
      checkpointAvailable: true,
      result,
    })
    return result
  }

  const chunks = chunkTranscriptForSummary({
    transcription,
    inputTokenBudget: capabilities.inputTokenBudget,
  })
  const failedKeysToRetry = retryFailedRanges
    ? new Set((checkpoint.failedRanges || []).map(failedRangeKey))
    : new Set()
  const chunkEntries = chunks.map((chunk, index) => ({ chunk, index }))
  const selectedEntries =
    failedKeysToRetry.size > 0
      ? chunkEntries.filter(({ chunk }) => failedKeysToRetry.has(chunkRangeKey(chunk)))
      : chunkEntries
  const selectedKeys = new Set(selectedEntries.map(({ chunk }) => chunkRangeKey(chunk)))
  const localChunkResults =
    failedKeysToRetry.size > 0
      ? (checkpoint.successfulChunkResults || []).filter(
          (chunkResult) =>
            !selectedKeys.has(
              chunkRangeKeyFromIds(
                chunkResult.primaryStartSegmentId,
                chunkResult.primaryEndSegmentId,
              ),
            ),
        )
      : []
  const failedRanges =
    failedKeysToRetry.size > 0
      ? (checkpoint.failedRanges || []).filter((range) => !selectedKeys.has(failedRangeKey(range)))
      : []

  emitEvent(emit, {
    type: 'TASK_STATUS',
    taskId: command.taskId,
    owner: command.owner,
    stage: 'summarizing-chunks',
    completedChunks: 0,
    totalChunks: selectedEntries.length,
    checkpointAvailable: true,
  })

  for (const [completedIndex, { chunk, index }] of selectedEntries.entries()) {
    assertNotAborted(controller.signal)

    try {
      localChunkResults.push(
        await summarizeChunk({
          chunk,
          chunkIndex: index,
          transcription,
          command,
          capabilities,
          modelGateway,
          controller,
        }),
      )
    } catch (error) {
      if (isAbortError(error) || isActionableModelError(error)) throw error
      failedRanges.push(normalizeFailedRange(chunk, error?.code || error?.message))
    }

    emitEvent(emit, {
      type: 'TASK_STATUS',
      taskId: command.taskId,
      owner: command.owner,
      stage: 'summarizing-chunks',
      completedChunks: completedIndex + 1,
      totalChunks: selectedEntries.length,
      checkpointAvailable: true,
    })
  }

  const sortedChunkResults = sortChunkResults(localChunkResults, chunks)
  checkpoint.successfulChunkResults = sortedChunkResults
  checkpoint.failedRanges = failedRanges

  let synthesisResult = null
  let synthesisFinishReason = null
  try {
    const synthesis = await synthesizeSummary({
      localChunkResults: sortedChunkResults,
      command,
      capabilities,
      emit,
      modelGateway,
      controller,
    })
    synthesisResult = synthesis.result
    synthesisFinishReason = synthesis.finishReason
  } catch (error) {
    if (isAbortError(error) || isActionableModelError(error)) throw error
    synthesisResult = null
  }

  checkpoint.synthesisResult = synthesisResult

  let result = buildStructuredSummaryResult({
    transcription,
    localChunkResults: sortedChunkResults,
    synthesisResult,
    failedRanges,
  })
  if (synthesisResult && synthesisFinishReason === 'length') {
    result = appendResultWarning(result, 'MODEL_OUTPUT_INCOMPLETE')
  }

  emitEvent(emit, {
    type: 'TASK_RESULT',
    taskId: command.taskId,
    owner: command.owner,
    checkpointAvailable: true,
    result,
  })

  return result
}

export function createVideoTaskRunner({ mediaPipeline, modelGateway, logger, clock }) {
  const checkpoints = new Map()
  const controllers = new Map()
  const emits = new Map()
  const commands = new Map()
  const logs = createRunnerLogger(logger)

  async function runFromCheckpoint(taskId, command, emit, controller, options = {}) {
    const checkpoint = checkpoints.get(taskId)
    if (!checkpoint?.transcription) throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')
    return summarizeChunks({
      transcription: checkpoint.transcription,
      checkpoint,
      command,
      emit,
      modelGateway,
      controller,
      retryFailedRanges: options.retryFailedRanges === true,
    })
  }

  async function runSynthesisFromCheckpoint(taskId, command, emit, controller) {
    const checkpoint = checkpoints.get(taskId)
    if (!checkpoint?.transcription) throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')

    const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot)
    if (!capabilities?.supported && isTemporaryOrUnavailableCapability(capabilities)) {
      throw createCapabilityError(capabilities, 'synthesizing-summary')
    }

    let synthesisResult = null
    let synthesisFinishReason = null
    if (capabilities?.supported) {
      try {
        const synthesis = await synthesizeSummary({
          localChunkResults: checkpoint.successfulChunkResults,
          command,
          capabilities,
          emit,
          modelGateway,
          controller,
        })
        synthesisResult = synthesis.result
        synthesisFinishReason = synthesis.finishReason
      } catch (error) {
        if (isAbortError(error)) throw error
        synthesisResult = null
      }
    }

    checkpoint.synthesisResult = synthesisResult
    let result = buildStructuredSummaryResult({
      transcription: checkpoint.transcription,
      localChunkResults: checkpoint.successfulChunkResults,
      synthesisResult,
      failedRanges: checkpoint.failedRanges,
    })
    if (synthesisResult && synthesisFinishReason === 'length') {
      result = appendResultWarning(result, 'MODEL_OUTPUT_INCOMPLETE')
    }
    emitEvent(emit, {
      type: 'TASK_RESULT',
      taskId,
      owner: command.owner,
      checkpointAvailable: true,
      result,
    })
    return result
  }

  return {
    async start(command, emit) {
      const controller = new AbortController()
      const taskId = command?.taskId

      if (!taskId) throw new Error('VIDEO_SUMMARY_TASK_ID_REQUIRED')

      controllers.get(taskId)?.abort()
      controllers.set(taskId, controller)
      emits.set(taskId, emit)
      commands.set(taskId, structuredClone({ ...command, requestSourceRefresh: undefined }))
      checkpoints.set(taskId, {
        transcription: null,
        successfulChunkResults: [],
        failedRanges: [],
        synthesisResult: null,
      })

      emitEvent(emit, {
        type: 'TASK_STATUS',
        taskId,
        owner: command.owner,
        stage: 'resolving-source',
        checkpointAvailable: false,
      })

      try {
        let transcription
        if (command.sourceChoice === 'native-subtitle') {
          emitEvent(emit, {
            type: 'TASK_STATUS',
            taskId,
            owner: command.owner,
            stage: 'loading-native-subtitles',
            checkpointAvailable: false,
          })
          transcription = createNativeSubtitleTranscription(
            command.sourceSnapshot,
            command.subtitleTrackId,
          )
        } else if (command.sourceChoice === 'asr') {
          transcription = await mediaPipeline.transcribeFromSource({
            taskId,
            owner: command.owner,
            sourceSnapshot: command.sourceSnapshot,
            settingsSnapshot: command.settingsSnapshot,
            requestSourceRefresh: command.requestSourceRefresh,
            signal: controller.signal,
            onEvent(event) {
              emitEvent(emit, {
                type: 'TASK_STATUS',
                taskId,
                owner: command.owner,
                checkpointAvailable: false,
                ...event,
              })
            },
          })
        } else {
          throw new Error('VIDEO_SUMMARY_SOURCE_CHOICE_UNSUPPORTED')
        }

        checkpoints.set(taskId, {
          transcription,
          successfulChunkResults: [],
          failedRanges: [],
          synthesisResult: null,
        })

        logs.info({
          event: 'video-summary-task-runner.transcription-complete',
          taskId,
          atMs: clock?.now?.() ?? null,
        })

        return await runFromCheckpoint(taskId, command, emit, controller)
      } catch (error) {
        if (!isAbortError(error)) {
          emitTaskFailure({
            emit,
            taskId,
            owner: command.owner,
            checkpointAvailable: Boolean(checkpoints.get(taskId)?.transcription),
            error,
          })
        }
        throw error
      } finally {
        if (controllers.get(taskId) === controller) controllers.delete(taskId)
      }
    },

    cancel(taskId) {
      controllers.get(taskId)?.abort()
    },

    async retry(taskId, { fromStage, ...overrides } = {}) {
      if (!['summarizing', 'synthesis'].includes(fromStage)) {
        throw new Error('VIDEO_SUMMARY_RETRY_STAGE_UNSUPPORTED')
      }

      const baseCommand = commands.get(taskId)
      const emit = emits.get(taskId)
      if (!baseCommand || typeof emit !== 'function') {
        throw new Error('VIDEO_SUMMARY_TASK_NOT_FOUND')
      }

      const command = {
        ...baseCommand,
        ...overrides,
        taskId,
      }
      const controller = new AbortController()
      controllers.get(taskId)?.abort()
      controllers.set(taskId, controller)

      try {
        if (fromStage === 'synthesis') {
          return await runSynthesisFromCheckpoint(taskId, command, emit, controller)
        }

        const checkpoint = checkpoints.get(taskId)
        return await runFromCheckpoint(taskId, command, emit, controller, {
          retryFailedRanges:
            Array.isArray(checkpoint?.failedRanges) && checkpoint.failedRanges.length > 0,
        })
      } catch (error) {
        if (!isAbortError(error)) {
          emitTaskFailure({
            emit,
            taskId,
            owner: command.owner,
            checkpointAvailable: Boolean(checkpoints.get(taskId)?.transcription),
            error,
          })
        }
        throw error
      } finally {
        if (controllers.get(taskId) === controller) controllers.delete(taskId)
      }
    },
  }
}
