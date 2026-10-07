import assert from 'node:assert/strict'
import test from 'node:test'

import { fencesEqual } from '../../../src/video-summary/protocol.mjs'
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

function createFence({ generation = 1, attempt = 1 } = {}) {
  return {
    owner: {
      tabId: 1,
      documentId: 'doc-1',
      platform: 'youtube',
      mediaId: 'abcdefghijk',
    },
    taskId: 'task-1',
    generation,
    attempt,
  }
}

function createInitialPayload() {
  return {
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity: {
        platform: 'youtube',
        videoId: 'abcdefghijk',
        mediaId: 'abcdefghijk',
      },
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          language: 'en',
          cues: [{ startMs: 0, endMs: 1000, text: 'hello' }],
        },
      ],
      mediaCandidates: [],
    },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { modelName: 'customModel' },
  }
}

const runnerTasks = new WeakMap()

function normalizedOwner(command) {
  return {
    tabId: Number.isInteger(command.owner?.tabId) ? command.owner.tabId : 1,
    documentId: command.owner?.documentId || 'doc-1',
    platform: command.owner?.platform || 'bilibili',
    mediaId: command.owner?.mediaId || command.owner?.videoId || command.taskId,
  }
}

async function runInitial(runner, command, emit) {
  const fence = {
    owner: normalizedOwner(command),
    taskId: command.taskId,
    generation: 1,
    attempt: 1,
  }
  const requestId = `start-${command.taskId}`
  runner.registerAttempt({
    requestId,
    fence,
    mode: 'initial',
    payload: {
      sourceChoice: command.sourceChoice,
      subtitleTrackId: command.subtitleTrackId,
      settingsSnapshot: command.settingsSnapshot,
      modelSnapshot: command.modelSnapshot,
    },
    transientPayload: {
      sourceSnapshot: command.sourceSnapshot,
      requestSourceRefresh: command.requestSourceRefresh,
    },
    emit,
  })
  runnerTasks.set(runner, { fence, emit, attempt: 1 })
  return runner.authorizeAttempt({ requestId, fence })
}

async function runRetry(runner, taskId, payload) {
  const task = runnerTasks.get(runner)
  if (!task || task.fence.taskId !== taskId) throw new Error('VIDEO_SUMMARY_TASK_NOT_FOUND')
  const fence = { ...task.fence, attempt: ++task.attempt }
  const requestId = `retry-${taskId}-${task.attempt}`
  runner.registerAttempt({ requestId, fence, mode: 'retry-summary', payload, emit: task.emit })
  task.fence = fence
  return runner.authorizeAttempt({ requestId, fence })
}

function cancelRunner(runner) {
  const task = runnerTasks.get(runner)
  if (!task) return
  runner.cancelGeneration(task.fence)
  runner.deleteTask(task.fence)
  runnerTasks.delete(runner)
}

function createRunnerFixture() {
  const mediaCalls = []
  const modelCalls = []
  const events = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
        return {
          durationMs: 1000,
          segments: [{ id: 's1', startMs: 0, endMs: 1000, text: 'hello' }],
        }
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: false, reason: 'MODEL_GATEWAY_UNSUPPORTED' }
      },
      async generateText(args) {
        modelCalls.push(args)
        return { text: '', finishReason: null }
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 0 },
  })
  return { runner, mediaCalls, modelCalls, events }
}

test('terminal cleanup uses a fresh non-aborted signal after success and failure', async (t) => {
  for (const [name, mediaPipeline] of [
    [
      'success',
      {
        async transcribeFromSource() {
          return createTranscription()
        },
      },
    ],
    [
      'failure',
      {
        async transcribeFromSource() {
          throw new Error('TRANSCRIPTION_FAILED')
        },
      },
    ],
  ]) {
    await t.test(name, async () => {
      const cleanupSignals = []
      const runner = createVideoTaskRunner({
        mediaPipeline,
        modelGateway: createUnsupportedModelGateway(),
        logger: createLogger(),
        clock: { now: () => 0 },
        async cleanupTask({ taskId, signal }) {
          assert.equal(taskId, `cleanup-${name}`)
          cleanupSignals.push(signal)
        },
      })
      const promise = runInitial(
        runner,
        {
          taskId: `cleanup-${name}`,
          owner: { tabId: 1, documentId: 'doc-1', videoId: `BV1${name}` },
          sourceChoice: 'asr',
          sourceSnapshot: {},
          settingsSnapshot: {},
          modelSnapshot: {},
        },
        () => {},
      )
      if (name === 'failure') await assert.rejects(promise, /TRANSCRIPTION_FAILED/)
      else await promise
      assert.equal(cleanupSignals.length, 1)
      assert.equal(cleanupSignals[0].aborted, false)
    })
  }
})

