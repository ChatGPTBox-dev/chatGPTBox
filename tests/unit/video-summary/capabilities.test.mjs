import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultConfig } from '../../../src/config/index.mjs'

globalThis.__ENABLE_VIDEO_SUMMARY__ = true
const { isVideoSummaryAvailable, isVideoSummaryRuntimeSupported } = await import(
  '../../../src/video-summary/capabilities.mjs'
)

const supportedRuntime = {
  manifestVersion: 3,
  hasOffscreenPermission: true,
  minChromeVersion: '116',
  userAgent: 'Chrome/116.0.0.0',
}

test('runtime support requires every Chromium MV3 offscreen capability', () => {
  const cases = [
    ['Chrome 116+', supportedRuntime, true],
    ['Edge 116+', { ...supportedRuntime, userAgent: 'Edg/116.0.0.0' }, true],
    ['MV2', { ...supportedRuntime, manifestVersion: 2 }, false],
    ['absent permission', { ...supportedRuntime, hasOffscreenPermission: false }, false],
    ['Chrome 115', { ...supportedRuntime, minChromeVersion: '115' }, false],
    ['Firefox', { ...supportedRuntime, userAgent: 'Firefox/130.0' }, false],
    ['Safari', { ...supportedRuntime, userAgent: 'Version/18.0 Safari/605.1.15' }, false],
    ['malformed facts', { manifestVersion: 3 }, false],
    ['missing facts', undefined, false],
  ]

  for (const [name, facts, expected] of cases) {
    assert.equal(isVideoSummaryRuntimeSupported(facts), expected, name)
  }
})

test('shared capability gate requires build, setting, and runtime support', () => {
  assert.equal(defaultConfig.videoTranscriptionEnabled, false)
  assert.equal(isVideoSummaryAvailable({ videoTranscriptionEnabled: true }, supportedRuntime), true)
  assert.equal(
    isVideoSummaryAvailable({ videoTranscriptionEnabled: false }, supportedRuntime),
    false,
  )
  assert.equal(
    isVideoSummaryAvailable({ bilibiliVideoTranscriptionEnabled: true }, supportedRuntime),
    false,
  )
  assert.equal(isVideoSummaryAvailable(undefined, supportedRuntime), false)

  globalThis.__ENABLE_VIDEO_SUMMARY__ = false
  try {
    assert.equal(
      isVideoSummaryAvailable({ videoTranscriptionEnabled: true }, supportedRuntime),
      false,
    )
  } finally {
    globalThis.__ENABLE_VIDEO_SUMMARY__ = true
  }
})
