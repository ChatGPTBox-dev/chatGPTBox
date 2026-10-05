import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfig } from '../../../src/config/index.mjs'

globalThis.__ENABLE_VIDEO_SUMMARY__ = true
const { isVideoSummaryEnabled, isVideoSummaryRuntimeSupported } = await import(
  '../../../src/video-summary/capabilities.mjs'
)

test('runtime support is Chromium-full-build-only', () => {
  assert.equal(
    isVideoSummaryRuntimeSupported({
      manifestVersion: 3,
      hasOffscreenApi: true,
      minChromeVersion: '116',
      userAgent: 'Chrome/130.0.0.0',
    }),
    true,
  )
  assert.equal(
    isVideoSummaryRuntimeSupported({
      manifestVersion: 2,
      hasOffscreenApi: false,
      minChromeVersion: '',
      userAgent: 'Firefox/130.0',
    }),
    false,
  )
})

test('generic capability gate requires the canonical switch', () => {
  assert.equal(defaultConfig.videoTranscriptionEnabled, false)
  assert.equal(isVideoSummaryEnabled({ videoTranscriptionEnabled: true }), true)
  assert.equal(isVideoSummaryEnabled({ videoTranscriptionEnabled: false }), false)
  assert.equal(isVideoSummaryEnabled({ bilibiliVideoTranscriptionEnabled: true }), false)
  assert.equal(isVideoSummaryEnabled(), false)
})
