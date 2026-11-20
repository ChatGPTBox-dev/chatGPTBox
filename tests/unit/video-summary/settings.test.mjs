import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS,
  MAX_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS,
  MIN_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS,
  createVideoSummarySettingsSnapshot,
  normalizeVideoSummaryMaxOutputTokens,
} from '../../../src/video-summary/settings.mjs'

test('video summary output-token setting defaults to 20000 and clamps to the supported range', () => {
  assert.equal(DEFAULT_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS, 20_000)
  assert.equal(MIN_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS, 1_000)
  assert.equal(MAX_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS, 40_000)
  assert.equal(normalizeVideoSummaryMaxOutputTokens(undefined), 20_000)
  assert.equal(normalizeVideoSummaryMaxOutputTokens('invalid'), 20_000)
  assert.equal(normalizeVideoSummaryMaxOutputTokens(999), 1_000)
  assert.equal(normalizeVideoSummaryMaxOutputTokens('20000'), 20_000)
  assert.equal(normalizeVideoSummaryMaxOutputTokens(40_001), 40_000)
})

test('task settings snapshot freezes the summary token budget without changing other settings', () => {
  assert.deepEqual(
    createVideoSummarySettingsSnapshot({
      userConfig: {
        bilibiliSpeakerIdentificationEnabled: false,
        bilibiliSummaryMaxOutputTokens: 25_000,
      },
      preferredLanguage: 'zh-Hans',
    }),
    {
      preferredLanguage: 'zh-Hans',
      speakerIdentification: false,
      summaryMaxOutputTokens: 25_000,
    },
  )
})
