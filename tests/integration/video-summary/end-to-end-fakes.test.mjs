import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureVideoSummaryOffscreenDocument } from '../../../src/background/offscreen.mjs'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
import { createVideoSummaryRouter } from '../../../src/background/video-summary-router.mjs'
import { createMediaPipeline } from '../../../src/video-summary/media-pipeline.mjs'
import { createTaskOpfsStore } from '../../../src/video-summary/opfs.mjs'
import { createVideoTaskRunner } from '../../../src/video-summary/task-runner.mjs'
import { startVideoSummaryOffscreenRuntime } from '../../../src/pages/VideoSummaryOffscreen/runtime.mjs'
import {
  VIDEO_SUMMARY_OFFSCREEN_PORT_NAME,
  VIDEO_SUMMARY_OFFSCREEN_PATH,
  createVideoSummaryOwner,
} from '../../../src/video-summary/contracts.mjs'
import { createVideoSummaryPortClient } from '../../../src/content-script/site-adapters/bilibili/video-summary-port.mjs'

function createFakeClock(start = 10_000) {
  let now = start
  let nextTimerId = 1
  const timers = new Map()

  return {
    now: () => now,
    setTimeout(callback, delay) {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, { callback, dueAt: now + delay })
      return timerId
    },
    clearTimeout(timerId) {
      timers.delete(timerId)
    },
    advance(ms) {
      now += ms
      const dueTimers = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)

      for (const [timerId, timer] of dueTimers) {
        timers.delete(timerId)
        timer.callback()
      }
    },
  }
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function flushTasks(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await nextTask()
  }
}

function waitWithTimeout(promise, label, timeoutMs = 200) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
    }),
  ])
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function createLinkedPortPair({ name, sender }) {
  const clientMessageListeners = new Set()
  const clientDisconnectListeners = new Set()
  const backgroundMessageListeners = new Set()
  const backgroundDisconnectListeners = new Set()
  const clientPostedMessages = []
  const backgroundPostedMessages = []
  let disconnected = false

  const notifyDisconnect = () => {
    if (disconnected) return
    disconnected = true
    for (const listener of Array.from(clientDisconnectListeners)) listener()
    for (const listener of Array.from(backgroundDisconnectListeners)) listener()
  }

  const clientPort = {
    name,
    sender: { documentId: sender.documentId },
    onMessage: {
      addListener(listener) {
        clientMessageListeners.add(listener)
      },
      removeListener(listener) {
        clientMessageListeners.delete(listener)
      },
    },
    onDisconnect: {
      addListener(listener) {
        clientDisconnectListeners.add(listener)
      },
      removeListener(listener) {
        clientDisconnectListeners.delete(listener)
      },
    },
    postMessage(message) {
      clientPostedMessages.push(structuredClone(message))
      for (const listener of Array.from(backgroundMessageListeners))
        listener(structuredClone(message))
    },
    disconnect() {
      notifyDisconnect()
    },
  }

  const backgroundPort = {
    name,
    sender,
    onMessage: {
      addListener(listener) {
        backgroundMessageListeners.add(listener)
      },
      removeListener(listener) {
        backgroundMessageListeners.delete(listener)
      },
    },
    onDisconnect: {
      addListener(listener) {
        backgroundDisconnectListeners.add(listener)
      },
      removeListener(listener) {
        backgroundDisconnectListeners.delete(listener)
      },
    },
    postMessage(message) {
      backgroundPostedMessages.push(structuredClone(message))
      for (const listener of Array.from(clientMessageListeners)) listener(structuredClone(message))
    },
    disconnect() {
      notifyDisconnect()
    },
  }

  return { clientPort, backgroundPort, clientPostedMessages, backgroundPostedMessages }
}

function createSubtitleTrack(
  cues,
  { id = 'sub-1', language = 'zh-CN', label = 'Chinese', sourceKind = 'unknown' } = {},
) {
  return [
    {
      id,
      language,
      label,
      sourceKind,
      cues: cues.map((cue) => ({ ...cue })),
    },
  ]
}

function createTranscription(segmentCount = 12, textPrefix = 'segment') {
  return {
    durationMs: segmentCount * 1000,
    detectedLanguage: 'zh',
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      id: `s${index + 1}`,
      startMs: index * 1000,
      endMs: index * 1000 + 1000,
      text: `${textPrefix} ${index + 1} `.repeat(8).trim(),
      speaker: null,
      confidence: 0.99,
    })),
  }
}

