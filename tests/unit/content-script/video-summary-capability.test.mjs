import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.__ENABLE_VIDEO_SUMMARY__ = true
const { isEnhancedVideoSummaryAvailable } = await import(
  '../../../src/content-script/video-summary-capability.mjs'
)

const supportedManifest = {
  manifest_version: 3,
  minimum_chrome_version: '116',
  permissions: ['offscreen'],
}

function createDependencies({ manifest = supportedManifest, userAgent = 'Chrome/116.0.0.0' } = {}) {
  return {
    Browser: {
      runtime: {
        getManifest: () => manifest,
      },
    },
    navigator: { userAgent },
  }
}

test('content-script capability maps manifest permissions and user agent into the shared gate', () => {
  assert.equal(
    isEnhancedVideoSummaryAvailable({ videoTranscriptionEnabled: true }, createDependencies()),
    true,
  )
  assert.equal(
    isEnhancedVideoSummaryAvailable(
      { videoTranscriptionEnabled: true },
      createDependencies({ manifest: { ...supportedManifest, permissions: [] } }),
    ),
    false,
  )
  assert.equal(
    isEnhancedVideoSummaryAvailable(
      { videoTranscriptionEnabled: true },
      createDependencies({ userAgent: 'Firefox/130.0' }),
    ),
    false,
  )
})

test('content-script capability returns false when manifest access fails', () => {
  const dependencies = createDependencies()
  dependencies.Browser.runtime.getManifest = () => {
    throw new Error('manifest unavailable')
  }

  assert.equal(
    isEnhancedVideoSummaryAvailable({ videoTranscriptionEnabled: true }, dependencies),
    false,
  )
})
