import assert from 'node:assert/strict'
import test from 'node:test'

import { createVideoSummaryCoordinator } from '../../../src/background/video-summary-coordinator.mjs'
import { createVideoSummaryOffscreenRpc } from '../../../src/background/video-summary-offscreen-rpc.mjs'
import { createFakePort } from '../../unit/helpers/port.mjs'
import './protocol-lifecycle.test.mjs'

const owner = { tabId: 9, documentId: 'doc-9', platform: 'youtube', mediaId: 'abcdefghijk' }
const identity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }

function clock() {
  let id = 0
  return { now: () => 0, setTimeout: () => ++id, clearTimeout() {} }
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
