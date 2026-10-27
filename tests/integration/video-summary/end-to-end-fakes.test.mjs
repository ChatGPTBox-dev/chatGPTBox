import assert from 'node:assert/strict'
import test from 'node:test'

import { createVideoSummaryCoordinator } from '../../../src/background/video-summary-coordinator.mjs'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
import { createVideoSummaryRouter } from '../../../src/background/video-summary-router.mjs'
import { createVideoSummaryAdapterController } from '../../../src/content-script/video-summary-adapter-controller.mjs'
import { startVideoSummaryOffscreenRuntime } from '../../../src/pages/VideoSummaryOffscreen/runtime.mjs'
import { createMediaPipeline } from '../../../src/video-summary/media-pipeline.mjs'
import {
  cleanupVideoSummaryTaskDirectory,
  createTaskOpfsStore,
} from '../../../src/video-summary/opfs.mjs'
import { createVideoTaskRunner } from '../../../src/video-summary/task-runner.mjs'
import { createFakePort } from '../../unit/helpers/port.mjs'

const owner = { tabId: 9, documentId: 'doc-9', platform: 'youtube', mediaId: 'abcdefghijk' }
const identity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }

function clock() {
  let id = 0
  return { now: () => 0, setTimeout: () => ++id, clearTimeout() {} }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = predicate()
    if (value) return value
    await nextTask()
  }
  assert.fail(message)
}

function createLinkedPorts() {
  const background = createFakePort({ name: 'video-summary-offscreen' })
  const offscreen = createFakePort({ name: 'video-summary-offscreen' })
  background.postMessage = (message) => {
    background.postedMessages.push(structuredClone(message))
    offscreen.emitMessage(structuredClone(message))
  }
  offscreen.postMessage = (message) => {
    offscreen.postedMessages.push(structuredClone(message))
    background.emitMessage(structuredClone(message))
  }
  return { background, offscreen }
}

function asrCommand() {
  return {
    type: 'START_TASK',
    requestId: 'start-asr',
    taskId: 'task-asr',
    pageIdentity: identity,
    sourceChoice: 'asr',
    sourceSnapshot: {
      pageIdentity: identity,
      title: 'Title',
      durationMs: 1_000,
      nativeSubtitleTracks: [],
      mediaCandidates: [
        {
          id: 'audio-1',
          mediaMetadata: { durationMs: 1_000, contentLength: 5 },
          remoteCandidate: {
            url: 'https://rr1---sn.example.googlevideo.com/audio',
            expiresAt: null,
          },
          localFetchRecipe: {
            primaryUrl: 'https://rr1---sn.example.googlevideo.com/audio',
            backupUrls: [],
            credentialMode: 'omit',
            requiredRequestOrigin: 'https://www.youtube.com/',
          },
        },
      ],
    },
    settingsSnapshot: { asrConfirmed: true },
    modelSnapshot: { modelName: 'customModel', apiMode: null },
  }
}

async function startAcceptedAsr({ coordinator, offscreen }) {
  await coordinator.handleContentCommand({
    context: { tabId: 9, documentId: 'doc-9', frameId: 0, owner, pageIdentity: identity },
    port: createFakePort({ name: 'video-summary' }),
    command: asrCommand(),
  })
  const attempt = offscreen.postedMessages.find(({ type }) => type === 'START_ATTEMPT')
  coordinator.handleOffscreenMessage({
    type: 'ATTEMPT_ACCEPTED',
    requestId: attempt.requestId,
    fence: attempt.fence,
  })
  return attempt.fence
}

