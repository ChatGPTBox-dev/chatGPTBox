import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfig } from '../../../src/config/index.mjs'
import {
  isBilibiliVideoTranscriptionEnabled,
  isVideoSummaryRuntimeSupported,
} from '../../../src/video-summary/capabilities.mjs'

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

test('isBilibiliVideoTranscriptionEnabled respects build gate and config', () => {
  assert.equal(isBilibiliVideoTranscriptionEnabled(defaultConfig), false)
})
