import assert from 'node:assert/strict'
import test from 'node:test'

import { createVideoTaskRunner } from '../../../src/video-summary/task-runner.mjs'

function createTranscription() {
  return {
    durationMs: 12_000,
    detectedLanguage: 'zh',
    segments: Array.from({ length: 12 }, (_, index) => ({
      id: `s${index + 1}`,
      startMs: index * 1000,
      endMs: index * 1000 + 1000,
      text: `segment ${index + 1}`,
      speaker: null,
      confidence: null,
    })),
  }
}

function createLogger() {
  return { info() {}, warn() {}, error() {} }
}

test('retry from summarizing reuses the saved transcription checkpoint without another ASR call', async () => {
  const transcription = createTranscription()
  const mediaPipelineCalls = []
  const toolCalls = []
  let shouldFailSecondChunk = true

  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaPipelineCalls.push(args)
        return transcription
      },
    },
    modelGateway: {
      describeCapabilities() {
        return {
          supported: true,
          reason: null,
          inputTokenBudget: 20,
          maxOutputTokens: 200,
        }
      },
      async invokeTool({ requestId, tool }) {
        toolCalls.push({ requestId, toolName: tool?.name })

        if (requestId === 'chunk-2' && shouldFailSecondChunk) {
          throw new Error('TRANSIENT_SUMMARY_FAILURE')
        }

        if (tool?.name === 'submit_chunk_summary') {
          const chunkNumber = Number(requestId.slice('chunk-'.length))
          return {
            toolName: tool.name,
            arguments: {
              localSummary: `local summary ${chunkNumber}`,
              chapterStarts: [
                {
                  segmentId: `s${chunkNumber === 1 ? 1 : 7}`,
                  title: `Chapter ${chunkNumber}`,
                  summary: `Summary ${chunkNumber}`,
                },
              ],
              keyMoments: [
                { segmentId: `s${chunkNumber === 1 ? 2 : 8}`, point: `Moment ${chunkNumber}` },
              ],
              keyPoints: [`Point ${chunkNumber}`],
            },
            argumentBytes: 0,
          }
        }

        return {
          toolName: tool.name,
          arguments: {
            overview: 'Final overview',
            keyPoints: ['Point 1', 'Point 2'],
            chapterStarts: [
              { segmentId: 's1', title: 'Opening', summary: 'Opening summary' },
              { segmentId: 's7', title: 'Second half', summary: 'Second half summary' },
            ],
            keyMoments: [
              { segmentId: 's2', point: 'Moment 1' },
              { segmentId: 's8', point: 'Moment 2' },
            ],
          },
          argumentBytes: 0,
        }
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  const emitted = []
  const emit = (event) => emitted.push(event)
  const command = {
    taskId: 'task-7',
    owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1task7001' },
    sourceSnapshot: { videoId: 'BV1task7001', mediaCandidates: [{ id: 'c1' }] },
    settingsSnapshot: { preferredLanguage: 'en', speakerIdentification: true },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
    requestSourceRefresh: async () => {
      throw new Error('should not refresh')
    },
  }

  await runner.start(command, emit)

  const firstResult = emitted.findLast((event) => event.type === 'TASK_RESULT')
  assert.equal(firstResult.result.status, 'partial')
  assert.deepEqual(firstResult.result.failedRanges, [
    { startSegmentId: 's7', endSegmentId: 's12', reason: 'TRANSIENT_SUMMARY_FAILURE' },
  ])
  assert.equal(mediaPipelineCalls.length, 1)

  shouldFailSecondChunk = false
  await runner.retry('task-7', { fromStage: 'summarizing' })

  const secondResult = emitted.findLast((event) => event.type === 'TASK_RESULT')
  assert.equal(secondResult.result.status, 'complete')
  assert.deepEqual(
    secondResult.result.chapters.map((chapter) => chapter.title),
    ['Opening', 'Second half'],
  )
  assert.equal(mediaPipelineCalls.length, 1)
  assert.deepEqual(
    toolCalls.map((call) => call.toolName),
    [
      'submit_chunk_summary',
      'submit_chunk_summary',
      'submit_video_summary',
      'submit_chunk_summary',
      'submit_chunk_summary',
      'submit_video_summary',
    ],
  )
})

test('assistant content is never passed as runner input messages', async () => {
  const transcription = createTranscription()
  const capturedMessages = []
  const capturedMaxOutputTokens = []

  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return {
          supported: true,
          reason: null,
          inputTokenBudget: 4000,
          maxOutputTokens: 200,
        }
      },
      async invokeTool({ tool, messages, maxOutputTokens }) {
        capturedMessages.push({ toolName: tool?.name, messages })
        capturedMaxOutputTokens.push(maxOutputTokens)
        return {
          toolName: tool.name,
          arguments:
            tool.name === 'submit_chunk_summary'
              ? { localSummary: 'ok', chapterStarts: [], keyMoments: [], keyPoints: [] }
              : { overview: 'ok', chapterStarts: [], keyMoments: [], keyPoints: [] },
          argumentBytes: 0,
        }
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  const emitted = []

  await runner.start(
    {
      taskId: 'task-no-assistant-input',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1noassistant' },
      sourceSnapshot: { videoId: 'BV1noassistant', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en', summaryMaxOutputTokens: 20_000 },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  assert.equal(capturedMessages.length > 0, true)
  assert.deepEqual(capturedMaxOutputTokens, [20_000, 20_000])
  for (const call of capturedMessages) {
    const roles = (Array.isArray(call.messages) ? call.messages : []).map((msg) => msg.role)
    assert.equal(roles.includes('assistant'), false)
  }

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'complete')
})

test('protocol errors fail only that chunk, no repair calls happen, and synthesis failure yields local-summary degraded output', async () => {
  const transcription = createTranscription()
  const toolCalls = []

  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return {
          supported: true,
          reason: null,
          inputTokenBudget: 20,
          maxOutputTokens: 200,
        }
      },
      async invokeTool({ requestId, tool }) {
        toolCalls.push({ requestId, toolName: tool?.name })

        if (tool?.name === 'submit_chunk_summary' && requestId === 'chunk-1') {
          throw Object.assign(new Error('MODEL_TOOL_ARGUMENTS_INVALID'), {
            code: 'MODEL_TOOL_ARGUMENTS_INVALID',
          })
        }

        if (tool?.name === 'submit_chunk_summary') {
          return {
            toolName: tool.name,
            arguments: {
              localSummary: `local summary ${requestId}`,
              chapterStarts: [],
              keyMoments: [],
              keyPoints: [],
            },
            argumentBytes: 0,
          }
        }

        throw Object.assign(new Error('MODEL_TOOL_CALL_MISSING'), {
          code: 'MODEL_TOOL_CALL_MISSING',
        })
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  const emitted = []

  await runner.start(
    {
      taskId: 'task-protocol-failures',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1protocol' },
      sourceSnapshot: { videoId: 'BV1protocol', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'degraded')
  assert.equal(
    toolCalls.some((call) => String(call.requestId).endsWith('-repair')),
    false,
  )
  assert.deepEqual(
    toolCalls.map((call) => call.toolName),
    ['submit_chunk_summary', 'submit_chunk_summary', 'submit_video_summary'],
  )
  assert.equal(
    result.overview.includes('local summary chunk-2'),
    true,
    `unexpected overview: ${result.overview}`,
  )
  assert.equal(result.failedRanges.length, 1)
})