test('exact-fence denial reaches no fake gateway operation', async () => {
  const offscreen = createFakePort({ name: 'video-summary-offscreen' })
  const gatewayCalls = []
  let rpc
  const coordinator = createVideoSummaryCoordinator({
    clock: clock(),
    ensureOffscreen: async () => {},
    sendOffscreen(command) {
      rpc.postCommand(command)
    },
    sendContent() {},
    resetOffscreen: async () => {},
  })
  rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async submitDirectAsr(args) {
        gatewayCalls.push(args)
        return { taskId: 'provider-task-1' }
      },
    },
    modelGateway: {},
    coordinator,
    logger: {},
  })
  rpc.attachPort(offscreen)
  await coordinator.handleContentCommand({
    context: { tabId: 9, documentId: 'doc-9', frameId: 0, owner, pageIdentity: identity },
    port: createFakePort({ name: 'video-summary' }),
    command: {
      type: 'START_TASK',
      requestId: 'start-native',
      taskId: 'task-native',
      pageIdentity: identity,
      sourceChoice: 'native-subtitle',
      subtitleTrackId: 'track-1',
      sourceSnapshot: {
        pageIdentity: identity,
        title: 'Title',
        durationMs: 1_000,
        nativeSubtitleTracks: [
          {
            id: 'track-1',
            language: 'en',
            label: 'English',
            sourceKind: 'author',
            cues: [{ startMs: 0, endMs: 1_000, text: 'hello' }],
          },
        ],
        mediaCandidates: [],
      },
      settingsSnapshot: { asrConfirmed: false },
      modelSnapshot: { modelName: 'customModel', apiMode: null },
    },
  })
  const attempt = offscreen.postedMessages[0]
  coordinator.handleOffscreenMessage({
    type: 'ATTEMPT_ACCEPTED',
    requestId: attempt.requestId,
    fence: attempt.fence,
  })
  offscreen.emitMessage({
    type: 'GATEWAY_REQUEST',
    requestId: 'gateway-denied',
    fence: attempt.fence,
    gateway: 'mediakit',
    operation: 'submitDirectAsr',
    args: { audioUrl: 'https://media.example/audio.m4a' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(gatewayCalls.length, 0)
  assert.equal(offscreen.postedMessages.at(-1).ok, false)
  assert.equal(
    offscreen.postedMessages.at(-1).error.code,
    'VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED',
  )
})

test('capability crosses runtime and RPC from direct documented failure to one fallback', async () => {
  const ports = createLinkedPorts()
  const calls = []
  let rpc
  const coordinator = createVideoSummaryCoordinator({
    clock: clock(),
    ensureOffscreen: async () => {},
    sendOffscreen(command) {
      rpc.postCommand(command)
    },
    sendContent() {},
    resetOffscreen: async () => {},
  })
  rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {
      async submitDirectAsr(args) {
        calls.push(['direct', args.audioUrl])
        return { taskId: 'provider-task-1' }
      },
      async requestUploadTarget() {
        calls.push(['target'])
        return {
          url: 'https://upload.example/audio',
          method: 'PUT',
          headers: {},
          fileReference: 'mediakit://file-1',
        }
      },
      async submitUploadedAsr(args) {
        calls.push(['fallback', args.audioUrl])
        return { taskId: 'provider-task-2' }
      },
    },
    modelGateway: {},
    coordinator,
    logger: {},
  })
  rpc.attachPort(ports.background)
  const runtime = startVideoSummaryOffscreenRuntime({
    port: ports.offscreen,
    taskRunner: {
      registerAttempt() {},
      authorizeAttempt: () => new Promise(() => {}),
      cancelGeneration() {},
      releaseAttempt() {},
      deleteTask() {},
    },
    logger: {},
    clock: clock(),
    cleanupTask: async () => {},
    createRequestId: (() => {
      let id = 0
      return () => `gateway-${++id}`
    })(),
  })
  const fence = await startAcceptedAsr({ coordinator, offscreen: ports.background })
  ports.offscreen.emitMessage({
    type: 'ATTEMPT_ACCEPTED',
    requestId: 'start-asr',
    fence,
  })

  await runtime.requestGateway({
    fence,
    gateway: 'mediakit',
    operation: 'submitDirectAsr',
    args: { audioUrl: asrCommand().sourceSnapshot.mediaCandidates[0].remoteCandidate.url },
  })
  await runtime.requestGateway({
    fence,
    gateway: 'mediakit',
    operation: 'markFallbackEligible',
    args: { providerTaskId: 'provider-task-1', providerCode: 'URL_DOWNLOAD_FAILED' },
  })
  const target = await runtime.requestGateway({
    fence,
    gateway: 'mediakit',
    operation: 'requestUploadTarget',
    args: {},
  })
  await runtime.requestGateway({
    fence,
    gateway: 'mediakit',
    operation: 'submitUploadedAsr',
    args: { uploadTarget: target, audioUrl: target.fileReference },
  })
  await assert.rejects(
    runtime.requestGateway({
      fence,
      gateway: 'mediakit',
      operation: 'submitUploadedAsr',
      args: { uploadTarget: target, audioUrl: target.fileReference },
    }),
    /VIDEO_SUMMARY_SUBMISSION_ALREADY_CONSUMED/,
  )
  assert.deepEqual(calls, [
    ['direct', 'https://rr1---sn.example.googlevideo.com/audio'],
    ['target'],
    ['fallback', 'mediakit://file-1'],
  ])
})

