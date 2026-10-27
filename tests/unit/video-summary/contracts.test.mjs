import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfig } from '../../../src/config/index.mjs'
import {
  VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS,
  VIDEO_SUMMARY_OFFSCREEN_PATH,
  VIDEO_SUMMARY_OFFSCREEN_PORT_NAME,
  VIDEO_SUMMARY_PLATFORMS,
  VIDEO_SUMMARY_PORT_NAME,
  VIDEO_SUMMARY_STORAGE_KEY,
  assertVideoSummaryPlatform,
} from '../../../src/video-summary/contracts.mjs'

test('video-summary contracts contain only stable configuration constants', () => {
  assert.deepEqual(VIDEO_SUMMARY_PLATFORMS, ['bilibili', 'youtube'])
  assert.equal(assertVideoSummaryPlatform('youtube'), 'youtube')
  assert.throws(() => assertVideoSummaryPlatform(), /VIDEO_SUMMARY_PLATFORM_INVALID/)
  assert.throws(() => assertVideoSummaryPlatform('vimeo'), /VIDEO_SUMMARY_PLATFORM_INVALID/)
  assert.equal(VIDEO_SUMMARY_PORT_NAME, 'video-summary')
  assert.equal(VIDEO_SUMMARY_OFFSCREEN_PATH, 'VideoSummaryOffscreen.html')
  assert.equal(VIDEO_SUMMARY_OFFSCREEN_PORT_NAME, 'video-summary-offscreen')
  assert.equal(VIDEO_SUMMARY_STORAGE_KEY, 'mediaKitApiKey')
  assert.deepEqual(VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS, {
    mediakit: [
      'submitDirectAsr',
      'markFallbackEligible',
      'requestUploadTarget',
      'submitUploadedAsr',
      'queryTask',
    ],
    model: ['describeCapabilities', 'generateText'],
  })
})

test('feature config is explicit while the MediaKit key stays outside defaultConfig', () => {
  assert.equal(defaultConfig.videoTranscriptionEnabled, false)
  assert.equal(defaultConfig.bilibiliSpeakerIdentificationEnabled, true)
  assert.equal(defaultConfig.bilibiliSummaryMaxOutputTokens, 20_000)
  assert.equal('mediaKitApiKey' in defaultConfig, false)
})
