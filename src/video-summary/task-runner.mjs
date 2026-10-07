import { chunkTranscriptForSummary } from './summary-chunker.mjs'
import { buildStructuredSummaryResult } from './result-builder.mjs'
import {
  buildChunkSummaryMessages,
  buildFinalSummaryMessages,
  parseChunkSummaryMarkdown,
  parseFinalSummaryMarkdown,
} from './summary-markdown.mjs'
import { createTaskFence, fencesEqual } from './protocol.mjs'
import { normalizeVideoSummaryMaxOutputTokens } from './settings.mjs'
import { validateChunkSummaryOutput, validateFinalSummaryOutput } from './output-validity.mjs'
import {
  failedRangesOutsideRetry,
  selectRetryChunks,
  successfulResultsOutsideRetry,
} from './retry-ranges.mjs'

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

function createInfoLogger(logger) {
  return typeof logger?.info === 'function' ? logger.info.bind(logger) : () => {}
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
  if (!track || cues.length === 0) throw new Error('VIDEO_NATIVE_SUBTITLES_NOT_FOUND')

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

  if (segments.length === 0) throw new Error('VIDEO_NATIVE_SUBTITLES_NOT_FOUND')

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
  try {
    const generateText =
      typeof modelGateway.generateText === 'function'
        ? modelGateway.generateText.bind(modelGateway)
        : modelGateway.generate?.bind(modelGateway)
    if (typeof generateText !== 'function') throw new Error('MODEL_GATEWAY_TEXT_CALLER_MISSING')

    const response = await generateText(
      {
        requestId,
        taskId,
        modelSnapshot,
        messages: stripAssistantMessages(messages),
        maxOutputTokens,
        requestKind: 'video-summary',
        toolPolicy: 'none',
      },
      { signal },
    )
    assertNotAborted(signal)
    return {
      text: String(response?.text || ''),
      finishReason: typeof response?.finishReason === 'string' ? response.finishReason : null,
    }
  } finally {
    assertNotAborted(signal)
  }
}