function createOpfsRoot() {
  const tasks = new Map()
  const tasksDirectory = {
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!tasks.has(name) && create) tasks.set(name, { chunks: [] })
      if (!tasks.has(name)) throw new DOMException('Missing', 'NotFoundError')
      const entry = tasks.get(name)
      return {
        async getFileHandle() {
          return {
            async createWritable() {
              return {
                async write(chunk) {
                  entry.chunks.push(chunk)
                },
                async close() {},
                async abort() {},
              }
            },
            async getFile() {
              return new Blob(entry.chunks)
            },
          }
        },
      }
    },
    async removeEntry(name) {
      if (!tasks.delete(name)) throw new DOMException('Missing', 'NotFoundError')
    },
    async *values() {
      for (const name of tasks.keys()) yield { name }
    },
  }
  return {
    tasks,
    root: {
      async getDirectoryHandle(name, { create = false } = {}) {
        if (name !== 'video-summary-tasks') throw new DOMException('Missing', 'NotFoundError')
        if (!create && tasks.size === 0) throw new DOMException('Missing', 'NotFoundError')
        return tasksDirectory
      },
    },
  }
}

function pipelineSnapshot() {
  return asrCommand().sourceSnapshot
}

function completedTranscription(text = 'done') {
  return {
    durationMs: 1_000,
    detectedLanguage: 'en',
    segments: [{ id: 's1', startMs: 0, endMs: 1_000, text }],
  }
}

test('manual redirect policy is enforced through OPFS download before body access', async () => {
  const { root } = createOpfsRoot()
  const requests = []
  let redirectBodyRead = false
  const redirect = new Response('', {
    status: 302,
    headers: { Location: '/redirected-audio' },
  })
  Object.defineProperty(redirect, 'body', {
    get() {
      redirectBodyRead = true
      throw new Error('redirect body read')
    },
  })
  const store = createTaskOpfsStore({
    rootDirectory: root,
    taskId: 'redirect-task',
    estimateStorage: async () => ({ quota: 1024 * 1024 * 1024, usage: 0 }),
    fetchImpl: async (url, init) => {
      requests.push([url, init])
      return requests.length === 1 ? redirect : new Response('audio')
    },
  })
  const result = await store.downloadCandidate({
    platform: 'youtube',
    candidate: pipelineSnapshot().mediaCandidates[0],
  })
  assert.equal(redirectBodyRead, false)
  assert.equal(await result.blob.text(), 'audio')
  assert.equal(requests.length, 2)
  assert.equal(
    requests.every(([, init]) => init.redirect === 'manual'),
    true,
  )
})