function createCandidate(overrides = {}) {
  return {
    mediaMetadata: {
      kind: 'audio',
      container: 'audio/mp4',
      codec: 'mp4a.40.2',
      contentLength: 64,
      durationMs: 12_000,
      ...overrides.mediaMetadata,
    },
    remoteCandidate: {
      url: 'https://cdn.example.invalid/audio.m4s?deadline=1790486400&token=secret',
      expiresAt: 1_790_486_400_000,
      ...overrides.remoteCandidate,
    },
    localFetchRecipe: {
      primaryUrl: 'https://www.bilibili.com/audio.m4s?deadline=1790486400&token=secret',
      backupUrls: [],
      expiresAt: 1_790_486_400_000,
      credentialMode: 'include',
      requiredRequestOrigin: 'https://www.bilibili.com/',
      ...overrides.localFetchRecipe,
    },
  }
}

function createSourceSnapshot({
  videoId = 'BV1task1001',
  nativeSubtitleTracks = [],
  mediaCandidates = [createCandidate()],
  title = 'Test video',
} = {}) {
  return {
    platform: 'bilibili',
    videoId,
    pageId: '1001',
    title,
    durationMs: 12_000,
    nativeSubtitleTracks,
    mediaCandidates,
  }
}

function createReadableResponse(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers,
  })
}

function createFallbackError() {
  const error = new Error('MEDIAKIT_DIRECT_DOWNLOAD_FAILED')
  error.operation = 'submit-asr'
  error.providerCode = 'URL_DOWNLOAD_FAILED'
  error.httpStatus = 400
  return error
}

function createFakeRootDirectory({ removeTaskDirFailure = null } = {}) {
  const files = new Map()
  let cleanupAttempts = 0

  function createFileHandle(fileKey) {
    let blob = new Blob([])
    return {
      async createWritable() {
        const parts = []
        return {
          async write(chunk) {
            parts.push(chunk)
          },
          async close() {
            blob = new Blob(parts, { type: 'audio/mp4' })
            files.set(fileKey, blob)
          },
          async abort() {
            parts.length = 0
          },
        }
      },
      async getFile() {
        return blob
      },
    }
  }

  return {
    files,
    async getDirectoryHandle(name) {
      if (name !== 'video-summary-tasks') {
        throw new Error(`unexpected directory: ${name}`)
      }

      return {
        async getDirectoryHandle(taskId, taskOptions = {}) {
          assert.equal(Boolean(taskOptions.create), true)
          return {
            async getFileHandle(fileName, fileOptions = {}) {
              assert.equal(Boolean(fileOptions.create), true)
              return createFileHandle(`${taskId}/${fileName}`)
            },
          }
        },
        async removeEntry(taskId, optionsForRemove = {}) {
          cleanupAttempts += 1
          assert.deepEqual(optionsForRemove, { recursive: true })
          if (removeTaskDirFailure && cleanupAttempts === 1) {
            throw removeTaskDirFailure
          }
          for (const key of Array.from(files.keys())) {
            if (key.startsWith(`${taskId}/`)) files.delete(key)
          }
        },
      }
    },
    get cleanupAttempts() {
      return cleanupAttempts
    },
  }
}

function createModelGateway({
  unsupportedSnapshots = new Set(),
  failRequestIds = new Set(),
  inputTokenBudget = 20,
  maxOutputTokens = 20_000,
  calls = [],
} = {}) {
  const serializeSnapshot = (snapshot) =>
    snapshot && typeof snapshot === 'object' ? JSON.stringify(snapshot) : String(snapshot)
  const unsupportedSnapshotKeys = new Set(
    Array.from(unsupportedSnapshots, (snapshot) => serializeSnapshot(snapshot)),
  )

  return {
    describeCapabilities(modelSnapshot) {
      const unsupported = unsupportedSnapshotKeys.has(serializeSnapshot(modelSnapshot))
      return {
        supported: !unsupported,
        reason: unsupported ? 'MODEL_GATEWAY_UNSUPPORTED' : null,
        inputTokenBudget,
        maxOutputTokens,
      }
    },
    async generateText({ requestId, modelSnapshot, messages, maxOutputTokens: requestedTokens }) {
      calls.push({
        requestId,
        modelSnapshot,
        maxOutputTokens: requestedTokens,
      })

      if (failRequestIds.has(requestId)) {
        throw new Error('TRANSIENT_SUMMARY_FAILURE')
      }

      if (requestId.startsWith('chunk-')) {
        const payload = JSON.parse(messages[1].content)
        const primarySegmentIds = payload.chunk?.primarySegmentIds || []
        const firstId = primarySegmentIds[0]
        const lastId = primarySegmentIds.at(-1)
        return {
          text: `## Chunk Summary\nlocal summary ${firstId}-${lastId}\n## Chunk Key Points\n- Point ${firstId}\n## Candidate Locations\n- [segment:${firstId}] Candidate ${firstId}`,
          finishReason: 'stop',
        }
      }

      const synthesisPayload = JSON.parse(messages[1].content)
      const successfulChunkResults = synthesisPayload.chunkResults || []
      const keyPoints = successfulChunkResults.flatMap((item) => item.keyPoints || [])
      const locations = successfulChunkResults.flatMap((item) => item.candidates || [])
      return {
        text: [
          '## Overview',
          `overview ${successfulChunkResults.length}`,
          '## Key Points',
          ...keyPoints.map((point) => `- ${point}`),
          '## Chapters',
          ...locations.map(
            (item) =>
              `- [segment:${item.segmentId}] Chapter ${item.segmentId} — Summary ${item.segmentId}`,
          ),
          '## Key Moments',
          ...locations.map((item) => `- [segment:${item.segmentId}] Moment ${item.segmentId}`),
        ].join('\n'),
        finishReason: 'stop',
      }
    },
    cancel() {},
  }
}