test('registerAttempt accepts locally without beginning provider work', () => {
  const fixture = createRunnerFixture()
  const fence = createFence()
  const accepted = fixture.runner.registerAttempt({
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: (event) => fixture.events.push(event),
  })

  assert.deepEqual(accepted, { status: 'accepted', requestId: 'start-1', fence })
  assert.deepEqual(fixture.mediaCalls, [])
  assert.deepEqual(fixture.modelCalls, [])
})

test('only exact authorization begins the registered attempt', async () => {
  const fixture = createRunnerFixture()
  const fence = createFence()
  fixture.runner.registerAttempt({
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: (event) => fixture.events.push(event),
  })

  await assert.rejects(
    fixture.runner.authorizeAttempt({ requestId: 'wrong-request', fence }),
    /VIDEO_SUMMARY_ATTEMPT_NOT_REGISTERED/,
  )
  assert.deepEqual(fixture.mediaCalls, [])
  await fixture.runner.authorizeAttempt({ requestId: 'start-1', fence })
  assert.equal(fixture.modelCalls.length, 0)
  assert.equal(
    fixture.events.some((event) => event.type === 'TASK_RESULT'),
    true,
  )
})

test('duplicate registration is idempotent but conflicting registration is rejected', () => {
  const fixture = createRunnerFixture()
  const fence = createFence()
  const registration = {
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: (event) => fixture.events.push(event),
  }

  fixture.runner.registerAttempt(registration)
  assert.deepEqual(fixture.runner.registerAttempt(registration), {
    status: 'accepted',
    requestId: 'start-1',
    fence,
  })
  assert.throws(
    () => fixture.runner.registerAttempt({ ...registration, requestId: 'start-2' }),
    /VIDEO_SUMMARY_ATTEMPT_CONFLICT/,
  )
  assert.throws(
    () =>
      fixture.runner.registerAttempt({
        ...registration,
        fence: createFence({ attempt: 2 }),
      }),
    /VIDEO_SUMMARY_ATTEMPT_CONFLICT/,
  )
  assert.throws(
    () => fixture.runner.registerAttempt({ ...registration, mode: 'retry-summary' }),
    /VIDEO_SUMMARY_ATTEMPT_CONFLICT/,
  )
})

test('retry registration requires an existing transcription checkpoint', () => {
  const fixture = createRunnerFixture()

  assert.throws(
    () =>
      fixture.runner.registerAttempt({
        requestId: 'retry-1',
        fence: createFence({ attempt: 2 }),
        mode: 'retry-summary',
        payload: { fromStage: 'synthesis', modelSnapshot: { modelName: 'customModel' } },
        emit: () => {},
      }),
    /VIDEO_SUMMARY_(TASK_NOT_FOUND|CHECKPOINT_NOT_FOUND)/,
  )
})

test('generation cancellation latches before aborting attempts and isolates generations', async () => {
  const fixture = createRunnerFixture()
  const generation1 = createFence()
  const generation1Attempt2 = createFence({ attempt: 2 })
  const generation2 = createFence({ generation: 2 })
  for (const [requestId, fence] of [
    ['start-1', generation1],
    ['start-1-again', generation1Attempt2],
    ['start-2', generation2],
  ]) {
    fixture.runner.registerAttempt({
      requestId,
      fence,
      mode: 'initial',
      payload: createInitialPayload(),
      emit: () => {},
    })
  }
  const state = fixture.runner.debugState()
  const signal1 = state.attempts.find(({ fence }) => fencesEqual(fence, generation1)).controller
    .signal
  const signal1Attempt2 = state.attempts.find(({ fence }) =>
    fencesEqual(fence, generation1Attempt2),
  ).controller.signal
  const signal2 = state.attempts.find(({ fence }) => fencesEqual(fence, generation2)).controller
    .signal

  fixture.runner.cancelGeneration(generation1)

  assert.equal(signal1.aborted, true)
  assert.equal(signal1Attempt2.aborted, true)
  assert.equal(signal2.aborted, false)
  await assert.rejects(
    fixture.runner.authorizeAttempt({ requestId: 'start-1', fence: generation1 }),
    /VIDEO_SUMMARY_GENERATION_CANCELLED/,
  )
  await fixture.runner.authorizeAttempt({ requestId: 'start-2', fence: generation2 })
})

