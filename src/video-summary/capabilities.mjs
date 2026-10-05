/* global __ENABLE_VIDEO_SUMMARY__ */

export function isVideoSummaryBuildEnabled() {
  return typeof __ENABLE_VIDEO_SUMMARY__ !== 'undefined' && __ENABLE_VIDEO_SUMMARY__ === true
}

export function isVideoSummaryRuntimeSupported({
  manifestVersion,
  hasOffscreenApi,
  minChromeVersion,
  userAgent,
}) {
  return (
    manifestVersion === 3 &&
    hasOffscreenApi === true &&
    Number.parseInt(String(minChromeVersion || '0'), 10) >= 116 &&
    /Chrome|Edg\//.test(String(userAgent || ''))
  )
}

export function isVideoSummaryEnabled(config) {
  return isVideoSummaryBuildEnabled() && config?.videoTranscriptionEnabled === true
}

export const isBilibiliVideoTranscriptionEnabled = isVideoSummaryEnabled
