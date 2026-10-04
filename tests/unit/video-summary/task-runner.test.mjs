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

function createUnsupportedModelGateway() {
  return {
    async describeCapabilities() {
      return { supported: false, reason: 'MODEL_GATEWAY_UNSUPPORTED' }
    },
    cancel() {},
  }
}

test('runner uses staged Markdown text generation without tool calls', async () => {
  const transcription = createTranscription()
  const calls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        calls.push(args)
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
            finishReason: 'stop',
          }
        }
        return {
          text: '## Overview\nfinal\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro\n## Key Moments\n- [segment:s2] moment',
          finishReason: 'stop',
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
      taskId: 'task-markdown-generation',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1markdown' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1markdown', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en', speakerIdentification: true },
      modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(
    calls.some((call) => 'tool' in call),
    false,
  )
  assert.deepEqual(
    calls.map((call) => call.maxOutputTokens),
    [1200, 1200, 4000],
  )
  assert.equal(
    calls.at(-1).messages.some((message) => message.content.includes('segment 1')),
    false,
  )
  assert.equal(result.chapters[0].startMs, 0)
})

test('article-only final Markdown output is preserved as an unanchored complete summary', async () => {
  const transcription = createTranscription()
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
            finishReason: 'stop',
          }
        }
        return {
          text: '## Overview\nA prose-only article summary.\n## Key Points\n- durable point',
          finishReason: 'stop',
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
      taskId: 'task-article-only',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1article' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1article', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'complete')
  assert.equal(result.overview, 'A prose-only article summary.')
  assert.deepEqual(result.keyPoints, ['durable point'])
  assert.equal(result.rawSummaryText.includes('A prose-only article summary.'), true)
})

test('synthesis generation failure falls back to local chunk summaries', async () => {
  const transcription = createTranscription()
  const calls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        calls.push(args)
        if (args.requestId === 'synthesis') throw new Error('SYNTHESIS_DOWN')
        return {
          text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point ${args.requestId}\n## Candidate Locations\n- [segment:s1] candidate`,
          finishReason: 'stop',
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
      taskId: 'task-synthesis-fallback',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1fallback' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1fallback', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'degraded')
  assert.equal(result.overview.includes('local chunk-1'), true)
  assert.equal(
    result.warnings.includes(
      'Summary synthesis was unavailable; local summaries were used instead.',
    ),
    true,
  )
  assert.deepEqual(
    calls.map((call) => call.requestId),
    ['chunk-1', 'chunk-2', 'synthesis'],
  )
})

test('one failed chunk is checkpointed while successful chunks still synthesize partial output', async () => {
  const transcription = createTranscription()
  const calls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        calls.push(args)
        if (args.requestId === 'chunk-2') throw new Error('TRANSIENT_SUMMARY_FAILURE')
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
            finishReason: 'stop',
          }
        }
        return {
          text: '## Overview\npartial final\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro',
          finishReason: 'stop',
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
      taskId: 'task-one-failed-chunk',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1partial' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1partial', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failedRanges, [
    { startSegmentId: 's7', endSegmentId: 's12', reason: 'TRANSIENT_SUMMARY_FAILURE' },
  ])
  assert.deepEqual(
    calls.map((call) => call.requestId),
    ['chunk-1', 'chunk-2', 'synthesis'],
  )
})

test('temporarily unavailable model capability fails with a transcript checkpoint', async () => {
  const transcription = createTranscription()
  const generated = []
  const emitted = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return {
          supported: false,
          reason: 'MODEL_GATEWAY_TEMPORARILY_UNAVAILABLE',
          code: 'MODEL_GATEWAY_TEMPORARILY_UNAVAILABLE',
          temporary: true,
        }
      },
      async generateText(args) {
        generated.push(args)
        throw new Error('generateText should not be called')
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  await assert.rejects(
    () =>
      runner.start(
        {
          taskId: 'task-temporary-unavailable',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1unavailable' },
          sourceChoice: 'asr',
          sourceSnapshot: { videoId: 'BV1unavailable', mediaCandidates: [{ id: 'c1' }] },
          settingsSnapshot: { preferredLanguage: 'en' },
          modelSnapshot: { modelName: 'customModel', apiMode: null },
        },
        (event) => emitted.push(event),
      ),
    { message: 'MODEL_GATEWAY_TEMPORARILY_UNAVAILABLE' },
  )

  assert.equal(generated.length, 0)
  assert.equal(
    emitted.some((event) => event.type === 'TASK_RESULT'),
    false,
  )
  const failure = emitted.findLast((event) => event.type === 'TASK_FAILED')
  assert.equal(failure.errorCode, 'MODEL_GATEWAY_TEMPORARILY_UNAVAILABLE')
  assert.equal(failure.checkpointAvailable, true)
})

test('length-truncated final Markdown keeps parseable content and adds incomplete warning', async () => {
  const transcription = createTranscription()
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
            finishReason: 'stop',
          }
        }
        return {
          text: '## Overview\ntruncated but parseable\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro',
          finishReason: 'length',
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
      taskId: 'task-length-warning',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1length' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1length', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'complete')
  assert.equal(result.overview, 'truncated but parseable')
  assert.equal(result.warnings.includes('MODEL_OUTPUT_INCOMPLETE'), true)
})

