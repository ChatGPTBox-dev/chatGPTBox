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
          text: '## Overview\nA prose-only article summary.\n## Key Content\n- durable point',
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
  assert.deepEqual(result.keyMoments, [{ segmentId: null, startMs: null, point: 'durable point' }])
  assert.equal(result.rawSummaryText.includes('A prose-only article summary.'), true)
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
  const events = []
  runner.registerAttempt({
    requestId: 'start-waiting',
    fence: currentFence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: (event) => events.push(event),
  })
  const pending = runner.authorizeAttempt({ requestId: 'start-waiting', fence: currentFence })
  await Promise.resolve()
  runner.cancelGeneration(currentFence)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(generated, [])
  assert.deepEqual(
    events.filter(({ type }) => type === 'TASK_CANCELLED'),
    [{ type: 'TASK_CANCELLED', checkpointAvailable: true }],
  )
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

function finalMarkdown(segmentIds, label = 'final') {
  return `## Overview\n${label}\n## Key Content\n${segmentIds
    .map((id) => `- [segment:${id}] point ${id}`)
    .join('\n')}\n## Chapters\n${segmentIds
    .map((id) => `- [segment:${id}] chapter ${id} — detail`)
    .join('\n')}`
}

function ledgerMarkdown(segmentId) {
  return `## 主题与人物\n- topic\n## 叙事与论证\n- [segment:${segmentId}] narrative\n## 事实与证据\n- [segment:${segmentId}] evidence\n## 章节候选\n- [segment:${segmentId}] chapter — detail\n## 待补信息\n- none\n## 覆盖位置\n${segmentId}`
}

function createSummaryRunner({
  transcription = createTranscription(),
  generateText,
  inputTokenBudget = 20,
}) {
  const calls = []
  const events = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        return transcription
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: true, inputTokenBudget, maxOutputTokens: 20_000 }
      },
      async generateText(args) {
        calls.push(args)
        return generateText(args, calls)
      },
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  return { runner, calls, events, transcription }
}

function summaryCommand(taskId, modelSnapshot = { modelName: 'model-a' }) {
  return {
    taskId,
    owner: { tabId: 1, documentId: 'doc-1', videoId: taskId },
    sourceChoice: 'asr',
    sourceSnapshot: {},
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot,
  }
}

test('direct synthesis sends the complete transcript once with full anchor coverage', async () => {
  const fixture = createSummaryRunner({
    generateText: async () => ({
      text: finalMarkdown(createTranscription().segments.map(({ id }) => id)),
      finishReason: 'stop',
    }),
  })
  await runInitial(fixture.runner, summaryCommand('direct-success'), (event) =>
    fixture.events.push(event),
  )

  assert.deepEqual(
    fixture.calls.map(({ requestId }) => requestId),
    ['direct-synthesis'],
  )
  assert.deepEqual(
    JSON.parse(fixture.calls[0].messages[1].content).transcript.segments,
    fixture.transcription.segments.map(({ id, startMs, endMs, speaker, text }) => ({
      id,
      startMs,
      endMs,
      speaker,
      text,
    })),
  )
  const result = fixture.events.findLast(({ type }) => type === 'TASK_RESULT').result
  assert.equal(result.coverage.ratio, 1)
  assert.deepEqual(
    result.keyMoments.map(({ segmentId }) => segmentId),
    fixture.transcription.segments.map(({ id }) => id),
  )
  assert.equal(fixture.runner.debugState().checkpoints[0].summaryMode, 'direct')
})

test('only explicit context overflow falls back from direct synthesis', async (t) => {
  for (const code of [
    'MODEL_LOGIN_REQUIRED',
    'MODEL_RATE_LIMITED',
    'MODEL_NETWORK_FAILED',
    'MODEL_OUTPUT_INCOMPLETE',
    'MODEL_GATEWAY_GENERATION_FAILED',
  ]) {
    await t.test(code, async () => {
      const fixture = createSummaryRunner({
        generateText: async () => {
          throw Object.assign(new Error(code), { code })
        },
      })
      await assert.rejects(
        runInitial(fixture.runner, summaryCommand(`no-fallback-${code}`), (event) =>
          fixture.events.push(event),
        ),
        { code },
      )
      assert.deepEqual(
        fixture.calls.map(({ requestId }) => requestId),
        ['direct-synthesis'],
      )
      assert.equal(fixture.events.findLast(({ type }) => type === 'TASK_FAILED').errorCode, code)
    })
  }
})

