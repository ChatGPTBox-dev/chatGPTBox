/* global __ENABLE_BILIBILI_VIDEO_TRANSCRIPTION__ */

export function isVideoSummaryBuildEnabled() {
  return typeof __ENABLE_BILIBILI_VIDEO_TRANSCRIPTION__ !== 'undefined'
    ? __ENABLE_BILIBILI_VIDEO_TRANSCRIPTION__ === true
    : false
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

export function isBilibiliVideoTranscriptionEnabled(config) {
  return isVideoSummaryBuildEnabled() && config?.bilibiliVideoTranscriptionEnabled === true
}