test('ambiguous submission performs no refresh, fallback, or second submit', async () => {
  const calls = { submit: 0, refresh: 0, target: 0, store: 0 }
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr() {
        calls.submit += 1
        throw new TypeError('connection lost')
      },
      async requestUploadTarget() {
        calls.target += 1
      },
    },
    opfsStoreFactory() {
      calls.store += 1
    },
    logger: {},
  })
  await assert.rejects(
    pipeline.transcribeFromSource({
      taskId: 'ambiguous-task',
      owner,
      sourceSnapshot: pipelineSnapshot(),
      settingsSnapshot: { asrConfirmed: true },
      requestSourceRefresh: async () => {
        calls.refresh += 1
      },
    }),
    /VIDEO_SUMMARY_SUBMISSION_UNKNOWN/,
  )
  assert.deepEqual(calls, { submit: 1, refresh: 0, target: 0, store: 0 })
})

test('sixteen cross-port requests remain pending and request seventeen is never posted', async () => {
  const ports = createLinkedPorts()
  let rpc
  const coordinator = createVideoSummaryCoordinator({
    clock: clock(),
    ensureOffscreen: async () => {},
    sendOffscreen(command) {
      rpc.postCommand(command)
    },
    sendContent() {},
    resetOffscreen: async () => {},
  })
  rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {
      generateText() {
        return new Promise(() => {})
      },
    },
    coordinator,
    logger: {},
  })
  rpc.attachPort(ports.background)
  const runtime = startVideoSummaryOffscreenRuntime({
    port: ports.offscreen,
    taskRunner: {
      registerAttempt() {},
      authorizeAttempt: () => new Promise(() => {}),
      cancelGeneration() {},
      releaseAttempt() {},
      deleteTask() {},
    },
    logger: {},
    clock: clock(),
    cleanupTask: async () => {},
    createRequestId: (() => {
      let id = 0
      return () => `pending-${++id}`
    })(),
  })
  const fence = await startAcceptedAsr({ coordinator, offscreen: ports.background })
  ports.offscreen.emitMessage({ type: 'ATTEMPT_ACCEPTED', requestId: 'start-asr', fence })
  const args = { taskId: fence.taskId, modelSnapshot: asrCommand().modelSnapshot, messages: [] }
  for (let index = 0; index < 16; index += 1) {
    void runtime.requestGateway({
      fence,
      gateway: 'model',
      operation: 'generateText',
      args,
    })
  }
  await assert.rejects(
    runtime.requestGateway({
      fence,
      gateway: 'model',
      operation: 'generateText',
      args,
    }),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
  assert.equal(
    ports.offscreen.postedMessages.filter(({ type }) => type === 'GATEWAY_REQUEST').length,
    16,
  )
})

