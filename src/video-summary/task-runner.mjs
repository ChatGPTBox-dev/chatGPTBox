import { chunkTranscriptForSummary } from './summary-chunker.mjs'
import { buildStructuredSummaryResult } from './result-builder.mjs'
import {
  CHUNK_SUMMARY_TOOL,
  VIDEO_SUMMARY_TOOL,
  normalizeChunkSummaryArguments,
  normalizeVideoSummaryArguments,
} from './summary-tools.mjs'
import { normalizeVideoSummaryMaxOutputTokens } from './settings.mjs'

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

function resolveTaskMaxOutputTokens(command, capabilities) {
  const hasTaskOutputTokenSetting = Object.prototype.hasOwnProperty.call(
    command?.settingsSnapshot || {},
    'summaryMaxOutputTokens',
  )
  return hasTaskOutputTokenSetting
    ? normalizeVideoSummaryMaxOutputTokens(command.settingsSnapshot.summaryMaxOutputTokens)
    : capabilities.maxOutputTokens
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

function buildChunkMessages(chunk, transcription, preferredLanguage) {
  const segmentById = new Map(
    (Array.isArray(transcription?.segments) ? transcription.segments : []).map((segment) => [
      segment.id,
      segment,
    ]),
  )
  const ids = [
    ...chunk.contextBeforeSegmentIds,
    ...chunk.primarySegmentIds,
    ...chunk.contextAfterSegmentIds,
  ]

  return [
    {
      role: 'system',
      content: `Summarize the transcript chunk in ${
        preferredLanguage || 'the original language'
      }. Call the function tool "${
        CHUNK_SUMMARY_TOOL.name
      }" exactly once with structured arguments. Use context segments only for understanding; every segmentId must come from primarySegmentIds.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        primarySegmentIds: chunk.primarySegmentIds,
        contextBeforeSegmentIds: chunk.contextBeforeSegmentIds,
        contextAfterSegmentIds: chunk.contextAfterSegmentIds,
        segments: ids.map((id) => segmentById.get(id)).filter(Boolean),
      }),
    },
  ]
}

function buildSynthesisMessages(localChunkResults, preferredLanguage) {
  return [
    {
      role: 'system',
      content: `Synthesize the local summaries in ${
        preferredLanguage || 'the original language'
      }. Call the function tool "${
        VIDEO_SUMMARY_TOOL.name
      }" exactly once with structured arguments.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        successfulChunkResults: localChunkResults,
      }),
    },
  ]
}

function stripAssistantMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (message) => message?.role !== 'assistant',
  )
}

async function invokeToolOnce({
  modelGateway,
  taskId,
  requestId,
  modelSnapshot,
  messages,
  maxOutputTokens,
  signal,
  tool,
}) {
  assertNotAborted(signal)
  let activeRequestId = requestId
  const onAbort = () => {
    modelGateway.cancel?.({ taskId, requestId: activeRequestId })
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    activeRequestId = requestId
    const response = await modelGateway.invokeTool({
      requestId,
      taskId,
      modelSnapshot,
      messages: stripAssistantMessages(messages),
      maxOutputTokens,
      tool,
    })
    assertNotAborted(signal)
    return response
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
  }
}

