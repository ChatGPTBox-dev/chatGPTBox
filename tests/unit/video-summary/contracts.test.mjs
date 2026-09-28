import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfig } from '../../../src/config/index.mjs'
import {
  VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS,
  VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES,
  VIDEO_SUMMARY_OFFSCREEN_PATH,
  VIDEO_SUMMARY_OFFSCREEN_PORT_NAME,
  VIDEO_SUMMARY_PORT_NAME,
  VIDEO_SUMMARY_STORAGE_KEY,
  createVideoSummaryOwner,
} from '../../../src/video-summary/contracts.mjs'

test('video-summary contracts stay structured-clone-safe', () => {
  const owner = createVideoSummaryOwner({ tabId: 12, documentId: 'doc-1', videoId: 'BV1test' })
  assert.equal(VIDEO_SUMMARY_PORT_NAME, 'bilibili-video-summary')
  assert.equal(VIDEO_SUMMARY_OFFSCREEN_PATH, 'VideoSummaryOffscreen.html')
  assert.equal(VIDEO_SUMMARY_OFFSCREEN_PORT_NAME, 'bilibili-video-summary-offscreen')
  assert.equal(VIDEO_SUMMARY_STORAGE_KEY, 'mediaKitApiKey')
  assert.deepEqual(VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES, {
    taskEvent: 'TASK_EVENT',
    sourceRefreshRequest: 'SOURCE_REFRESH_REQUEST',
    gatewayRequest: 'GATEWAY_REQUEST',
    gatewayResponse: 'GATEWAY_RESPONSE',
  })
  assert.deepEqual(VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS, {
    mediakit: ['submitDirectAsr', 'requestUploadTarget', 'queryTask'],
    model: ['describeCapabilities', 'invokeTool', 'cancel'],
  })
  assert.doesNotThrow(() => structuredClone(owner))
})

test('feature config is explicit while the MediaKit key stays outside defaultConfig', () => {
  assert.equal(defaultConfig.bilibiliVideoTranscriptionEnabled, false)
  assert.equal(defaultConfig.bilibiliSpeakerIdentificationEnabled, true)
  assert.equal(defaultConfig.bilibiliSummaryMaxOutputTokens, 20_000)
  assert.equal('mediaKitApiKey' in defaultConfig, false)
})