test('real task cleanup removes OPFS after success, failure, cancellation, and delete', async (t) => {
  for (const terminal of ['success', 'failure', 'cancel', 'delete']) {
    await t.test(terminal, async () => {
      const { root, tasks } = createOpfsRoot()
      const taskId = `cleanup-${terminal}`
      const store = createTaskOpfsStore({
        rootDirectory: root,
        taskId,
        estimateStorage: async () => ({ quota: 1024 * 1024 * 1024, usage: 0 }),
        fetchImpl: async () => new Response('audio'),
      })
      await store.downloadCandidate({
        platform: 'youtube',
        candidate: pipelineSnapshot().mediaCandidates[0],
      })
      assert.equal(tasks.has(taskId), true)
      const cleanupTask = (key) => cleanupVideoSummaryTaskDirectory({ rootDirectory: root, ...key })
      if (terminal === 'delete') {
        const port = createFakePort({ name: 'video-summary-offscreen' })
        startVideoSummaryOffscreenRuntime({
          port,
          taskRunner: {
            registerAttempt() {},
            authorizeAttempt() {},
            cancelGeneration() {},
            releaseAttempt() {},
            deleteTask() {},
          },
          logger: {},
          cleanupTask,
        })
        port.emitMessage({ type: 'DELETE_TASK', owner, taskId, generation: 1 })
        await waitFor(() => !tasks.has(taskId), 'delete did not clean OPFS')
      } else {
        let release
        const held = new Promise((resolve) => {
          release = resolve
        })
        const runner = createVideoTaskRunner({
          mediaPipeline: {
            async transcribeFromSource({ signal }) {
              if (terminal === 'failure') throw new Error('TRANSCRIPTION_FAILED')
              if (terminal === 'cancel') {
                await held
                if (signal.aborted) throw signal.reason
              }
              return completedTranscription()
            },
          },
          modelGateway: {
            async describeCapabilities() {
              return { supported: false, reason: 'MODEL_UNAVAILABLE' }
            },
          },
          logger: {},
          cleanupTask,
        })
        const fence = { owner, taskId, generation: 1, attempt: 1 }
        runner.registerAttempt({
          requestId: `request-${terminal}`,
          fence,
          mode: 'initial',
          payload: {
            sourceChoice: 'asr',
            sourceSnapshot: pipelineSnapshot(),
            settingsSnapshot: {},
            modelSnapshot: {},
            requestSourceRefresh: async () => pipelineSnapshot(),
          },
          emit() {},
        })
        const execution = runner.authorizeAttempt({ requestId: `request-${terminal}`, fence })
        if (terminal === 'cancel') {
          runner.cancelGeneration({ owner, taskId, generation: 1 })
          release()
        }
        await execution.catch(() => {})
      }
      assert.equal(tasks.has(taskId), false)
    })
  }
})

function summaryMarkdown(segmentIds) {
  return `## Overview\nComplete summary\n## Key Content\n${segmentIds
    .map((id) => `- [segment:${id}] point ${id}`)
    .join('\n')}\n## Chapters\n- [segment:${segmentIds[0]}] Complete — Ordered summary`
}

function ledgerMarkdown(segmentIds) {
  const anchored = segmentIds.map((segmentId) => `- [segment:${segmentId}]`)
  return `## 主题与人物\n- speaker\n## 叙事与论证\n${anchored
    .map((value, index) => `${value} narrative ${index + 1}`)
    .join('\n')}\n## 事实与证据\n${anchored
    .map((value, index) => `${value} evidence ${index + 1}`)
    .join('\n')}\n## 章节候选\n${anchored
    .map((value, index) => `${value} chapter ${index + 1} — detail`)
    .join('\n')}\n## 待补信息\n- none\n## 覆盖位置\n${segmentIds.at(-1)}`
}

function integrationSummaryCommand(taskId, transcriptText) {
  return {
    type: 'START_TASK',
    requestId: `start-${taskId}`,
    taskId,
    pageIdentity: identity,
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity: identity,
      title: 'Title',
      durationMs: 12_000,
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          language: 'en',
          label: 'English',
          sourceKind: 'author',
          cues: Array.from({ length: 12 }, (_, index) => ({
            startMs: index * 1000,
            endMs: (index + 1) * 1000,
            text: `${transcriptText}-${index + 1}`,
          })),
        },
      ],
      mediaCandidates: [],
    },
    settingsSnapshot: {
      preferredLanguage: 'en',
      speakerIdentification: true,
      summaryMaxOutputTokens: 4000,
      asrConfirmed: false,
    },
    modelSnapshot: { modelName: 'customModel', apiMode: null },
  }
}

