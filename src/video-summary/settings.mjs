export const DEFAULT_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS = 20_000
export const MIN_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS = 1_000
export const MAX_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS = 40_000

export function normalizeVideoSummaryMaxOutputTokens(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS
  return Math.min(
    MAX_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS,
    Math.max(MIN_VIDEO_SUMMARY_MAX_OUTPUT_TOKENS, parsed),
  )
}

export function createVideoSummarySettingsSnapshot({ userConfig, preferredLanguage }) {
  return {
    preferredLanguage,
    speakerIdentification: userConfig?.bilibiliSpeakerIdentificationEnabled !== false,
    summaryMaxOutputTokens: normalizeVideoSummaryMaxOutputTokens(
      userConfig?.bilibiliSummaryMaxOutputTokens,
    ),
  }
}