test('retry from summarizing reruns only failed ranges when a checkpoint has failures', async () => {
  const transcription = createTranscription()
  const mediaPipelineCalls = []
  const calls = []
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
          maxOutputTokens: 20_000,
        }
      },
      async generateText(args) {
        calls.push(args)

        if (args.requestId === 'chunk-2' && shouldFailSecondChunk) {
          throw new Error('TRANSIENT_SUMMARY_FAILURE')
        }

        if (args.requestId.startsWith('chunk-')) {
          const firstId = args.requestId === 'chunk-1' ? 's1' : 's7'
          return {
            text: `## Chunk Summary\nlocal summary ${args.requestId}\n## Chunk Key Points\n- Point ${args.requestId}\n## Candidate Locations\n- [segment:${firstId}] Candidate ${args.requestId}`,
            finishReason: 'stop',
          }
        }

        return {
          text: '## Overview\nFinal overview\n## Key Points\n- Point 1\n- Point 2\n## Chapters\n- [segment:s1] Opening — Opening summary\n- [segment:s7] Second half — Second half summary\n## Key Moments\n- [segment:s1] Moment 1\n- [segment:s7] Moment 2',
          finishReason: 'stop',
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
    sourceChoice: 'asr',
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
    calls.map((call) => call.requestId),
    ['chunk-1', 'chunk-2', 'synthesis', 'chunk-2', 'synthesis'],
  )
})

test('retry from synthesis falls back to stored local chunks when final generation fails', async () => {
  const transcription = createTranscription()
  const calls = []
  let failSynthesis = false
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        calls.push(args)
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
            finishReason: 'stop',
          }
        }
        if (failSynthesis) throw new Error('SYNTHESIS_DOWN')
        return {
          text: '## Overview\ninitial final\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro',
          finishReason: 'stop',
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
      taskId: 'task-synthesis-retry-fallback',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1synthesisfallback' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1synthesisfallback', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  failSynthesis = true
  const result = await runner.retry('task-synthesis-retry-fallback', { fromStage: 'synthesis' })

  assert.deepEqual(
    calls.map((call) => call.requestId),
    ['chunk-1', 'chunk-2', 'synthesis', 'synthesis'],
  )
  assert.equal(result.status, 'degraded')
  assert.equal(result.overview.includes('local chunk-1'), true)
  assert.equal(
    result.warnings.includes(
      'Summary synthesis was unavailable; local summaries were used instead.',
    ),
    true,
  )
})

test('retry from synthesis calls only final generation with stored chunk results', async () => {
  const transcription = createTranscription()
  const calls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        calls.push(args)
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
            finishReason: 'stop',
          }
        }
        return {
          text: `## Overview\nfinal ${calls.length}\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro`,
          finishReason: 'stop',
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
      taskId: 'task-synthesis-retry',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1synthesisretry' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1synthesisretry', mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
    (event) => emitted.push(event),
  )

  await runner.retry('task-synthesis-retry', { fromStage: 'synthesis' })

  assert.deepEqual(
    calls.map((call) => call.requestId),
    ['chunk-1', 'chunk-2', 'synthesis', 'synthesis'],
  )
  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.status, 'complete')
  assert.equal(result.overview, 'final 4')
})

test('Bilibili subtitle choice uses the requested track and never calls MediaKit', async () => {
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        assert.fail('Bilibili subtitle path must not call MediaKit')
      },
    },
    modelGateway: createUnsupportedModelGateway(),
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const emitted = []

  await runner.start(
    {
      taskId: 'task-ai-subtitle',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
      sourceChoice: 'native-subtitle',
      subtitleTrackId: 'ai-track',
      sourceSnapshot: {
        nativeSubtitleTracks: [
          {
            id: 'author-track',
            language: 'en',
            cues: [{ startMs: 0, endMs: 500, text: 'wrong track' }],
          },
          {
            id: 'ai-track',
            language: 'zh-CN',
            sourceKind: 'bilibili-ai',
            cues: [{ startMs: 1000, endMs: 2000, text: 'selected AI track' }],
          },
        ],
      },
      settingsSnapshot: { preferredLanguage: 'zh-Hans' },
      modelSnapshot: {},
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.transcriptSegments[0].text, 'selected AI track')
  assert.equal(result.transcriptSegments[0].id, 'native-1')
})

test('Bilibili subtitle choice rejects a missing requested track without MediaKit fallback', async () => {
  const mediaCalls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
      },
    },
    modelGateway: {},
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  await assert.rejects(
    () =>
      runner.start(
        {
          taskId: 'task-missing-track',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
          sourceChoice: 'native-subtitle',
          subtitleTrackId: 'missing',
          sourceSnapshot: { nativeSubtitleTracks: [] },
        },
        () => {},
      ),
    { message: 'BILIBILI_SUBTITLE_TRACK_NOT_FOUND' },
  )
  assert.equal(mediaCalls.length, 0)
})

test('unsupported source choice cannot fall through to paid ASR', async () => {
  const mediaCalls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
      },
    },
    modelGateway: {},
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  await assert.rejects(
    () =>
      runner.start(
        {
          taskId: 'task-invalid-source',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
          sourceChoice: 'unexpected-source',
          sourceSnapshot: { nativeSubtitleTracks: [], mediaCandidates: [{ id: 'audio' }] },
        },
        () => {},
      ),
    { message: 'VIDEO_SUMMARY_SOURCE_CHOICE_UNSUPPORTED' },
  )
  assert.equal(mediaCalls.length, 0)
})