function createDirectPipeline({
  transcription,
  submitCalls,
  directFailureMode = null,
  uploadCalls = [],
  requestRefreshLog = [],
} = {}) {
  const cleanupFailure = Object.assign(new Error('busy'), { name: 'InvalidStateError', code: 11 })
  const rootDirectory = createFakeRootDirectory({ removeTaskDirFailure: cleanupFailure })
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr({ audioUrl, clientToken }) {
        submitCalls.push({ audioUrl, clientToken })
        if (directFailureMode === 'documented' && audioUrl.startsWith('https://')) {
          throw createFallbackError()
        }
        if (directFailureMode === 'ambiguous') {
          throw new TypeError('network lost before task id')
        }
        return transcription
      },
      async requestUploadTarget() {
        return {
          fileReference: 'mediakit://file-99',
          method: 'PUT',
          uploadUrl: 'https://upload.example.invalid/file-99?signature=secret',
          headers: { 'x-ttl': '1' },
        }
      },
    },
    opfsStoreFactory({ taskId }) {
      return createTaskOpfsStore({
        taskId,
        rootDirectory,
        fetchImpl: async (input, init = {}) => {
          const url = String(input)
          if (url === 'https://www.bilibili.com/audio.m4s?deadline=1790486400&token=secret') {
            return createReadableResponse(new Uint8Array([1, 2, 3, 4]), {
              'content-length': '4',
              'content-type': 'audio/mp4',
            })
          }
          if (url.startsWith('https://upload.example.invalid/')) {
            uploadCalls.push({
              method: init.method,
              headers: init.headers,
              bodySize: init.body.size,
            })
            return new Response(null, { status: 200 })
          }
          throw new Error(`unexpected fetch: ${url}`)
        },
        estimateStorage: async () => ({ quota: 4096, usage: 64 }),
        wait: async () => {},
      })
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: { now: () => 1_700_000_000_000 },
  })

  return {
    pipeline,
    rootDirectory,
    requestRefreshLog,
  }
}

function createLongRunningPipeline(deferred, calls = []) {
  return {
    async transcribeFromSource({ signal }) {
      calls.push('transcribe')
      signal?.throwIfAborted?.()
      const result = await deferred.promise
      signal?.throwIfAborted?.()
      return result
    },
  }
}

function createHarness({ mediaPipeline, modelGateway, clock = createFakeClock() } = {}) {
  const emittedCommands = []
  const pendingRefreshes = new Map()

  const taskRunner = createVideoTaskRunner({
    mediaPipeline,
    modelGateway,
    logger: { info() {}, warn() {}, error() {} },
    clock,
  })

  const router = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway,
    ensureOffscreenDocument: async () => {},
    clock,
    logger: { info() {}, warn() {}, error() {} },
    emitCommand(command) {
      emittedCommands.push(structuredClone(command))

      if (command.type === 'SOURCE_REFRESH_RESULT') {
        const refresh = pendingRefreshes.get(command.taskId)
        pendingRefreshes.delete(command.taskId)
        if (!refresh) return
        if (command.errorCode) {
          refresh.reject(Object.assign(new Error(command.errorCode), { stage: 'failed' }))
        } else {
          refresh.resolve(command.sourceSnapshot)
        }
        return
      }

      if (command.type === 'START_TASK') {
        void taskRunner
          .start(
            {
              ...command,
              requestSourceRefresh({ owner, taskId }) {
                return new Promise((resolve, reject) => {
                  pendingRefreshes.set(taskId, { resolve, reject })
                  router.requestSourceRefresh(owner, taskId)
                })
              },
            },
            (event) => router.handleTaskEvent(event),
          )
          .catch(() => {})
        return
      }

      if (command.type === 'RETRY_TASK') {
        void taskRunner.retry(command.taskId, command).catch(() => {})
        return
      }

      if (command.type === 'CANCEL_TASK') {
        taskRunner.cancel(command.taskId)
      }
    },
  })

  async function mountClient({
    owner,
    sourceSnapshot,
    refreshSnapshot = async () => sourceSnapshot,
  }) {
    const { clientPort, backgroundPort } = createLinkedPortPair({
      name: 'bilibili-video-summary',
      sender: {
        tab: { id: owner.tabId },
        documentId: owner.documentId,
      },
    })
    const events = []
    const waiters = []
    const disconnects = []

    const routerReady = router.handleConnect(backgroundPort)
    const client = createVideoSummaryPortClient({
      videoId: owner.videoId,
      pageBridge: {
        async getSnapshot() {
          return sourceSnapshot
        },
        async refreshSnapshot({ expectedVideoId }) {
          return refreshSnapshot({ expectedVideoId })
        },
        seekTo() {},
      },
      connect: () => clientPort,
      onEvent(event) {
        events.push(event)
        for (const waiter of Array.from(waiters)) {
          if (!waiter.predicate(event)) continue
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(event)
        }
      },
      onDisconnect() {
        disconnects.push('disconnect')
      },
    })
    await routerReady

    return {
      client,
      events,
      disconnects,
      async waitFor(predicate) {
        const existing = events.find(predicate)
        if (existing) return existing
        return waitWithTimeout(
          new Promise((resolve) => {
            waiters.push({ predicate, resolve })
          }),
          'task event',
        )
      },
    }
  }

  return {
    clock,
    router,
    emittedCommands,
    mountClient,
  }
}