async function summarizeChunks({
  transcription,
  checkpoint,
  command,
  emit,
  modelGateway,
  controller,
}) {
  const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot)
  if (!capabilities?.supported) {
    checkpoint.successfulChunkResults = []
    checkpoint.failedRanges = []
    checkpoint.synthesisResult = null
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

  const maxOutputTokens = resolveTaskMaxOutputTokens(command, capabilities)

  const chunks = chunkTranscriptForSummary({
    transcription,
    inputTokenBudget: capabilities.inputTokenBudget,
  })
  const localChunkResults = []
  const failedRanges = []

  emitEvent(emit, {
    type: 'TASK_STATUS',
    taskId: command.taskId,
    owner: command.owner,
    stage: 'summarizing-chunks',
    completedChunks: 0,
    totalChunks: chunks.length,
    checkpointAvailable: true,
  })

  for (const [index, chunk] of chunks.entries()) {
    assertNotAborted(controller.signal)

    try {
      const { arguments: rawArgs } = await invokeToolOnce({
        modelGateway,
        taskId: command.taskId,
        requestId: `chunk-${index + 1}`,
        modelSnapshot: command.modelSnapshot,
        messages: buildChunkMessages(
          chunk,
          transcription,
          command.settingsSnapshot?.preferredLanguage,
        ),
        maxOutputTokens,
        signal: controller.signal,
        tool: CHUNK_SUMMARY_TOOL,
      })
      const parsed = normalizeChunkSummaryArguments(rawArgs, new Set(chunk.primarySegmentIds))

      localChunkResults.push({
        primaryStartSegmentId: chunk.primaryStartSegmentId,
        primaryEndSegmentId: chunk.primaryEndSegmentId,
        localSummary: String(parsed?.localSummary || '').trim(),
        chapterStarts: Array.isArray(parsed?.chapterStarts) ? parsed.chapterStarts : [],
        keyMoments: Array.isArray(parsed?.keyMoments) ? parsed.keyMoments : [],
        keyPoints: Array.isArray(parsed?.keyPoints) ? parsed.keyPoints : [],
      })
    } catch (error) {
      failedRanges.push(normalizeFailedRange(chunk, error?.message))
    }

    emitEvent(emit, {
      type: 'TASK_STATUS',
      taskId: command.taskId,
      owner: command.owner,
      stage: 'summarizing-chunks',
      completedChunks: index + 1,
      totalChunks: chunks.length,
      checkpointAvailable: true,
    })
  }

  checkpoint.successfulChunkResults = localChunkResults
  checkpoint.failedRanges = failedRanges

  emitEvent(emit, {
    type: 'TASK_STATUS',
    taskId: command.taskId,
    owner: command.owner,
    stage: 'synthesizing-summary',
    checkpointAvailable: true,
  })

  let synthesisResult = null
  try {
    const { arguments: rawArgs } = await invokeToolOnce({
      modelGateway,
      taskId: command.taskId,
      requestId: 'synthesis',
      modelSnapshot: command.modelSnapshot,
      messages: buildSynthesisMessages(
        localChunkResults,
        command.settingsSnapshot?.preferredLanguage,
      ),
      maxOutputTokens,
      signal: controller.signal,
      tool: VIDEO_SUMMARY_TOOL,
    })
    synthesisResult = normalizeVideoSummaryArguments(rawArgs)
  } catch (error) {
    synthesisResult = null
  }

  checkpoint.synthesisResult = synthesisResult

  const result = buildStructuredSummaryResult({
    transcription,
    localChunkResults,
    synthesisResult,
    failedRanges,
  })

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

  async function runFromCheckpoint(taskId, command, emit, controller) {
    const checkpoint = checkpoints.get(taskId)
    if (!checkpoint?.transcription) throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')
    return summarizeChunks({
      transcription: checkpoint.transcription,
      checkpoint,
      command,
      emit,
      modelGateway,
      controller,
    })
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

        return runFromCheckpoint(taskId, command, emit, controller)
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
          const checkpoint = checkpoints.get(taskId)
          if (!checkpoint?.transcription) throw new Error('VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND')

          const capabilities = await modelGateway.describeCapabilities(command.modelSnapshot)
          let synthesisResult = null
          if (capabilities?.supported) {
            emitEvent(emit, {
              type: 'TASK_STATUS',
              taskId,
              owner: command.owner,
              stage: 'synthesizing-summary',
              checkpointAvailable: true,
            })
            const { arguments: rawArgs } = await invokeToolOnce({
              modelGateway,
              taskId,
              requestId: 'synthesis',
              modelSnapshot: command.modelSnapshot,
              messages: buildSynthesisMessages(
                checkpoint.successfulChunkResults,
                command.settingsSnapshot?.preferredLanguage,
              ),
              maxOutputTokens: resolveTaskMaxOutputTokens(command, capabilities),
              signal: controller.signal,
              tool: VIDEO_SUMMARY_TOOL,
            })
            synthesisResult = normalizeVideoSummaryArguments(rawArgs)
          }

          checkpoint.synthesisResult = synthesisResult
          const result = buildStructuredSummaryResult({
            transcription: checkpoint.transcription,
            localChunkResults: checkpoint.successfulChunkResults,
            synthesisResult,
            failedRanges: checkpoint.failedRanges,
          })
          emitEvent(emit, {
            type: 'TASK_RESULT',
            taskId,
            owner: command.owner,
            checkpointAvailable: true,
            result,
          })
          return result
        }

        return runFromCheckpoint(taskId, command, emit, controller)
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