async function runSummaryIntegration({ taskId, transcriptText, generateText }) {
  const ports = createLinkedPorts()
  ports.content = createFakePort({
    name: 'video-summary',
    sender: {
      id: 'extension-id',
      tab: { id: 9 },
      documentId: 'doc-9',
      frameId: 0,
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
  })
  const requests = []
  const logs = []
  const logger = Object.fromEntries(
    ['info', 'warn', 'error'].map((level) => [level, (entry) => logs.push([level, entry])]),
  )
  let rpc
  const coordinator = createVideoSummaryCoordinator({
    clock: clock(),
    ensureOffscreen: async () => {},
    sendOffscreen(command) {
      rpc.postCommand(command)
    },
    sendContent(port, message) {
      port.postMessage(message)
    },
    resetOffscreen: async () => {},
  })
  const modelGateway = {
    async describeCapabilities() {
      return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
    },
    async generateText(args) {
      requests.push(structuredClone(args))
      return generateText(args)
    },
  }
  rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway,
    coordinator,
    logger,
  })
  rpc.attachPort(ports.background)
  startVideoSummaryOffscreenRuntime({
    port: ports.offscreen,
    mediaPipeline: {
      async transcribeFromSource({ sourceSnapshot }) {
        return {
          durationMs: sourceSnapshot.durationMs,
          detectedLanguage: 'en',
          segments: sourceSnapshot.nativeSubtitleTracks[0].cues.map((cue, index) => ({
            id: `s${index + 1}`,
            ...cue,
          })),
        }
      },
    },
    logger,
    clock: clock(),
  })
  const router = createVideoSummaryRouter({
    runtime: { id: 'extension-id' },
    coordinator,
    logger,
  })
  router.handleConnect(ports.content)
  ports.content.emitMessage(integrationSummaryCommand(taskId, transcriptText))
  let terminalMessage
  for (let attempt = 0; attempt < 50 && !terminalMessage; attempt += 1) {
    terminalMessage = ports.content.postedMessages.find(
      ({ type, event }) =>
        type === 'TASK_EVENT' &&
        (event?.type === 'TASK_COMPLETED' || event?.type === 'TASK_FAILED'),
    )
    if (!terminalMessage) await nextTask()
  }
  assert.ok(
    terminalMessage,
    JSON.stringify({
      contentTypes: ports.content.postedMessages.map(({ type, event }) => [type, event?.type]),
      requestIds: requests.map(({ requestId }) => requestId),
      backgroundTypes: ports.background.postedMessages.map(({ type, error }) => [
        type,
        error?.code,
      ]),
      offscreenTypes: ports.offscreen.postedMessages.map(({ type, operation, event }) => [
        type,
        operation || event?.type,
      ]),
    }),
  )
  return { terminal: terminalMessage.event, requests, logs, ports }
}

test('direct overflow reaches content through sequential ledger synthesis with safe diagnostics', async () => {
  const transcriptSecret = 'SECRET_TRANSCRIPT_CONTENT'
  const ledgerSecret = 'SECRET_LEDGER_CONTENT'
  const responseSecret = 'SECRET_MODEL_RESPONSE'
  const credentialSecret = 'SECRET_PROVIDER_CREDENTIAL'
  const ledgerSegmentIds = []
  const fixture = await runSummaryIntegration({
    taskId: 'rolling-integration',
    transcriptText: transcriptSecret,
    generateText: async (args) => {
      if (args.requestId === 'direct-synthesis') {
        throw Object.assign(new Error(responseSecret), {
          code: 'MODEL_CONTEXT_WINDOW_EXCEEDED',
          transcript: transcriptSecret,
          ledger: ledgerSecret,
          response: responseSecret,
          secret: credentialSecret,
        })
      }
      if (args.requestId === 'ledger-synthesis') {
        const ledger = JSON.parse(args.messages[1].content).ledger
        const firstSegmentId = ledger.narrative[0].segmentId
        return {
          text: summaryMarkdown([firstSegmentId, ledger.coveredThroughSegmentId]),
          finishReason: 'stop',
        }
      }
      const { range } = JSON.parse(args.messages[1].content)
      const segmentId = `native-${range.endIndex}`
      ledgerSegmentIds.push(segmentId)
      return { text: ledgerMarkdown(ledgerSegmentIds), finishReason: 'stop' }
    },
  })

  assert.equal(
    fixture.terminal.type,
    'TASK_COMPLETED',
    JSON.stringify({
      terminal: fixture.terminal,
      requestIds: fixture.requests.map(({ requestId }) => requestId),
    }),
  )
  assert.equal(fixture.terminal.result.coverage.ratio, 1)
  assert.deepEqual(
    fixture.terminal.result.keyMoments.map(({ segmentId }) => segmentId),
    [ledgerSegmentIds[0], ledgerSegmentIds.at(-1)],
  )
  assert.deepEqual(
    fixture.requests.map(({ requestId }) => requestId),
    ['direct-synthesis', 'ledger-1', 'ledger-4', 'ledger-7', 'ledger-10', 'ledger-synthesis'],
  )
  const serializedDiagnostics = JSON.stringify({
    logs: fixture.logs,
    errors: fixture.ports.background.postedMessages
      .filter(({ type, ok }) => type === 'GATEWAY_RESPONSE' && ok === false)
      .map(({ error }) => error),
  })
  for (const secret of [transcriptSecret, ledgerSecret, responseSecret, credentialSecret]) {
    assert.equal(serializedDiagnostics.includes(secret), false)
  }
})

