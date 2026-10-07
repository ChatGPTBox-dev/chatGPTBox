import { VIDEO_SUMMARY_PORT_NAME } from '../video-summary/contracts.mjs'
import {
  fencesEqual,
  pageIdentitiesEqual,
  parseContentMessage,
  parsePageIdentity,
} from '../video-summary/protocol.mjs'

function createDisconnectError() {
  return new Error('VIDEO_SUMMARY_PORT_DISCONNECTED')
}

function defaultCreateId() {
  return crypto.randomUUID()
}

export function createVideoSummaryPortClient({
  pageIdentity,
  pageGeneration,
  pageBridge,
  connect,
  createTaskId = defaultCreateId,
  createRequestId = defaultCreateId,
  onEvent = () => {},
  onDisconnect = () => {},
}) {
  const identity = parsePageIdentity(pageIdentity)
  const port = connect({ name: VIDEO_SUMMARY_PORT_NAME })
  const pending = new Map()
  let activeFence = null
  let disposed = false

  function post(message) {
    if (disposed) throw createDisconnectError()
    port.postMessage(structuredClone(message))
  }

  function request(key, message) {
    return new Promise((resolve, reject) => {
      pending.set(key, { resolve, reject })
      try {
        post(message)
      } catch (error) {
        pending.delete(key)
        reject(error)
      }
    })
  }

  function settle(key, callback) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    callback(entry)
  }

  async function handleRefresh(message) {
    if (!activeFence || !fencesEqual(activeFence, message.fence)) return
    if (!pageIdentitiesEqual(identity, message.expectedPageIdentity)) return
    try {
      const sourceSnapshot = await pageBridge.refreshSnapshot({
        expectedPageIdentity: message.expectedPageIdentity,
        pageGeneration,
      })
      if (!pageIdentitiesEqual(identity, pageBridge.getCurrentPageIdentity?.() ?? identity)) return
      post({
        type: 'SOURCE_REFRESH_RESULT',
        requestId: message.requestId,
        taskId: message.fence.taskId,
        generation: message.fence.generation,
        pageIdentity: identity,
        pageGeneration,
        sourceSnapshot,
      })
    } catch (error) {
      post({
        type: 'SOURCE_REFRESH_RESULT',
        requestId: message.requestId,
        taskId: message.fence.taskId,
        generation: message.fence.generation,
        pageIdentity: identity,
        pageGeneration,
        errorCode: error?.message || 'VIDEO_SOURCE_REFRESH_FAILED',
      })
    }
  }

  function handleMessage(value) {
    if (disposed) return
    let message
    try {
      message = parseContentMessage(value)
    } catch {
      return
    }
    if (message.type === 'START_ACK' || message.type === 'RETRY_ACK') {
      settle(message.requestId, ({ resolve, reject }) => {
        if (message.status === 'rejected') reject(new Error(message.errorCode))
        else {
          if (message.fence) activeFence = message.fence
          resolve({
            taskId: message.taskId,
            generation: message.fence?.generation,
            fence: message.fence,
          })
        }
      })
    } else if (message.type === 'CANCEL_START_ACK') {
      settle(message.cancelRequestId, ({ resolve }) => resolve(message))
    } else if (message.type === 'ATTACH_ACK') {
      settle(message.requestId, ({ resolve, reject }) => {
        if (message.status === 'not-found') reject(new Error(message.errorCode))
        else {
          activeFence = message.fence
          if (message.event) onEvent(structuredClone(message.event))
          resolve(message)
        }
      })
    } else if (message.type === 'TASK_EVENT') {
      if (activeFence && fencesEqual(activeFence, message.fence))
        onEvent(structuredClone(message.event))
    } else if (message.type === 'SOURCE_REFRESH_REQUEST') void handleRefresh(message)
  }

  function handleDisconnect() {
    if (disposed) return
    const error = createDisconnectError()
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    onDisconnect()
  }

  port.onMessage.addListener(handleMessage)
  port.onDisconnect.addListener(handleDisconnect)

  return {
    startTask(payload) {
      const requestId = createRequestId()
      const taskId = createTaskId()
      const started = request(requestId, {
        type: 'START_TASK',
        requestId,
        taskId,
        pageIdentity: identity,
        ...structuredClone(payload),
      })
      started.requestId = requestId
      started.taskId = taskId
      return started
    },
    cancelStart({ cancelRequestId = createRequestId(), targetStartRequestId, taskId }) {
      return request(cancelRequestId, {
        type: 'CANCEL_START',
        cancelRequestId,
        targetStartRequestId,
        taskId,
        pageIdentity: identity,
      })
    },
    attachTask({ taskId, generation }) {
      const requestId = createRequestId()
      return request(requestId, {
        type: 'ATTACH_TASK',
        requestId,
        taskId,
        generation,
        pageIdentity: identity,
      })
    },
    async cancelTask({ taskId, generation }) {
      post({ type: 'CANCEL_TASK', taskId, generation, pageIdentity: identity })
    },
    retryTask({ requestId = createRequestId(), taskId, generation, fromStage, modelSnapshot }) {
      return request(requestId, {
        type: 'RETRY_TASK',
        requestId,
        taskId,
        generation,
        pageIdentity: identity,
        fromStage,
        modelSnapshot,
      })
    },
    dispose() {
      if (disposed) return
      const error = createDisconnectError()
      for (const entry of pending.values()) entry.reject(error)
      pending.clear()
      disposed = true
      port.onMessage.removeListener(handleMessage)
      port.onDisconnect.removeListener(handleDisconnect)
      port.disconnect()
    },
  }
}