function sortChunkResults(localChunkResults, transcription) {
  const orderBySegment = new Map(
    (transcription?.segments || []).map((segment, index) => [segment.id, index]),
  )
  return [...localChunkResults].sort(
    (left, right) =>
      (orderBySegment.get(left.primaryStartSegmentId) ?? Number.MAX_SAFE_INTEGER) -
      (orderBySegment.get(right.primaryStartSegmentId) ?? Number.MAX_SAFE_INTEGER),
  )
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
  const { text, finishReason } = await generateTextOnce({
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
  const validity = validateChunkSummaryOutput({ parsed, finishReason })
  if (!validity.valid) {
    const error = new Error(validity.reason)
    error.code = validity.reason
    throw error
  }

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
  assertNotAborted(controller.signal)
  const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot, {
    signal: controller.signal,
  })
  assertNotAborted(controller.signal)
  if (!capabilities?.supported) {
    checkpoint.successfulChunkResults = []
    checkpoint.failedRanges = []
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
  const selectedEntries = retryFailedRanges
    ? selectRetryChunks({
        transcription,
        chunks,
        failedRanges: checkpoint.failedRanges,
      })
    : chunks.map((chunk, index) => ({ chunk, index }))
  const selectedChunks = selectedEntries.map(({ chunk }) => chunk)
  const localChunkResults = retryFailedRanges
    ? successfulResultsOutsideRetry({
        transcription,
        successfulChunkResults: checkpoint.successfulChunkResults,
        selectedChunks,
      })
    : []
  const failedRanges = retryFailedRanges
    ? failedRangesOutsideRetry({
        transcription,
        failedRanges: checkpoint.failedRanges,
        selectedChunks,
      })
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

  const sortedChunkResults = sortChunkResults(localChunkResults, transcription)
  checkpoint.successfulChunkResults = sortedChunkResults
  checkpoint.failedRanges = failedRanges

  let synthesisResult = null
  let invalidSynthesis = false
  try {
    const synthesis = await synthesizeSummary({
      localChunkResults: sortedChunkResults,
      command,
      capabilities,
      emit,
      modelGateway,
      controller,
    })
    const validity = validateFinalSummaryOutput({
      parsed: synthesis.result,
      finishReason: synthesis.finishReason,
    })
    if (validity.valid) synthesisResult = synthesis.result
    else invalidSynthesis = true
  } catch (error) {
    if (isAbortError(error) || isActionableModelError(error)) throw error
    synthesisResult = null
  }

  let result = buildStructuredSummaryResult({
    transcription,
    localChunkResults: sortedChunkResults,
    synthesisResult,
    failedRanges,
  })
  if (invalidSynthesis) result = appendResultWarning(result, 'MODEL_OUTPUT_INCOMPLETE')

  emitEvent(emit, {
    type: 'TASK_RESULT',
    taskId: command.taskId,
    owner: command.owner,
    checkpointAvailable: true,
    result,
  })

  return result
}

export function createVideoTaskRunner({
  mediaPipeline,
  modelGateway,
  logger,
  clock,
  cleanupTask = async () => {},
  cleanupTimeoutMs = 10_000,
  onCleanupFailure = () => {},
}) {
  const generations = new Map()
  const logInfo = createInfoLogger(logger)

  async function cleanupTerminalMedia(state) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(createAbortError()), cleanupTimeoutMs)
    try {
      await cleanupTask({
        owner: state.owner,
        taskId: state.taskId,
        generation: state.generation,
        signal: controller.signal,
      })
    } catch {
      onCleanupFailure('VIDEO_SUMMARY_OPFS_CLEANUP_FAILED')
      throw new Error('VIDEO_SUMMARY_OPFS_CLEANUP_FAILED')
    } finally {
      clearTimeout(timer)
    }
  }

  function ownerPath(owner) {
    return [owner.tabId, owner.documentId, owner.platform, owner.mediaId]
  }

  function getNestedMap(root, keys, create = false) {
    let current = root
    for (const key of keys) {
      let next = current.get(key)
      if (!next && create) {
        next = new Map()
        current.set(key, next)
      }
      if (!next) return null
      current = next
    }
    return current
  }

  function getGeneration(key) {
    const taskMap = getNestedMap(generations, ownerPath(key.owner))
    return taskMap?.get(key.taskId)?.get(key.generation) || null
  }

  function setGeneration(state) {
    const taskMap = getNestedMap(generations, ownerPath(state.owner), true)
    let generationMap = taskMap.get(state.taskId)
    if (!generationMap) {
      generationMap = new Map()
      taskMap.set(state.taskId, generationMap)
    }
    generationMap.set(state.generation, state)
  }

  function removeGeneration(key) {
    const taskMap = getNestedMap(generations, ownerPath(key.owner))
    const generationMap = taskMap?.get(key.taskId)
    generationMap?.delete(key.generation)
    if (generationMap?.size === 0) taskMap.delete(key.taskId)
  }

  function clonePayload(payload) {
    const { requestSourceRefresh, ...cloneable } = payload || {}
    return { payload: structuredClone(cloneable), requestSourceRefresh }
  }

  function commandFor(state, attempt) {
    return {
      ...state.basePayload,
      ...attempt.payload,
      ...attempt.transientPayload,
      taskId: state.taskId,
      owner: state.owner,
      requestSourceRefresh: attempt.requestSourceRefresh,
    }
  }

  async function runFromCheckpoint(state, command, emit, controller, options = {}) {
    const { checkpoint } = state
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

  async function runSynthesisFromCheckpoint(state, command, emit, controller) {
    const { checkpoint, taskId } = state
    if (!checkpoint?.transcription) throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')

    assertNotAborted(controller.signal)
    const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot, {
      signal: controller.signal,
    })
    assertNotAborted(controller.signal)
    if (!capabilities?.supported && isTemporaryOrUnavailableCapability(capabilities)) {
      throw createCapabilityError(capabilities, 'synthesizing-summary')
    }

    let synthesisResult = null
    let invalidSynthesis = false
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
        const validity = validateFinalSummaryOutput({
          parsed: synthesis.result,
          finishReason: synthesis.finishReason,
        })
        if (validity.valid) synthesisResult = synthesis.result
        else invalidSynthesis = true
      } catch (error) {
        if (isAbortError(error)) throw error
        synthesisResult = null
      }
    }

    let result = buildStructuredSummaryResult({
      transcription: checkpoint.transcription,
      localChunkResults: checkpoint.successfulChunkResults,
      synthesisResult,
      failedRanges: checkpoint.failedRanges,
    })
    if (invalidSynthesis) result = appendResultWarning(result, 'MODEL_OUTPUT_INCOMPLETE')
    emitEvent(emit, {
      type: 'TASK_RESULT',
      taskId,
      owner: command.owner,
      checkpointAvailable: true,
      result,
    })
    return result
  }

  async function runInitial(state, attempt) {
    const command = commandFor(state, attempt)
    const { controller, emit } = attempt
    const { taskId } = state
    emitEvent(emit, {
      type: 'TASK_STATUS',
      taskId,
      owner: state.owner,
      stage: 'resolving-source',
      checkpointAvailable: false,
    })

    let transcription
    if (command.sourceChoice === 'native-subtitle') {
      emitEvent(emit, {
        type: 'TASK_STATUS',
        taskId,
        owner: state.owner,
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
        owner: state.owner,
        sourceSnapshot: command.sourceSnapshot,
        settingsSnapshot: command.settingsSnapshot,
        requestSourceRefresh: (args) =>
          command.requestSourceRefresh(args, { signal: controller.signal }),
        signal: controller.signal,
        onEvent(event) {
          emitEvent(emit, {
            type: 'TASK_STATUS',
            taskId,
            owner: state.owner,
            checkpointAvailable: false,
            ...event,
          })
        },
      })
    } else {
      throw new Error('VIDEO_SUMMARY_SOURCE_CHOICE_UNSUPPORTED')
    }

    state.checkpoint = {
      transcription,
      successfulChunkResults: [],
      failedRanges: [],
    }
    state.basePayload = structuredClone({
      settingsSnapshot: command.settingsSnapshot,
      modelSnapshot: command.modelSnapshot,
    })
    logInfo({
      event: 'video-summary-task-runner.transcription-complete',
      taskId,
      atMs: clock?.now?.() ?? null,
    })
    return runFromCheckpoint(state, command, emit, controller)
  }

  function registerAttempt({
    requestId,
    fence: fenceValue,
    mode,
    payload,
    emit,
    transientPayload = null,
  }) {
    const fence = createTaskFence(fenceValue)
    if (!['initial', 'retry-summary'].includes(mode)) {
      throw new Error('VIDEO_SUMMARY_ATTEMPT_MODE_UNSUPPORTED')
    }

    let state = getGeneration(fence)
    const existing = state?.attempts.get(fence.attempt)
    if (existing) {
      if (
        existing.requestId === requestId &&
        existing.mode === mode &&
        fencesEqual(existing.fence, fence)
      ) {
        return { status: 'accepted', requestId, fence }
      }
      throw new Error('VIDEO_SUMMARY_ATTEMPT_CONFLICT')
    }
    if ([...(state?.attempts.values() || [])].some((attempt) => attempt.requestId === requestId)) {
      throw new Error('VIDEO_SUMMARY_ATTEMPT_CONFLICT')
    }
    if (state?.cancelled) throw new Error('VIDEO_SUMMARY_GENERATION_CANCELLED')
    if (mode === 'retry-summary' && !state?.checkpoint?.transcription) {
      throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')
    }
    if (!state) {
      if (mode !== 'initial') throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')
      state = {
        owner: fence.owner,
        taskId: fence.taskId,
        generation: fence.generation,
        checkpoint: {
          transcription: null,
          successfulChunkResults: [],
          failedRanges: [],
        },
        basePayload: null,
        cancelled: false,
        attempts: new Map(),
      }
      setGeneration(state)
    }

    const cloned = clonePayload(payload)
    state.attempts.set(fence.attempt, {
      requestId,
      fence,
      mode,
      payload: cloned.payload,
      transientPayload,
      requestSourceRefresh: cloned.requestSourceRefresh,
      emit,
      controller: new AbortController(),
      state: 'registered',
    })
    return { status: 'accepted', requestId, fence }
  }

  async function authorizeAttempt({ requestId, fence: fenceValue }) {
    const fence = createTaskFence(fenceValue)
    const state = getGeneration(fence)
    if (state?.cancelled) throw new Error('VIDEO_SUMMARY_GENERATION_CANCELLED')
    const attempt = state?.attempts.get(fence.attempt)
    if (!attempt || attempt.requestId !== requestId || !fencesEqual(attempt.fence, fence)) {
      throw new Error('VIDEO_SUMMARY_ATTEMPT_NOT_REGISTERED')
    }
    if (attempt.state !== 'registered') throw new Error('VIDEO_SUMMARY_ATTEMPT_NOT_REGISTERED')
    attempt.state = 'authorized'

    const command = commandFor(state, attempt)
    try {
      if (attempt.mode === 'initial') return await runInitial(state, attempt)
      if (!['summarizing', 'synthesis'].includes(command.fromStage)) {
        throw new Error('VIDEO_SUMMARY_RETRY_STAGE_UNSUPPORTED')
      }
      if (command.fromStage === 'synthesis') {
        return await runSynthesisFromCheckpoint(state, command, attempt.emit, attempt.controller)
      }
      return await runFromCheckpoint(state, command, attempt.emit, attempt.controller, {
        retryFailedRanges: state.checkpoint.failedRanges.length > 0,
      })
    } catch (error) {
      const checkpointAvailable = Boolean(state.checkpoint?.transcription)
      if (!isAbortError(error)) {
        emitTaskFailure({
          emit: attempt.emit,
          taskId: state.taskId,
          owner: state.owner,
          checkpointAvailable,
          error,
        })
      }
      if (!checkpointAvailable && attempt.mode === 'initial') removeGeneration(state)
      throw error
    } finally {
      attempt.state = 'finished'
      await cleanupTerminalMedia(state)
    }
  }

  function cancelGeneration(key) {
    const state = getGeneration(key)
    if (!state) return
    state.cancelled = true
    for (const attempt of state.attempts.values()) attempt.controller.abort()
  }

  function releaseAttempt(fenceValue) {
    const fence = createTaskFence(fenceValue)
    const state = getGeneration(fence)
    const attempt = state?.attempts.get(fence.attempt)
    if (attempt && fencesEqual(attempt.fence, fence)) state.attempts.delete(fence.attempt)
  }

  function deleteTask(key) {
    const state = getGeneration(key)
    if (!state) return
    state.cancelled = true
    for (const attempt of state.attempts.values()) attempt.controller.abort()
    removeGeneration(key)
  }

  function hasCheckpoint(key) {
    return Boolean(getGeneration(key)?.checkpoint?.transcription)
  }

  const runner = {
    registerAttempt,
    authorizeAttempt,
    cancelGeneration,
    releaseAttempt,
    deleteTask,
    hasCheckpoint,
    debugState() {
      const attempts = []
      const checkpoints = []
      for (const tabMap of generations.values())
        for (const documentMap of tabMap.values())
          for (const platformMap of documentMap.values())
            for (const taskMap of platformMap.values())
              for (const generationMap of taskMap.values())
                for (const state of generationMap.values()) {
                  if (state.checkpoint) checkpoints.push(state.checkpoint)
                  for (const attempt of state.attempts.values()) attempts.push(attempt)
                }
      return { attempts, checkpoints }
    },
  }

  return runner
}
