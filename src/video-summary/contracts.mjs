export const VIDEO_SUMMARY_PORT_NAME = 'video-summary'
export const VIDEO_SUMMARY_OFFSCREEN_PORT_NAME = 'video-summary-offscreen'
export const VIDEO_SUMMARY_PLATFORMS = Object.freeze(['bilibili', 'youtube'])
export const VIDEO_SUMMARY_OFFSCREEN_PATH = 'VideoSummaryOffscreen.html'
export const VIDEO_SUMMARY_STORAGE_KEY = 'mediaKitApiKey'
export const VIDEO_SUMMARY_OFFSCREEN_COMMAND_TYPES = Object.freeze([
  'START_TASK',
  'ATTACH_TASK',
  'CANCEL_TASK',
  'RETRY_TASK',
  'SOURCE_REFRESH_RESULT',
])
export const VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES = Object.freeze({
  taskEvent: 'TASK_EVENT',
  sourceRefreshRequest: 'SOURCE_REFRESH_REQUEST',
  gatewayRequest: 'GATEWAY_REQUEST',
  gatewayResponse: 'GATEWAY_RESPONSE',
})
export const VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS = Object.freeze({
  mediakit: Object.freeze(['submitDirectAsr', 'requestUploadTarget', 'queryTask']),
  model: Object.freeze(['describeCapabilities', 'generateText', 'cancel']),
})

export function assertVideoSummaryPlatform(platform) {
  if (!VIDEO_SUMMARY_PLATFORMS.includes(platform)) {
    throw new Error('VIDEO_SUMMARY_PLATFORM_INVALID')
  }
  return platform
}

export function createVideoSummaryOwner({ tabId, documentId, platform, videoId }) {
  return { tabId, documentId, platform: assertVideoSummaryPlatform(platform), videoId }
}
