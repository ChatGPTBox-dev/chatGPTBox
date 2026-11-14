import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePageMode } from '../../../src/content-script/video-summary-page-mode.mjs'

const youtubeIdentity = {
  platform: 'youtube',
  videoId: 'SYNTHVID01A',
  mediaId: 'SYNTHVID01A',
}

test('enhanced mode requires an eligible identity, capability, and active adapter', () => {
  assert.equal(
    resolvePageMode({
      config: { activeSiteAdapters: ['youtube'] },
      capabilities: { enhanced: true },
      pageIdentity: youtubeIdentity,
      pageState: { enhancedSupported: true, legacySupported: true },
    }),
    'enhanced',
  )
  assert.equal(
    resolvePageMode({
      config: { activeSiteAdapters: [] },
      capabilities: { enhanced: true },
      pageIdentity: youtubeIdentity,
      pageState: { enhancedSupported: true, legacySupported: true },
    }),
    'legacy',
  )
})

test('legacy and none preserve site eligibility when enhanced mode is unavailable', () => {
  assert.equal(
    resolvePageMode({
      config: {},
      capabilities: { enhanced: false },
      pageIdentity: youtubeIdentity,
      pageState: { enhancedSupported: true, legacySupported: true },
    }),
    'legacy',
  )
  assert.equal(
    resolvePageMode({
      config: {},
      capabilities: { enhanced: true },
      pageIdentity: null,
      pageState: { enhancedSupported: false, legacySupported: false },
    }),
    'none',
  )
})

test('rejects unknown page modes instead of silently mounting a second owner', () => {
  assert.throws(
    () =>
      resolvePageMode({
        config: {},
        capabilities: { enhanced: true },
        pageIdentity: youtubeIdentity,
        pageState: { enhancedSupported: true, legacySupported: 'yes' },
      }),
    /VIDEO_SUMMARY_PAGE_STATE_INVALID/,
  )
})
