import { chunkTranscriptForSummary } from './summary-chunker.mjs'
import { buildStructuredSummaryResult } from './result-builder.mjs'
import { parseEvidenceLedgerMarkdown, splitTranscriptRange } from './evidence-ledger.mjs'
import {
  buildDirectSummaryMessages,
  buildLedgerFinalSummaryMessages,
  buildLedgerUpdateMessages,
  parseFinalSummaryMarkdown,
} from './summary-markdown.mjs'
import { createTaskFence, fencesEqual } from './protocol.mjs'
import { normalizeVideoSummaryMaxOutputTokens } from './settings.mjs'
import { validateFinalSummaryOutput } from './output-validity.mjs'

const LEDGER_MAX_OUTPUT_TOKENS = 4000
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

function emitTaskFailure({ emit, taskId, owner, checkpointAvailable, error }) {
  const errorCode =
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
      ? error.code
      : 'VIDEO_SUMMARY_TASK_FAILED'
  emitEvent(emit, {
    type: 'TASK_FAILED',
    taskId,
    owner,
    checkpointAvailable,
    ...(typeof error?.stage === 'string' && error.stage ? { stage: error.stage } : {}),
    errorCode,
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
    return {
      text: String(response?.text || ''),
      finishReason: typeof response?.finishReason === 'string' ? response.finishReason : null,
    }
  } finally {
    assertNotAborted(signal)
  }
}

function throwInvalidOutput(validity) {
  if (validity.valid) return
  const error = new Error(validity.reason)
  error.code = validity.reason
  throw error
}

function emitResult({ emit, command, result }) {
  emitEvent(emit, {
    type: 'TASK_RESULT',
    taskId: command.taskId,
    owner: command.owner,
    checkpointAvailable: true,
    result,
  })
  return result
}

function emitRollingProgress({ emit, command, completedChunks, totalChunks }) {
  emitEvent(emit, {
    type: 'TASK_STATUS',
    taskId: command.taskId,
    owner: command.owner,
    stage: 'summarizing-chunks',
    completedChunks,
    totalChunks,
    checkpointAvailable: true,
  })
}

async function describeSupportedModel({ checkpoint, command, modelGateway, controller, emit }) {
  assertNotAborted(controller.signal)
  const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot, {
    signal: controller.signal,
  })
  assertNotAborted(controller.signal)
  if (capabilities?.supported) return capabilities
  if (isTemporaryOrUnavailableCapability(capabilities)) {
    throw createCapabilityError(capabilities, 'synthesizing-summary')
  }
  return emitResult({
    emit,
    command,
    result: createTranscriptOnlyResult(
      checkpoint.transcription,
      capabilities?.reason || 'MODEL_GATEWAY_UNSUPPORTED',
    ),
  })
}

async function generateFinalSummary({
  checkpoint,
  command,
  capabilities,
  emit,
  modelGateway,
  controller,
  requestId,
  messages,
  allowedSegmentIds,
  coveredSegmentIds,
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
    requestId,
    modelSnapshot: command.modelSnapshot,
    messages,
    maxOutputTokens: resolveTaskMaxOutputTokens(command, capabilities, FINAL_MAX_OUTPUT_TOKENS),
    signal: controller.signal,
  })
  const synthesisResult = parseFinalSummaryMarkdown(text, { allowedSegmentIds })
  throwInvalidOutput(validateFinalSummaryOutput({ parsed: synthesisResult, finishReason }))
  return emitResult({
    emit,
    command,
    result: buildStructuredSummaryResult({
      transcription: checkpoint.transcription,
      localChunkResults: [],
      synthesisResult,
      failedRanges: checkpoint.failedRanges,
      coveredSegmentIds,
    }),
  })
}

async function runDirectSummary(args) {
  const { checkpoint, command } = args
  const segmentIds = checkpoint.transcription.segments.map(({ id }) => id)
  return generateFinalSummary({
    ...args,
    requestId: 'direct-synthesis',
    messages: buildDirectSummaryMessages({
      transcription: checkpoint.transcription,
      preferredLanguage: command.settingsSnapshot?.preferredLanguage,
    }),
    allowedSegmentIds: new Set(segmentIds),
    coveredSegmentIds: segmentIds,
  })
}

function createRollingRanges(transcription, inputTokenBudget) {
  const segmentIndexes = new Map(transcription.segments.map(({ id }, index) => [id, index]))
  return chunkTranscriptForSummary({ transcription, inputTokenBudget }).map((chunk) => ({
    startIndex: segmentIndexes.get(chunk.primaryStartSegmentId),
    endIndex: segmentIndexes.get(chunk.primaryEndSegmentId) + 1,
  }))
}

function promptRange(range, segmentCount) {
  return {
    ...range,
    contextBeforeStartIndex: Math.max(0, range.startIndex - 2),
    contextAfterEndIndex: Math.min(segmentCount, range.endIndex + 2),
  }
}

function ledgerAllowedSegmentIds(ledger) {
  return new Set(
    [
      ...(ledger?.narrative || []),
      ...(ledger?.evidence || []),
      ...(ledger?.chapterCandidates || []),
    ]
      .map(({ segmentId }) => segmentId)
      .filter(Boolean),
  )
}