test('stale release cannot remove a newer attempt or its checkpoint', async () => {
  const fixture = createRunnerFixture()
  const attempt1 = createFence({ attempt: 1 })
  fixture.runner.registerAttempt({
    requestId: 'start-1',
    fence: attempt1,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: () => {},
  })
  await fixture.runner.authorizeAttempt({ requestId: 'start-1', fence: attempt1 })

  const attempt2 = createFence({ attempt: 2 })
  const generationKey = {
    owner: attempt1.owner,
    taskId: attempt1.taskId,
    generation: attempt1.generation,
  }
  fixture.runner.registerAttempt({
    requestId: 'retry-1',
    fence: attempt2,
    mode: 'retry-summary',
    payload: { fromStage: 'synthesis', modelSnapshot: { modelName: 'customModel' } },
    emit: () => {},
  })
  const attempt2Signal = fixture.runner
    .debugState()
    .attempts.find(({ fence }) => fencesEqual(fence, attempt2)).controller.signal

  fixture.runner.releaseAttempt(attempt1)
  assert.equal(fixture.runner.hasCheckpoint(generationKey), true)
  await fixture.runner.authorizeAttempt({ requestId: 'retry-1', fence: attempt2 })
  fixture.runner.releaseAttempt(attempt1)
  assert.equal(fixture.runner.hasCheckpoint(generationKey), true)
  assert.equal(attempt2Signal.aborted, false)
  fixture.runner.deleteTask(generationKey)
  fixture.runner.deleteTask(generationKey)
  assert.equal(fixture.runner.hasCheckpoint(generationKey), false)
})

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
          text: '## Overview\nfinal\n## Key Points\n- [segment:s1] anchored point\n- [segment:s2] invalid point\n## Chapters\n- [segment:s1] Opening — intro\n## Key Moments\n- [segment:s2] moment',
          finishReason: 'stop',
        }
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const emitted = []

  await runInitial(
    runner,
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
  assert.equal(
    calls.every((call) => call.requestKind === 'video-summary'),
    true,
  )
  assert.equal(
    calls.every((call) => call.toolPolicy === 'none'),
    true,
  )
  assert.equal(
    calls.every((call) =>
      call.messages.every(
        (message) =>
          Object.keys(message).sort().join(',') === 'content,role' &&
          ['system', 'user'].includes(message.role),
      ),
    ),
    true,
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
  assert.deepEqual(result.keyPoints, [
    { segmentId: 's1', startMs: transcription.segments[0].startMs, point: 'anchored point' },
    { segmentId: null, startMs: null, point: 'invalid point' },
  ])
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

  await runInitial(
    runner,
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
  assert.deepEqual(result.keyPoints, [{ segmentId: null, startMs: null, point: 'durable point' }])
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

  await runInitial(
    runner,
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

  await runInitial(
    runner,
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

test('empty, heading-only, and truncated chunks become failed ranges', async (t) => {
  const cases = [
    ['empty', '', 'stop', 'MODEL_OUTPUT_EMPTY'],
    [
      'heading-only',
      '## Chunk Summary\n## Chunk Key Points\n## Candidate Locations',
      'stop',
      'MODEL_OUTPUT_EMPTY',
    ],
    ['truncated', '## Chunk Summary\nusable but incomplete', 'length', 'MODEL_OUTPUT_INCOMPLETE'],
  ]

  for (const [name, invalidText, finishReason, reason] of cases) {
    await t.test(name, async () => {
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
            if (args.requestId === 'chunk-1') return { text: invalidText, finishReason }
            if (args.requestId === 'chunk-2') {
              return {
                text: '## Chunk Summary\nusable local summary',
                finishReason: 'stop',
              }
            }
            return { text: '## Overview\npartial final', finishReason: 'stop' }
          },
        },
        logger: createLogger(),
        clock: { now: () => 1234 },
      })
      const emitted = []

      await runInitial(
        runner,
        {
          taskId: `task-invalid-chunk-${name}`,
          owner: { tabId: 1, documentId: 'doc-1', videoId: `BV1${name}` },
          sourceChoice: 'asr',
          sourceSnapshot: { mediaCandidates: [{ id: 'c1' }] },
          settingsSnapshot: { preferredLanguage: 'en' },
          modelSnapshot: { modelName: 'customModel' },
        },
        (event) => emitted.push(event),
      )

      const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
      assert.equal(result.status, 'partial')
      assert.deepEqual(result.failedRanges, [{ startSegmentId: 's1', endSegmentId: 's6', reason }])
      assert.equal(result.overview, 'partial final')
    })
  }
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
      runInitial(
        runner,
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

test('invalid final Markdown falls back to local summaries with an incomplete warning', async (t) => {
  const cases = [
    ['empty', '', 'stop'],
    ['heading-only', '## Overview\n## Key Points\n## Chapters\n## Key Moments', 'stop'],
    [
      'truncated',
      '## Overview\ntruncated but parseable\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro',
      'length',
    ],
  ]

  for (const [name, invalidText, finishReason] of cases) {
    await t.test(name, async () => {
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
                text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point`,
                finishReason: 'stop',
              }
            }
            return { text: invalidText, finishReason }
          },
        },
        logger: createLogger(),
        clock: { now: () => 1234 },
      })
      const emitted = []

      await runInitial(
        runner,
        {
          taskId: `task-invalid-final-${name}`,
          owner: { tabId: 1, documentId: 'doc-1', videoId: `BV1final${name}` },
          sourceChoice: 'asr',
          sourceSnapshot: { mediaCandidates: [{ id: 'c1' }] },
          settingsSnapshot: { preferredLanguage: 'en' },
          modelSnapshot: { modelName: 'customModel' },
        },
        (event) => emitted.push(event),
      )

      const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
      assert.equal(result.status, 'degraded')
      assert.equal(result.overview.includes('local chunk-1'), true)
      assert.equal(result.overview.includes('truncated but parseable'), false)
      assert.equal(result.warnings.includes('MODEL_OUTPUT_INCOMPLETE'), true)
    })
  }
})

test('changed-budget retry replaces intersecting results and preserves the original chunk plan', async () => {
  const transcription = {
    durationMs: 24_000,
    segments: Array.from({ length: 24 }, (_, index) => ({
      id: `s${index + 1}`,
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      text: `segment ${index + 1}`,
    })),
  }
  const calls = []
  const mediaCalls = []
  let failInitialMiddle = true
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities(modelSnapshot) {
        return {
          supported: true,
          inputTokenBudget: modelSnapshot.inputTokenBudget,
          maxOutputTokens: 20_000,
        }
      },
      async generateText(args) {
        calls.push(args)
        if (failInitialMiddle && args.requestId === 'chunk-2') {
          throw new Error('TRANSIENT_SUMMARY_FAILURE')
        }
        if (args.requestId.startsWith('chunk-')) {
          return {
            text: `## Chunk Summary\nsummary ${args.modelSnapshot.inputTokenBudget} ${args.requestId}`,
            finishReason: 'stop',
          }
        }
        return { text: '## Overview\nfinal', finishReason: 'stop' }
      },
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const emit = () => {}
  let currentFence = createFence()
  runner.registerAttempt({
    requestId: 'initial-changed-budget',
    fence: currentFence,
    mode: 'initial',
    payload: {
      sourceChoice: 'asr',
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { inputTokenBudget: 20 },
    },
    transientPayload: { sourceSnapshot: {} },
    emit,
  })
  await runner.authorizeAttempt({ requestId: 'initial-changed-budget', fence: currentFence })

  failInitialMiddle = false
  currentFence = { ...currentFence, attempt: currentFence.attempt + 1 }
  runner.registerAttempt({
    requestId: 'retry-changed-budget',
    fence: currentFence,
    mode: 'retry-summary',
    payload: { fromStage: 'summarizing', modelSnapshot: { inputTokenBudget: 40 } },
    emit,
  })
  await runner.authorizeAttempt({ requestId: 'retry-changed-budget', fence: currentFence })

  assert.deepEqual(
    calls.map(({ requestId }) => requestId),
    ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'synthesis', 'chunk-1', 'synthesis'],
  )
  assert.equal(mediaCalls.length, 1)
  const retryChunkResults = JSON.parse(calls.at(-1).messages.at(-1).content).chunkResults
  assert.deepEqual(
    retryChunkResults.map(({ localSummary }) => localSummary),
    ['summary 40 chunk-1', 'summary 20 chunk-3', 'summary 20 chunk-4'],
  )
  assert.deepEqual(runner.debugState().checkpoints[0].originalChunkPlan, [
    { primaryStartSegmentId: 's1', primaryEndSegmentId: 's6' },
    { primaryStartSegmentId: 's7', primaryEndSegmentId: 's12' },
    { primaryStartSegmentId: 's13', primaryEndSegmentId: 's18' },
    { primaryStartSegmentId: 's19', primaryEndSegmentId: 's24' },
  ])

  const beforeRetry = calls.length
  await runner.registerAttempt({
    requestId: 'retry-synthesis',
    fence: { ...currentFence, attempt: currentFence.attempt + 1 },
    mode: 'retry-summary',
    payload: { fromStage: 'synthesis', modelSnapshot: { inputTokenBudget: 10 } },
    emit,
  })
  await runner.authorizeAttempt({
    requestId: 'retry-synthesis',
    fence: { ...currentFence, attempt: currentFence.attempt + 1 },
  })
  assert.deepEqual(
    calls.slice(beforeRetry).map(({ requestId }) => requestId),
    ['synthesis'],
  )
  assert.equal(mediaCalls.length, 1)
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

  await runInitial(runner, command, emit)

  const firstResult = emitted.findLast((event) => event.type === 'TASK_RESULT')
  assert.equal(firstResult.result.status, 'partial')
  assert.deepEqual(firstResult.result.failedRanges, [
    { startSegmentId: 's7', endSegmentId: 's12', reason: 'TRANSIENT_SUMMARY_FAILURE' },
  ])
  assert.equal(mediaPipelineCalls.length, 1)

  shouldFailSecondChunk = false
  await runRetry(runner, 'task-7', { fromStage: 'summarizing' })

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

  await runInitial(
    runner,
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
  const result = await runRetry(runner, 'task-synthesis-retry-fallback', { fromStage: 'synthesis' })

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

test('retry from synthesis rejects invalid final output and falls back to stored local chunks', async () => {
  const transcription = createTranscription()
  const calls = []
  let retrying = false
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
            text: `## Chunk Summary\nlocal ${args.requestId}`,
            finishReason: 'stop',
          }
        }
        if (retrying) {
          return {
            text: '## Overview\ntruncated retry',
            finishReason: 'length',
          }
        }
        return { text: '## Overview\ninitial final', finishReason: 'stop' }
      },
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const emitted = []

  await runInitial(
    runner,
    {
      taskId: 'task-invalid-synthesis-retry',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1invalidretry' },
      sourceChoice: 'asr',
      sourceSnapshot: { mediaCandidates: [{ id: 'c1' }] },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel' },
    },
    (event) => emitted.push(event),
  )

  retrying = true
  const result = await runRetry(runner, 'task-invalid-synthesis-retry', {
    fromStage: 'synthesis',
  })

  assert.deepEqual(
    calls.map((call) => call.requestId),
    ['chunk-1', 'chunk-2', 'synthesis', 'synthesis'],
  )
  assert.equal(result.status, 'degraded')
  assert.equal(result.overview.includes('local chunk-1'), true)
  assert.equal(result.overview.includes('truncated retry'), false)
  assert.equal(result.warnings.includes('MODEL_OUTPUT_INCOMPLETE'), true)
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

  await runInitial(
    runner,
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

  await runRetry(runner, 'task-synthesis-retry', { fromStage: 'synthesis' })

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

  await runInitial(
    runner,
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

test('native subtitle choice rejects a missing requested track without MediaKit fallback', async () => {
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
      runInitial(
        runner,
        {
          taskId: 'task-missing-track',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
          sourceChoice: 'native-subtitle',
          subtitleTrackId: 'missing',
          sourceSnapshot: { nativeSubtitleTracks: [] },
        },
        () => {},
      ),
    { message: 'VIDEO_NATIVE_SUBTITLES_NOT_FOUND' },
  )
  assert.equal(mediaCalls.length, 0)
})

test('successful tasks retain retry state until cancelled', async () => {
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return createTranscription()
      },
    },
    modelGateway: createUnsupportedModelGateway(),
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const emitted = []

  await runInitial(
    runner,
    {
      taskId: 'task-release-complete',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1release' },
      sourceChoice: 'asr',
      sourceSnapshot: {
        videoId: 'BV1release',
        signedMediaUrl: 'https://media.invalid/audio?signature=secret',
      },
      settingsSnapshot: { preferredLanguage: 'en' },
      modelSnapshot: { modelName: 'customModel' },
    },
    (event) => emitted.push(event),
  )

  await runRetry(runner, 'task-release-complete', { fromStage: 'summarizing' })
  assert.equal(emitted.filter((event) => event.type === 'TASK_RESULT').length, 2)

  cancelRunner(runner, 'task-release-complete')
  await assert.rejects(
    () => runRetry(runner, 'task-release-complete', { fromStage: 'summarizing' }),
    /VIDEO_SUMMARY_(TASK_NOT_FOUND|CHECKPOINT_NOT_FOUND)/,
  )
})

test('checkpointed failures retain retry state without cloning source data or callbacks', async () => {
  let capabilityAvailable = false
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return createTranscription()
      },
    },
    modelGateway: {
      async describeCapabilities() {
        if (!capabilityAvailable) {
          return {
            supported: false,
            code: 'MODEL_GATEWAY_TEMPORARILY_UNAVAILABLE',
            temporary: true,
          }
        }
        return { supported: false, reason: 'MODEL_GATEWAY_UNSUPPORTED' }
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const sourceSnapshot = {
    videoId: 'BV1checkpoint',
    nonCloneable: () => {},
  }

  await assert.rejects(
    () =>
      runInitial(
        runner,
        {
          taskId: 'task-checkpoint-retained',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1checkpoint' },
          sourceChoice: 'asr',
          sourceSnapshot,
          settingsSnapshot: { preferredLanguage: 'en' },
          modelSnapshot: { modelName: 'customModel' },
          requestSourceRefresh() {},
        },
        () => {},
      ),
    /MODEL_GATEWAY_TEMPORARILY_UNAVAILABLE/,
  )

  capabilityAvailable = true
  const result = await runRetry(runner, 'task-checkpoint-retained', { fromStage: 'summarizing' })
  assert.equal(result.status, 'degraded')
})

test('pre-transcription failures and cancellation release all retry state', async () => {
  let rejectTranscription
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      transcribeFromSource({ signal }) {
        return new Promise((resolve, reject) => {
          rejectTranscription = reject
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
    modelGateway: createUnsupportedModelGateway(),
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  await assert.rejects(
    () =>
      runInitial(
        runner,
        {
          taskId: 'task-before-checkpoint',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1failure' },
          sourceChoice: 'native-subtitle',
          subtitleTrackId: 'missing',
          sourceSnapshot: { nativeSubtitleTracks: [] },
          settingsSnapshot: {},
          modelSnapshot: {},
        },
        () => {},
      ),
    /VIDEO_NATIVE_SUBTITLES_NOT_FOUND/,
  )
  await assert.rejects(
    () => runRetry(runner, 'task-before-checkpoint', { fromStage: 'summarizing' }),
    /VIDEO_SUMMARY_(TASK_NOT_FOUND|CHECKPOINT_NOT_FOUND)/,
  )

  const startPromise = runInitial(
    runner,
    {
      taskId: 'task-cancel-release',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1cancel' },
      sourceChoice: 'asr',
      sourceSnapshot: { videoId: 'BV1cancel' },
      settingsSnapshot: {},
      modelSnapshot: {},
    },
    () => {},
  )
  await Promise.resolve()
  cancelRunner(runner, 'task-cancel-release')
  await assert.rejects(startPromise, { name: 'AbortError' })
  await assert.rejects(
    () => runRetry(runner, 'task-cancel-release', { fromStage: 'summarizing' }),
    /VIDEO_SUMMARY_(TASK_NOT_FOUND|CHECKPOINT_NOT_FOUND)/,
  )
  rejectTranscription?.(new Error('unused'))
})

test('cancellation while awaiting model capabilities does not start generation', async () => {
  let resolveCapabilities
  const generated = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {},
    modelGateway: {
      describeCapabilities(modelSnapshot, { signal }) {
        return new Promise((resolve, reject) => {
          resolveCapabilities = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      async generateText(args) {
        generated.push(args)
        return { text: '', finishReason: 'stop' }
      },
    },
    logger: createLogger(),
    clock: { now: () => 0 },
  })
  const currentFence = createFence()
  runner.registerAttempt({
    requestId: 'start-waiting',
    fence: currentFence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: () => {},
  })
  const pending = runner.authorizeAttempt({ requestId: 'start-waiting', fence: currentFence })
  await Promise.resolve()
  runner.cancelGeneration(currentFence)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(generated, [])
  resolveCapabilities?.({ supported: true })
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
      runInitial(
        runner,
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