test('ensureVideoSummaryOffscreenDocument single-flights creation and reuses the existing singleton context', async () => {
  const createCalls = []
  let contexts = []
  const runtime = {
    getURL(path) {
      return `chrome-extension://test/${path}`
    },
    async getContexts() {
      return contexts
    },
  }
  const chromeOffscreen = {
    async createDocument(options) {
      createCalls.push(options)
      contexts = [
        {
          contextType: 'OFFSCREEN_DOCUMENT',
          documentUrl: runtime.getURL(VIDEO_SUMMARY_OFFSCREEN_PATH),
        },
      ]
    },
  }

  await Promise.all([
    ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }),
    ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }),
  ])
  await ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen })

  assert.equal(createCalls.length, 1)
  assert.deepEqual(createCalls[0], {
    url: VIDEO_SUMMARY_OFFSCREEN_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Run the Bilibili video summary offscreen task lifecycle.',
  })
})

test('native subtitles complete without any MediaKit call', async () => {
  const mediaPipeline = {
    async transcribeFromSource() {
      assert.fail('native subtitle path must not call MediaKit')
    },
  }
  const modelCalls = []
  const modelGateway = createModelGateway({ calls: modelCalls })
  const harness = createHarness({ mediaPipeline, modelGateway })
  const owner = createVideoSummaryOwner({ tabId: 1, documentId: 'doc-1', videoId: 'BV1native' })
  const sourceSnapshot = createSourceSnapshot({
    videoId: owner.videoId,
    nativeSubtitleTracks: createSubtitleTrack([
      { startMs: 0, endMs: 1000, text: 'hello' },
      { startMs: 1000, endMs: 2200, text: 'world' },
    ]),
  })
  const mounted = await harness.mountClient({ owner, sourceSnapshot })

  await mounted.client.startTask({
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'sub-1',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const resultEvent = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
  assert.equal(resultEvent.result.status, 'complete')
  assert.deepEqual(
    resultEvent.result.transcriptSegments.map((segment) => segment.text),
    ['hello', 'world'],
  )
  assert.equal(modelCalls.length > 0, true)
  assert.equal(
    modelCalls.some((call) => 'tool' in call),
    false,
  )
})

for (const fixture of [
  {
    name: 'player AI subtitles',
    id: 'player-ai',
    label: '中文（自动生成）',
    lines: ['播放器 AI 字幕第一句', '播放器 AI 字幕第二句'],
  },
  {
    name: 'conclusion AI subtitles',
    id: 'bilibili-ai-conclusion',
    label: 'Bilibili AI subtitles',
    lines: ['总结接口 AI 字幕第一句', '总结接口 AI 字幕第二句'],
  },
]) {
  test(`${fixture.name} complete without any MediaKit call`, async () => {
    const mediaPipeline = {
      async transcribeFromSource() {
        assert.fail('Bilibili subtitle path must not call MediaKit')
      },
    }
    const harness = createHarness({ mediaPipeline, modelGateway: createModelGateway() })
    const owner = createVideoSummaryOwner({
      tabId: 1,
      documentId: `doc-${fixture.id}`,
      videoId: `BV1-${fixture.id}`,
    })
    const sourceSnapshot = createSourceSnapshot({
      videoId: owner.videoId,
      nativeSubtitleTracks: createSubtitleTrack(
        [
          { startMs: 0, endMs: 1000, text: fixture.lines[0] },
          { startMs: 1000, endMs: 2200, text: fixture.lines[1] },
        ],
        {
          id: fixture.id,
          label: fixture.label,
          sourceKind: 'bilibili-ai',
        },
      ),
    })
    const mounted = await harness.mountClient({ owner, sourceSnapshot })

    await mounted.client.startTask({
      sourceChoice: 'native-subtitle',
      subtitleTrackId: fixture.id,
      sourceSnapshot,
      settingsSnapshot: { preferredLanguage: 'zh-Hans' },
      modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
    })

    const resultEvent = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
    assert.deepEqual(
      resultEvent.result.transcriptSegments.map((segment) => segment.text),
      fixture.lines,
    )
  })
}

test('direct MediaKit success reaches complete and keeps upload count at 0', async () => {
  const transcription = createTranscription()
  const submitCalls = []
  const { pipeline } = createDirectPipeline({
    transcription,
    submitCalls,
  })
  const modelGateway = createModelGateway()
  const harness = createHarness({ mediaPipeline: pipeline, modelGateway })
  const owner = createVideoSummaryOwner({ tabId: 2, documentId: 'doc-2', videoId: 'BV1direct' })
  const sourceSnapshot = createSourceSnapshot({ videoId: owner.videoId })
  const mounted = await harness.mountClient({ owner, sourceSnapshot })

  await mounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const resultEvent = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
  assert.equal(resultEvent.result.status, 'complete')
  assert.deepEqual(submitCalls, [
    {
      audioUrl: 'https://cdn.example.invalid/audio.m4s?deadline=1790486400&token=secret',
      clientToken: submitCalls[0].clientToken,
    },
  ])
  assert.equal(
    harness.emittedCommands.some((command) => command.type === 'SOURCE_REFRESH_RESULT'),
    false,
  )
  assert.equal(
    harness.emittedCommands.some((command) => command.type === 'CANCEL_TASK'),
    false,
  )
})

test('a documented direct-download failure triggers one refresh, then one upload fallback', async () => {
  const transcription = createTranscription(3, 'uploaded')
  const submitCalls = []
  const uploadCalls = []
  const { pipeline, rootDirectory } = createDirectPipeline({
    transcription,
    submitCalls,
    directFailureMode: 'documented',
    uploadCalls,
  })
  const modelGateway = createModelGateway()
  const harness = createHarness({ mediaPipeline: pipeline, modelGateway })
  const owner = createVideoSummaryOwner({ tabId: 3, documentId: 'doc-3', videoId: 'BV1fallback' })
  const sourceSnapshot = createSourceSnapshot({ videoId: owner.videoId })
  const refreshedSnapshot = createSourceSnapshot({
    videoId: owner.videoId,
    mediaCandidates: [
      createCandidate({
        remoteCandidate: {
          url: 'https://cdn.example.invalid/audio-refreshed.m4s?deadline=1790486500&token=fresh',
          expiresAt: 1_790_486_500_000,
        },
        localFetchRecipe: {
          primaryUrl: 'https://www.bilibili.com/audio.m4s?deadline=1790486400&token=secret',
          backupUrls: [],
          expiresAt: 1_790_486_500_000,
          credentialMode: 'include',
          requiredRequestOrigin: 'https://www.bilibili.com/',
        },
      }),
    ],
  })
  const mounted = await harness.mountClient({
    owner,
    sourceSnapshot,
    refreshSnapshot: async ({ expectedVideoId }) => {
      assert.equal(expectedVideoId, owner.videoId)
      return refreshedSnapshot
    },
  })

  await mounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const resultEvent = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
  assert.equal(resultEvent.result.status, 'complete')
  assert.deepEqual(
    submitCalls.map((call) => call.audioUrl),
    [
      'https://cdn.example.invalid/audio.m4s?deadline=1790486400&token=secret',
      'https://cdn.example.invalid/audio-refreshed.m4s?deadline=1790486500&token=fresh',
      'mediakit://file-99',
    ],
  )
  assert.equal(uploadCalls.length, 1)
  assert.equal(rootDirectory.cleanupAttempts, 2)
  assert.equal(rootDirectory.files.size, 0)
})

test('unsupported summary model returns transcript-only output and a later retry succeeds with an injected supported snapshot', async () => {
  const transcription = createTranscription()
  const submitCalls = []
  const { pipeline } = createDirectPipeline({
    transcription,
    submitCalls,
  })
  const unsupportedModelSnapshot = { modelName: 'chatgptFree35' }
  const supportedModelSnapshot = {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' },
  }
  const modelGateway = createModelGateway({
    unsupportedSnapshots: new Set([unsupportedModelSnapshot]),
  })
  const harness = createHarness({ mediaPipeline: pipeline, modelGateway })
  const owner = createVideoSummaryOwner({
    tabId: 4,
    documentId: 'doc-4',
    videoId: 'BV1unsupported',
  })
  const sourceSnapshot = createSourceSnapshot({ videoId: owner.videoId })
  const mounted = await harness.mountClient({ owner, sourceSnapshot })

  await mounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: unsupportedModelSnapshot,
  })

  const transcriptOnlyResult = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
  assert.equal(transcriptOnlyResult.result.status, 'degraded')
  assert.deepEqual(transcriptOnlyResult.result.warnings, ['MODEL_GATEWAY_UNSUPPORTED'])

  await mounted.client.retryTask({
    fromStage: 'summarizing',
    modelSnapshot: supportedModelSnapshot,
  })

  await flushTasks()
  const finalResult = mounted.events.at(-1)
  assert.equal(finalResult.type, 'TASK_RESULT')
  assert.equal(finalResult.result.status, 'complete')
  assert.equal(submitCalls.length, 1)
})