test('context overflow uses sequential rolling ledger updates and ledger-only synthesis', async () => {
  const fixture = createSummaryRunner({
    generateText: async (args) => {
      if (args.requestId === 'direct-synthesis') {
        throw Object.assign(new Error('overflow'), { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' })
      }
      if (args.requestId === 'ledger-synthesis') {
        return { text: finalMarkdown(['s6', 's12']), finishReason: 'stop' }
      }
      const payload = JSON.parse(args.messages[1].content)
      const lastPrimary = payload.range.endIndex
      return { text: ledgerMarkdown(`s${lastPrimary}`), finishReason: 'stop' }
    },
  })
  await runInitial(fixture.runner, summaryCommand('rolling-success'), (event) =>
    fixture.events.push(event),
  )

  assert.equal(fixture.calls[0].requestId, 'direct-synthesis')
  assert.equal(
    fixture.calls.some(({ requestId }) => requestId.startsWith('chunk-')),
    false,
  )
  const ledgerCalls = fixture.calls.filter(
    ({ requestId }) => requestId.startsWith('ledger-') && requestId !== 'ledger-synthesis',
  )
  assert.equal(ledgerCalls.length, 2)
  const first = JSON.parse(ledgerCalls[0].messages[1].content)
  const second = JSON.parse(ledgerCalls[1].messages[1].content)
  assert.equal(first.ledger, null)
  assert.equal(second.ledger.coveredThroughSegmentId, 's6')
  assert.deepEqual(Object.keys(second).sort(), ['ledger', 'range', 'segments'])
  const synthesisPayload = JSON.parse(fixture.calls.at(-1).messages[1].content)
  assert.deepEqual(Object.keys(synthesisPayload), ['ledger'])
  assert.equal(JSON.stringify(synthesisPayload).includes('segment 1'), false)
  assert.equal(
    fixture.events.findLast(({ type }) => type === 'TASK_RESULT').result.coverage.ratio,
    1,
  )
})

test('rolling overflow splits only the current range and commits each segment once', async () => {
  const transcription = {
    durationMs: 8000,
    segments: Array.from({ length: 8 }, (_, index) => ({
      id: `s${index + 1}`,
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      text: `s${index + 1}`,
    })),
  }
  let overflowed = false
  const accepted = []
  const fixture = createSummaryRunner({
    transcription,
    inputTokenBudget: 1000,
    generateText: async (args) => {
      if (args.requestId === 'direct-synthesis') {
        throw Object.assign(new Error('overflow'), { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' })
      }
      if (args.requestId === 'ledger-synthesis') {
        return { text: finalMarkdown(['s4', 's8']), finishReason: 'stop' }
      }
      const { range } = JSON.parse(args.messages[1].content)
      if (!overflowed && range.startIndex === 0 && range.endIndex === 8) {
        overflowed = true
        throw Object.assign(new Error('overflow'), { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' })
      }
      accepted.push([range.startIndex, range.endIndex])
      return { text: ledgerMarkdown(`s${range.endIndex}`), finishReason: 'stop' }
    },
  })
  await runInitial(fixture.runner, summaryCommand('split-range'), () => {})
  assert.deepEqual(accepted, [
    [0, 4],
    [4, 8],
  ])
  assert.equal(fixture.runner.debugState().checkpoints[0].nextSegmentIndex, 8)
})

test('a single overflowing rolling segment fails without retrying forever', async () => {
  const transcription = {
    durationMs: 1000,
    segments: [{ id: 's1', startMs: 0, endMs: 1000, text: 'only' }],
  }
  const fixture = createSummaryRunner({
    transcription,
    generateText: async () => {
      throw Object.assign(new Error('overflow'), { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' })
    },
  })
  await assert.rejects(
    runInitial(fixture.runner, summaryCommand('single-overflow'), () => {}),
    { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' },
  )
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.runner.debugState().checkpoints[0].rollingRanges.length, 1)
})

test('rolling cancellation and failure resume without replay and can change model', async (t) => {
  for (const [name, interruption] of [
    ['cancellation', new DOMException('Aborted', 'AbortError')],
    ['failure', Object.assign(new Error('MODEL_NETWORK_FAILED'), { code: 'MODEL_NETWORK_FAILED' })],
  ]) {
    await t.test(name, async () => {
      let interrupted = false
      const fixture = createSummaryRunner({
        generateText: async (args) => {
          if (args.requestId === 'direct-synthesis') {
            throw Object.assign(new Error('overflow'), { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' })
          }
          if (args.requestId === 'ledger-synthesis') {
            return { text: finalMarkdown(['s6', 's12']), finishReason: 'stop' }
          }
          const payload = JSON.parse(args.messages[1].content)
          if (payload.range.startIndex === 6 && !interrupted) {
            interrupted = true
            throw interruption
          }
          return { text: ledgerMarkdown(`s${payload.range.endIndex}`), finishReason: 'stop' }
        },
      })
      await assert.rejects(
        runInitial(fixture.runner, summaryCommand(`resume-${name}`), () => {}),
        name === 'cancellation' ? { name: 'AbortError' } : { code: 'MODEL_NETWORK_FAILED' },
      )
      const checkpoint = fixture.runner.debugState().checkpoints[0]
      assert.equal(checkpoint.summaryMode, 'rolling-ledger')
      assert.equal(checkpoint.nextSegmentIndex, 6)
      assert.equal(checkpoint.evidenceLedger.coveredThroughSegmentId, 's6')
      await runRetry(fixture.runner, `resume-${name}`, {
        fromStage: 'summarizing',
        modelSnapshot: { modelName: 'model-b' },
      })
      const retryCalls = fixture.calls.slice(3)
      assert.equal(
        retryCalls.some((call) => JSON.parse(call.messages[1].content).range?.startIndex === 0),
        false,
      )
      assert.equal(retryCalls[0].modelSnapshot.modelName, 'model-b')
      assert.equal(
        JSON.parse(retryCalls[0].messages[1].content).ledger.coveredThroughSegmentId,
        's6',
      )
    })
  }
})

test('synthesis retries are mode-aware and never replay completed ledger ranges', async (t) => {
  await t.test('direct', async () => {
    const fixture = createSummaryRunner({
      generateText: async () => ({ text: finalMarkdown(['s1']), finishReason: 'stop' }),
    })
    await runInitial(fixture.runner, summaryCommand('retry-direct'), () => {})
    await runRetry(fixture.runner, 'retry-direct', { fromStage: 'synthesis' })
    assert.deepEqual(
      fixture.calls.map(({ requestId }) => requestId),
      ['direct-synthesis', 'direct-synthesis'],
    )
  })

  await t.test('rolling ledger', async () => {
    const fixture = createSummaryRunner({
      generateText: async (args) => {
        if (args.requestId === 'direct-synthesis') {
          throw Object.assign(new Error('overflow'), { code: 'MODEL_CONTEXT_WINDOW_EXCEEDED' })
        }
        if (args.requestId === 'ledger-synthesis') {
          return { text: finalMarkdown(['s6', 's12']), finishReason: 'stop' }
        }
        const { range } = JSON.parse(args.messages[1].content)
        return { text: ledgerMarkdown(`s${range.endIndex}`), finishReason: 'stop' }
      },
    })
    await runInitial(fixture.runner, summaryCommand('retry-rolling'), () => {})
    const beforeRetry = fixture.calls.length
    await runRetry(fixture.runner, 'retry-rolling', { fromStage: 'synthesis' })
    assert.deepEqual(
      fixture.calls.slice(beforeRetry).map(({ requestId }) => requestId),
      ['ledger-synthesis'],
    )
  })
})
