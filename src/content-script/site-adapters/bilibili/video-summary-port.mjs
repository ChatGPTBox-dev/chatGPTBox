import { VIDEO_SUMMARY_PORT_NAME } from '../../../video-summary/contracts.mjs'

function cloneSerializable(value) {
  return structuredClone(value)
}

function normalizeTaskId(taskId) {
  return typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null
}

function normalizeOwnerValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createVideoSummaryPortClient({
  videoId,
  pageBridge,
  connect,
  onEvent = () => {},
  onDisconnect = () => {},
}) {
  const resolvedConnect =
    typeof connect === 'function'
      ? connect
      : () => {
          throw new Error('VIDEO_SUMMARY_CONNECT_REQUIRED')
        }
  const port = resolvedConnect({ name: VIDEO_SUMMARY_PORT_NAME })
  const portDocumentId = normalizeOwnerValue(port?.sender?.documentId)
  let activeTaskId = null
  let disposed = false

  const isCurrentOwnerEvent = (message) => {
    if (!message || typeof message !== 'object') return false
    if (normalizeTaskId(message.taskId) !== activeTaskId) return false
    if (normalizeOwnerValue(message?.owner?.videoId) !== videoId) return false
    if (portDocumentId && normalizeOwnerValue(message?.owner?.documentId) !== portDocumentId) {
      return false
    }
    return true
  }

  const handleSourceRefreshRequest = async (message) => {
    if (!isCurrentOwnerEvent(message)) return

    try {
      const sourceSnapshot = await pageBridge.refreshSnapshot({
        expectedVideoId: videoId,
      })
      port.postMessage(
        cloneSerializable({
          type: 'SOURCE_REFRESH_RESULT',
          taskId: activeTaskId,
          videoId,
          sourceSnapshot,
        }),
      )
    } catch (error) {
      port.postMessage(
        cloneSerializable({
          type: 'SOURCE_REFRESH_RESULT',
          taskId: activeTaskId,
          videoId,
          errorCode: error?.message || 'BILIBILI_SOURCE_REFRESH_FAILED',
        }),
      )
    }
  }

  const handleMessage = (message) => {
    if (disposed || !message || typeof message !== 'object') return
    if (message.type === 'REQUEST_SOURCE_REFRESH') {
      void handleSourceRefreshRequest(message)
      return
    }
    if (!isCurrentOwnerEvent(message)) return
    onEvent(cloneSerializable(message))
  }

  const handleDisconnect = () => {
    if (disposed) return
    onDisconnect()
  }

  port.onMessage.addListener(handleMessage)
  port.onDisconnect.addListener(handleDisconnect)

  return {
    async startTask({ sourceChoice, sourceSnapshot, settingsSnapshot, modelSnapshot }) {
      const taskId = crypto.randomUUID()
      activeTaskId = taskId
      port.postMessage(
        cloneSerializable({
          type: 'START_TASK',
          taskId,
          videoId,
          sourceChoice,
          sourceSnapshot,
          settingsSnapshot,
          ...(modelSnapshot === undefined ? {} : { modelSnapshot }),
        }),
      )
      return taskId
    },

    async attachTask({ taskId }) {
      activeTaskId = normalizeTaskId(taskId)
      if (!activeTaskId) return null
      port.postMessage(
        cloneSerializable({
          type: 'ATTACH_TASK',
          taskId: activeTaskId,
          videoId,
        }),
      )
      return activeTaskId
    },

    async cancelTask() {
      if (!activeTaskId) return
      port.postMessage(
        cloneSerializable({
          type: 'CANCEL_TASK',
          taskId: activeTaskId,
          videoId,
        }),
      )
      activeTaskId = null
    },

    async retryTask({ fromStage, modelSnapshot }) {
      if (!activeTaskId) return
      port.postMessage(
        cloneSerializable({
          type: 'RETRY_TASK',
          taskId: activeTaskId,
          videoId,
          fromStage,
          ...(modelSnapshot === undefined ? {} : { modelSnapshot }),
        }),
      )
    },

    getTaskId() {
      return activeTaskId
    },

    getDocumentId() {
      return portDocumentId
    },

    dispose() {
      if (disposed) return
      disposed = true
      port.onMessage.removeListener(handleMessage)
      port.onDisconnect.removeListener(handleDisconnect)
      port.disconnect()
    },
  }
}