test('one failed chunk returns partial output without another ASR call', async () => {
  const transcription = createTranscription()
  const submitCalls = []
  const modelCalls = []
  const { pipeline } = createDirectPipeline({
    transcription,
    submitCalls,
  })
  const modelGateway = createModelGateway({
    failRequestIds: new Set(['chunk-2']),
    calls: modelCalls,
  })
  const harness = createHarness({ mediaPipeline: pipeline, modelGateway })
  const owner = createVideoSummaryOwner({ tabId: 5, documentId: 'doc-5', videoId: 'BV1partial' })
  const sourceSnapshot = createSourceSnapshot({ videoId: owner.videoId })
  const mounted = await harness.mountClient({ owner, sourceSnapshot })

  await mounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const resultEvent = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
  assert.equal(
    modelCalls.some((call) => call.requestId === 'chunk-2' && !('tool' in call)),
    true,
  )
  assert.equal(
    modelCalls.some((call) => String(call.requestId).endsWith('-repair')),
    false,
  )
  assert.equal(resultEvent.result.status, 'partial', JSON.stringify(resultEvent.result))
  assert.deepEqual(resultEvent.result.failedRanges, [
    {
      startSegmentId: resultEvent.result.failedRanges[0].startSegmentId,
      endSegmentId: resultEvent.result.failedRanges[0].endSegmentId,
      reason: 'TRANSIENT_SUMMARY_FAILURE',
    },
  ])
  assert.equal(submitCalls.length, 1)
})

