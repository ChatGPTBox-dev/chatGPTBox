export const VIDEO_SUMMARY_PORT_NAME = 'bilibili-video-summary'
export const VIDEO_SUMMARY_OFFSCREEN_PORT_NAME = 'bilibili-video-summary-offscreen'
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
  model: Object.freeze(['describeCapabilities', 'generateText', 'invokeTool', 'cancel']),
})

export function createVideoSummaryOwner({ tabId, documentId, videoId }) {
  return { tabId, documentId, videoId }
}
