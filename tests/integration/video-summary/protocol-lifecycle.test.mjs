import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryCoordinator } from '../../../src/background/video-summary-coordinator.mjs'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
import { createVideoSummaryRouter } from '../../../src/background/video-summary-router.mjs'
import { startVideoSummaryOffscreenRuntime } from '../../../src/pages/VideoSummaryOffscreen/runtime.mjs'
import { createFakePort } from '../../unit/helpers/port.mjs'

const identity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }

function createClock() {
  let id = 0
  return { now: () => 0, setTimeout: () => ++id, clearTimeout() {} }
}

function createLinkedPorts() {
  const content = createFakePort({
    name: 'video-summary',
    sender: {
      id: 'extension-id',
      tab: { id: 7 },
      documentId: 'doc-7',
      frameId: 0,
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    },
  })
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
  return { content, background, offscreen }
}

function startCommand() {
  return {
    type: 'START_TASK',
    requestId: 'start-1',
    taskId: 'task-1',
    pageIdentity: identity,
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity: identity,
      title: 'Title',
      durationMs: 1000,
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          language: 'en',
          label: 'English',
          sourceKind: 'author',
          cues: [{ startMs: 0, endMs: 1000, text: 'hello' }],
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

test('production transports preserve START_ATTEMPT to ACCEPTED to AUTHORIZED FIFO', async () => {
  const ports = createLinkedPorts()
  const order = []
  const runner = {
    registerAttempt(value) {
      this.registered = value
      order.push('register')
    },
    async authorizeAttempt() {
      order.push('authorize')
      this.registered.emit({
        type: 'TASK_RESULT',
        checkpointAvailable: true,
        result: { summary: 'ok' },
      })
    },
    cancelGeneration() {},
    releaseAttempt() {
      order.push('release')
    },
    deleteTask() {},
  }
  let rpc
  const coordinator = createVideoSummaryCoordinator({
    clock: createClock(),
    ensureOffscreen: async () => {},
    sendOffscreen(command) {
      order.push(command.type)
      rpc.postCommand(command)
    },
    sendContent(port, message) {
      port.postMessage(message)
    },
    resetOffscreen: async () => {},
  })
  rpc = createVideoSummaryOffscreenRpc({
    mediaKitGateway: {},
    modelGateway: {},
    coordinator,
    logger: {},
  })
  rpc.attachPort(ports.background)
  startVideoSummaryOffscreenRuntime({
    port: ports.offscreen,
    taskRunner: runner,
    logger: {},
    clock: createClock(),
  })
  const router = createVideoSummaryRouter({
    runtime: { id: 'extension-id' },
    coordinator,
    logger: {},
  })
  router.handleConnect(ports.content)
  ports.content.emitMessage(startCommand())
  for (let attempt = 0; attempt < 20 && order.length < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.deepEqual(order.slice(0, 5), [
    'START_ATTEMPT',
    'register',
    'ATTEMPT_AUTHORIZED',
    'authorize',
    'release',
  ])
  assert.equal(
    ports.content.postedMessages.filter((message) => message.type === 'START_ACK').length,
    1,
  )
  assert.equal(coordinator.debugState().activeSlots.length, 0)
  assert.equal(coordinator.debugState().retainedTasks[0].replayEvent.type, 'TASK_COMPLETED')
})