test('an ambiguous create-ASR response enters submission-unknown and does not silently create a new clientToken', async () => {
  const transcription = createTranscription()
  const submitCalls = []
  const { pipeline } = createDirectPipeline({
    transcription,
    submitCalls,
    directFailureMode: 'ambiguous',
  })
  const harness = createHarness({
    mediaPipeline: pipeline,
    modelGateway: createModelGateway(),
  })
  const owner = createVideoSummaryOwner({
    tabId: 6,
    documentId: 'doc-6',
    videoId: 'BV1ambiguous',
  })
  const sourceSnapshot = createSourceSnapshot({ videoId: owner.videoId })
  const mounted = await harness.mountClient({ owner, sourceSnapshot })

  await mounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const failedEvent = await mounted.waitFor(
    (event) => event.type === 'TASK_FAILED' || event.type === 'TASK_ERROR',
  )
  assert.equal(failedEvent.stage, 'submission-unknown')
  assert.equal(failedEvent.errorCode, 'VIDEO_SUMMARY_SUBMISSION_UNKNOWN')
  assert.equal(submitCalls.length, 1)
  assert.equal(new Set(submitCalls.map((call) => call.clientToken)).size, 1)
})

test('port disconnect, tab removal, video identity changes, and stale events affect only the matching owner task', async () => {
  const disconnectDeferred = createDeferred()
  const disconnectCalls = []
  const disconnectHarness = createHarness({
    mediaPipeline: createLongRunningPipeline(disconnectDeferred, disconnectCalls),
    modelGateway: createModelGateway(),
  })
  const disconnectOwner = createVideoSummaryOwner({
    tabId: 7,
    documentId: 'doc-7',
    videoId: 'BV1disconnect',
  })
  const disconnectSnapshot = createSourceSnapshot({ videoId: disconnectOwner.videoId })
  const disconnectMounted = await disconnectHarness.mountClient({
    owner: disconnectOwner,
    sourceSnapshot: disconnectSnapshot,
  })

  await disconnectMounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot: disconnectSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })
  disconnectMounted.client.dispose()
  disconnectHarness.clock.advance(15_001)
  await flushTasks()

  assert.deepEqual(disconnectCalls, ['transcribe'])
  assert.deepEqual(disconnectHarness.emittedCommands.at(-1), {
    type: 'CANCEL_TASK',
    taskId: disconnectHarness.emittedCommands[0].taskId,
    owner: disconnectOwner,
    reason: 'OWNER_DISCONNECTED',
  })

  const tabDeferred = createDeferred()
  const tabHarness = createHarness({
    mediaPipeline: createLongRunningPipeline(tabDeferred),
    modelGateway: createModelGateway(),
  })
  const removedOwner = createVideoSummaryOwner({
    tabId: 8,
    documentId: 'doc-8',
    videoId: 'BV1removed',
  })
  const unaffectedOwner = createVideoSummaryOwner({
    tabId: 9,
    documentId: 'doc-9',
    videoId: 'BV1kept',
  })
  const removedMounted = await tabHarness.mountClient({
    owner: removedOwner,
    sourceSnapshot: createSourceSnapshot({ videoId: removedOwner.videoId }),
  })
  const unaffectedMounted = await tabHarness.mountClient({
    owner: unaffectedOwner,
    sourceSnapshot: createSourceSnapshot({ videoId: unaffectedOwner.videoId }),
  })

  await removedMounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot: createSourceSnapshot({ videoId: removedOwner.videoId }),
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })
  await unaffectedMounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot: createSourceSnapshot({ videoId: unaffectedOwner.videoId }),
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  tabHarness.router.handleTabRemoved(removedOwner.tabId)
  await flushTasks()

  assert.equal(
    tabHarness.emittedCommands.some(
      (command) =>
        command.type === 'CANCEL_TASK' &&
        command.owner.tabId === removedOwner.tabId &&
        command.reason === 'OWNER_TAB_REMOVED',
    ),
    true,
  )
  assert.equal(
    tabHarness.emittedCommands.some(
      (command) => command.type === 'CANCEL_TASK' && command.owner.tabId === unaffectedOwner.tabId,
    ),
    false,
  )

  const refreshSubmitCalls = []
  const { pipeline: refreshPipeline } = createDirectPipeline({
    transcription: createTranscription(),
    submitCalls: refreshSubmitCalls,
    directFailureMode: 'documented',
  })
  const refreshHarness = createHarness({
    mediaPipeline: refreshPipeline,
    modelGateway: createModelGateway(),
  })
  const changedOwner = createVideoSummaryOwner({
    tabId: 10,
    documentId: 'doc-10',
    videoId: 'BV1changed',
  })
  const stableOwner = createVideoSummaryOwner({
    tabId: 11,
    documentId: 'doc-11',
    videoId: 'BV1stable',
  })
  const changedMounted = await refreshHarness.mountClient({
    owner: changedOwner,
    sourceSnapshot: createSourceSnapshot({ videoId: changedOwner.videoId }),
    refreshSnapshot: async ({ expectedVideoId }) => {
      throw new Error(
        expectedVideoId === changedOwner.videoId ? 'BILIBILI_VIDEO_IDENTITY_CHANGED' : 'unexpected',
      )
    },
  })
  const stableMounted = await refreshHarness.mountClient({
    owner: stableOwner,
    sourceSnapshot: createSourceSnapshot({ videoId: stableOwner.videoId }),
  })

  await changedMounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot: createSourceSnapshot({ videoId: changedOwner.videoId }),
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })
  await stableMounted.client.startTask({
    sourceChoice: 'asr',
    sourceSnapshot: createSourceSnapshot({ videoId: stableOwner.videoId }),
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const changedFailure = await changedMounted.waitFor(
    (event) => event.type === 'TASK_FAILED' || event.type === 'TASK_ERROR',
  )
  assert.equal(changedFailure.errorCode, 'BILIBILI_VIDEO_IDENTITY_CHANGED')

  refreshHarness.router.handleTaskEvent({
    type: 'TASK_STATUS',
    taskId: 'stale-task',
    owner: changedOwner,
    stage: 'stale',
  })
  await flushTasks()

  assert.equal(
    stableMounted.events.some((event) => event.stage === 'stale'),
    false,
  )
})