test('login failure reaches content unchanged without ledger fallback or sensitive serialization', async () => {
  const transcriptSecret = 'SECRET_LOGIN_TRANSCRIPT'
  const ledgerSecret = 'SECRET_LOGIN_LEDGER'
  const responseSecret = 'SECRET_LOGIN_RESPONSE'
  const credentialSecret = 'SECRET_LOGIN_CREDENTIAL'
  const fixture = await runSummaryIntegration({
    taskId: 'login-integration',
    transcriptText: transcriptSecret,
    generateText: async () => {
      throw Object.assign(new Error(responseSecret), {
        code: 'MODEL_LOGIN_REQUIRED',
        transcript: transcriptSecret,
        ledger: ledgerSecret,
        response: responseSecret,
        secret: credentialSecret,
      })
    },
  })

  assert.equal(fixture.terminal.type, 'TASK_FAILED')
  assert.equal(fixture.terminal.errorCode, 'MODEL_LOGIN_REQUIRED')
  assert.deepEqual(
    fixture.requests.map(({ requestId }) => requestId),
    ['direct-synthesis'],
  )
  const serializedDiagnostics = JSON.stringify({
    logs: fixture.logs,
    errors: fixture.ports.background.postedMessages
      .filter(({ type, ok }) => type === 'GATEWAY_RESPONSE' && ok === false)
      .map(({ error }) => error),
  })
  for (const secret of [transcriptSecret, ledgerSecret, responseSecret, credentialSecret]) {
    assert.equal(serializedDiagnostics.includes(secret), false)
  }
})

test('page navigation invalidates the old fence and retains one live handle', async () => {
  let pageIdentity = identity
  let notify
  const mounts = []
  const mountEnhanced = async ({ isCurrentPage, ...options }) => {
    const handle = {
      ...options,
      isCurrentPage,
      disposed: false,
      dispose() {
        this.disposed = true
      },
      isConnected() {
        return !this.disposed
      },
    }
    mounts.push(handle)
    return handle
  }
  const controller = createVideoSummaryAdapterController({
    getPageIdentity: () => pageIdentity,
    resolveMode: () => 'enhanced',
    mountEnhanced,
    mountLegacy: async () => assert.fail('legacy mount'),
    subscribeToPageChanges(listener) {
      notify = listener
      return () => {}
    },
    findTargetElement: () => ({ id: pageIdentity.mediaId }),
    waitForTargetElement: async () => null,
    setIntervalFn: () => 1,
    clearIntervalFn() {},
  })
  await controller.start()
  const oldHandle = mounts[0]
  pageIdentity = { platform: 'youtube', videoId: 'newvideo001', mediaId: 'newvideo001' }
  notify()
  await waitFor(() => mounts.length === 2, 'new page did not mount')
  assert.equal(oldHandle.isCurrentPage(), false)
  assert.equal(oldHandle.disposed, true)
  assert.equal(mounts.filter(({ disposed }) => !disposed).length, 1)
  controller.dispose()
})