async function synthesizeFromLedger(args) {
  const { checkpoint, command } = args
  return generateFinalSummary({
    ...args,
    requestId: 'ledger-synthesis',
    messages: buildLedgerFinalSummaryMessages({
      ledger: checkpoint.evidenceLedger,
      durationMs: checkpoint.transcription.durationMs,
      preferredLanguage: command.settingsSnapshot?.preferredLanguage,
    }),
    allowedSegmentIds: ledgerAllowedSegmentIds(checkpoint.evidenceLedger),
    coveredSegmentIds: checkpoint.transcription.segments
      .slice(0, checkpoint.nextSegmentIndex)
      .map(({ id }) => id),
  })
}

async function continueRollingLedger(args) {
  const { checkpoint, command, capabilities, emit, modelGateway, controller } = args
  const segments = checkpoint.transcription.segments
  emitRollingProgress({
    emit,
    command,
    completedChunks: checkpoint.nextSegmentIndex,
    totalChunks: segments.length,
  })
  while (checkpoint.rollingRanges.length > 0) {
    assertNotAborted(controller.signal)
    const range = checkpoint.rollingRanges[0]
    try {
      const { text, finishReason } = await generateTextOnce({
        modelGateway,
        taskId: command.taskId,
        requestId: `ledger-${checkpoint.nextSegmentIndex + 1}`,
        modelSnapshot: command.modelSnapshot,
        messages: buildLedgerUpdateMessages({
          ledger: checkpoint.evidenceLedger,
          range: promptRange(range, segments.length),
          transcription: checkpoint.transcription,
          preferredLanguage: command.settingsSnapshot?.preferredLanguage,
        }),
        maxOutputTokens: resolveTaskMaxOutputTokens(
          command,
          capabilities,
          LEDGER_MAX_OUTPUT_TOKENS,
        ),
        signal: controller.signal,
      })
      if (finishReason === 'length') {
        throw Object.assign(new Error('MODEL_OUTPUT_INCOMPLETE'), {
          code: 'MODEL_OUTPUT_INCOMPLETE',
        })
      }
      const allowedSegmentIds = new Set(segments.slice(0, range.endIndex).map(({ id }) => id))
      const ledger = parseEvidenceLedgerMarkdown(text, { allowedSegmentIds })
      const expectedCoveredId = segments[range.endIndex - 1]?.id || null
      if (!text.trim() || ledger.coveredThroughSegmentId !== expectedCoveredId) {
        throw Object.assign(new Error('MODEL_EVIDENCE_LEDGER_INVALID'), {
          code: 'MODEL_EVIDENCE_LEDGER_INVALID',
        })
      }
      checkpoint.evidenceLedger = ledger
      checkpoint.nextSegmentIndex = range.endIndex
      checkpoint.rollingRanges.shift()
      emitRollingProgress({
        emit,
        command,
        completedChunks: checkpoint.nextSegmentIndex,
        totalChunks: segments.length,
      })
    } catch (error) {
      if (error?.code !== 'MODEL_CONTEXT_WINDOW_EXCEEDED') throw error
      const halves = splitTranscriptRange(range)
      if (halves.length === 0) throw error
      checkpoint.rollingRanges.splice(0, 1, ...halves)
    }
  }
  return synthesizeFromLedger(args)
}

async function runSummary({ checkpoint, command, emit, modelGateway, controller }) {
  const capabilities = await describeSupportedModel({
    checkpoint,
    command,
    modelGateway,
    controller,
    emit,
  })
  if (!capabilities?.supported) return capabilities
  const args = { checkpoint, command, capabilities, emit, modelGateway, controller }
  if (checkpoint.summaryMode === 'rolling-ledger') return continueRollingLedger(args)
  try {
    return await runDirectSummary(args)
  } catch (error) {
    if (error?.code !== 'MODEL_CONTEXT_WINDOW_EXCEEDED') throw error
    checkpoint.summaryMode = 'rolling-ledger'
    checkpoint.nextSegmentIndex = 0
    checkpoint.evidenceLedger = null
    checkpoint.rollingRanges = createRollingRanges(
      checkpoint.transcription,
      capabilities.inputTokenBudget,
    )
    return continueRollingLedger(args)
  }
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

  function createCheckpoint(transcription = null) {
    return {
      transcription,
      summaryMode: 'direct',
      nextSegmentIndex: 0,
      evidenceLedger: null,
      rollingRanges: [],
      failedRanges: [],
    }
  }

  async function runFromCheckpoint(state, command, emit, controller) {
    const { checkpoint } = state
    if (!checkpoint?.transcription) throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')
    return runSummary({ checkpoint, command, emit, modelGateway, controller })
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

    state.checkpoint = createCheckpoint(transcription)
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
        checkpoint: createCheckpoint(),
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
      return await runFromCheckpoint(state, command, attempt.emit, attempt.controller)
    } catch (error) {
      const checkpointAvailable = Boolean(state.checkpoint?.transcription)
      if (isAbortError(error) && state.cancelled) {
        emitEvent(attempt.emit, { type: 'TASK_CANCELLED', checkpointAvailable })
      } else if (!isAbortError(error)) {
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

  function cancelState(state) {
    state.cancelled = true
    for (const attempt of state.attempts.values()) attempt.controller.abort()
  }

  function cancelGeneration(key) {
    const state = getGeneration(key)
    if (state) cancelState(state)
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
    cancelState(state)
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