test('native subtitle and ASR tasks traverse the real background-offscreen port boundary', async () => {
  const modelCalls = []
  const modelGateway = createModelGateway({ calls: modelCalls })
  const submitCalls = []
  const clock = createFakeClock()
  const owner = createVideoSummaryOwner({
    tabId: 12,
    documentId: 'doc-12',
    videoId: 'BV12port',
  })
  const sourceSnapshot = createSourceSnapshot({
    videoId: owner.videoId,
    nativeSubtitleTracks: createSubtitleTrack([
      { startMs: 0, endMs: 1000, text: 'intro' },
      { startMs: 1000, endMs: 2000, text: 'body' },
    ]),
  })

  const router = createVideoSummaryRouter({
    mediaKitGateway: {},
    modelGateway,
    ensureOffscreenDocument: async () => {},
    clock,
    logger: { info() {}, warn() {}, error() {} },
    emitCommand(command) {
      offscreenRpc.postCommand(command)
    },
  })

  const { clientPort, backgroundPort } = createLinkedPortPair({
    name: 'bilibili-video-summary',
    sender: {
      tab: { id: owner.tabId },
      documentId: owner.documentId,
    },
  })
  const {
    clientPort: offscreenClientPort,
    backgroundPort: offscreenBackgroundPort,
    clientPostedMessages: offscreenPostedToBackground,
  } = createLinkedPortPair({
    name: VIDEO_SUMMARY_OFFSCREEN_PORT_NAME,
    sender: {
      id: 'extension-id',
      url: 'chrome-extension://test/VideoSummaryOffscreen.html',
      documentId: 'offscreen-doc',
    },
  })
  const offscreenRpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async submitDirectAsr({ audioUrl, clientToken }) {
        submitCalls.push({ audioUrl, clientToken })
        return createTranscription(4, 'rpc-port')
      },
      async requestUploadTarget() {
        assert.fail('upload fallback should not run in this integration path')
      },
      async queryTask() {
        assert.fail('queryTask should not run when submitDirectAsr returns segments directly')
      },
    },
    modelGateway,
    logger: { info() {}, warn() {}, error() {} },
    onTaskEvent(event) {
      router.handleTaskEvent(event)
    },
    requestSourceRefresh({ owner: refreshOwner, taskId }) {
      router.requestSourceRefresh(refreshOwner, taskId)
    },
  })

  offscreenRpc.attachPort(offscreenBackgroundPort)
  startVideoSummaryOffscreenRuntime({
    port: offscreenClientPort,
    logger: { info() {}, warn() {}, error() {} },
    clock,
  })

  const events = []
  const mounted = createVideoSummaryPortClient({
    videoId: owner.videoId,
    pageBridge: {
      async getSnapshot() {
        return sourceSnapshot
      },
      async refreshSnapshot({ expectedVideoId }) {
        assert.equal(expectedVideoId, owner.videoId)
        return createSourceSnapshot({ videoId: owner.videoId })
      },
      seekTo() {},
    },
    connect: () => clientPort,
    onEvent(event) {
      events.push(event)
    },
  })
  await router.handleConnect(backgroundPort)

  await mounted.startTask({
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'sub-1',
    sourceSnapshot,
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const nativeResult = await waitWithTimeout(
    new Promise((resolve) => {
      const interval = setInterval(() => {
        const event = events.find((entry) => entry.type === 'TASK_RESULT')
        if (!event) return
        clearInterval(interval)
        resolve(event)
      }, 0)
    }),
    'native result',
  )
  assert.equal(nativeResult.result.status, 'complete')
  assert.equal(
    offscreenPostedToBackground.some((message) => message.type === 'GATEWAY_REQUEST'),
    true,
  )
  assert.equal(
    offscreenPostedToBackground.some(
      (message) =>
        message.type === 'GATEWAY_REQUEST' &&
        message.gateway === 'model' &&
        message.operation === 'generateText',
    ),
    true,
  )

  await mounted.startTask({
    sourceChoice: 'asr',
    sourceSnapshot: createSourceSnapshot({ videoId: owner.videoId }),
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
  })

  const asrResult = await waitWithTimeout(
    new Promise((resolve) => {
      const interval = setInterval(() => {
        const event = events.filter((entry) => entry.type === 'TASK_RESULT')[1]
        if (!event) return
        clearInterval(interval)
        resolve(event)
      }, 0)
    }),
    'asr result',
  )
  assert.equal(asrResult.result.status, 'complete')
  assert.equal(submitCalls.length, 1)
  assert.equal(modelCalls.length > 0, true)
  assert.equal(
    modelCalls.some((call) => 'tool' in call),
    false,
  )
  assert.equal(
    modelCalls.some((call) => String(call.requestId).endsWith('-repair')),
    false,
  )
  assert.equal(
    offscreenPostedToBackground.some(
      (message) =>
        message.type === 'GATEWAY_REQUEST' &&
        message.gateway === 'mediakit' &&
        message.operation === 'submitDirectAsr',
    ),
    true,
  )
  assert.equal(
    offscreenPostedToBackground.some((message) => message.type === 'TASK_EVENT'),
    true,
  )
})
