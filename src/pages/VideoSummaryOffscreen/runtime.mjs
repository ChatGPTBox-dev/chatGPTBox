import { createMediaPipeline } from '../../video-summary/media-pipeline.mjs'
import { createTaskOpfsStore } from '../../video-summary/opfs.mjs'
import { createVideoTaskRunner } from '../../video-summary/task-runner.mjs'
import {
  VIDEO_SUMMARY_OFFSCREEN_COMMAND_TYPES,
  VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES,
} from '../../video-summary/contracts.mjs'

function getLoggerMethod(logger, level) {
  return typeof logger?.[level] === 'function' ? logger[level].bind(logger) : () => {}
}

function normalizeId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function cloneSerializable(value) {
  return structuredClone(value)
}

function sanitizeRpcArgs(args) {
  if (!args || typeof args !== 'object') return {}
  const serializableArgs = { ...args }
  delete serializableArgs.signal
  return cloneSerializable(serializableArgs)
}

function createRpcError(error) {
  const rpcError = new Error(error?.code || 'VIDEO_SUMMARY_GATEWAY_REQUEST_FAILED')
  rpcError.code = error?.code || 'VIDEO_SUMMARY_GATEWAY_REQUEST_FAILED'
  rpcError.operation = error?.operation ?? null
  rpcError.httpStatus = error?.httpStatus ?? null
  rpcError.providerCode = error?.providerCode ?? null
  rpcError.retryAfterMs = error?.retryAfterMs ?? null
  return rpcError
}

function createDisconnectError() {
  const error = new Error('VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED')
  error.code = 'VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED'
  return error
}

function defaultCreateRequestId() {
  return globalThis.crypto?.randomUUID?.() || `video-summary-${Date.now()}-${Math.random()}`
}

export function startVideoSummaryOffscreenRuntime({
  port,
  taskRunner,
  mediaPipeline,
  modelGateway,
  logger,
  clock = { now: () => Date.now() },
  createRequestId = defaultCreateRequestId,
}) {
  const pendingGatewayRequests = new Map()
  const pendingSourceRefreshes = new Map()
  const logWarn = getLoggerMethod(logger, 'warn')
  const logError = getLoggerMethod(logger, 'error')
  let stopped = false

  function rejectPendingRequests(error = createDisconnectError()) {
    for (const pending of pendingGatewayRequests.values()) pending.reject(error)
    for (const pending of pendingSourceRefreshes.values()) pending.reject(error)
    pendingGatewayRequests.clear()
    pendingSourceRefreshes.clear()
  }

  function postMessage(message) {
    if (stopped) return
    port.postMessage(cloneSerializable(message))
  }

  function requestGateway({ gateway, operation, args }) {
    const requestId = createRequestId()
    return new Promise((resolve, reject) => {
      pendingGatewayRequests.set(requestId, { resolve, reject })
      postMessage({
        type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest,
        requestId,
        gateway,
        operation,
        args: sanitizeRpcArgs(args),
      })
    })
  }

  const runtimeModelGateway = modelGateway || {
    async describeCapabilities(modelSnapshot) {
      return requestGateway({
        gateway: 'model',
        operation: 'describeCapabilities',
        args: modelSnapshot,
      })
    },
    async generateText(args) {
      return requestGateway({
        gateway: 'model',
        operation: 'generateText',
        args,
      })
    },
    async invokeTool(args) {
      return requestGateway({
        gateway: 'model',
        operation: 'invokeTool',
        args,
      })
    },
    async cancel(args) {
      return requestGateway({
        gateway: 'model',
        operation: 'cancel',
        args,
      }).catch(() => {})
    },
  }

  const runtimeMediaKitGateway = {
    submitDirectAsr(args) {
      return requestGateway({
        gateway: 'mediakit',
        operation: 'submitDirectAsr',
        args,
      })
    },
    requestUploadTarget(args = {}) {
      return requestGateway({
        gateway: 'mediakit',
        operation: 'requestUploadTarget',
        args,
      })
    },
    queryTask(args) {
      return requestGateway({
        gateway: 'mediakit',
        operation: 'queryTask',
        args,
      })
    },
  }

  const runtimeMediaPipeline =
    mediaPipeline ||
    createMediaPipeline({
      mediaKitGateway: runtimeMediaKitGateway,
      opfsStoreFactory({ taskId, owner }) {
        return createTaskOpfsStore({ taskId, owner })
      },
      logger,
      clock,
    })

  const runtimeTaskRunner =
    taskRunner ||
    createVideoTaskRunner({
      mediaPipeline: runtimeMediaPipeline,
      modelGateway: runtimeModelGateway,
      logger,
      clock,
    })

  function emitTaskEvent(event) {
    postMessage({
      type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.taskEvent,
      event: cloneSerializable(event),
    })
  }

  function requestSourceRefresh({ owner, taskId, expectedVideoId, reason }) {
    const requestId = createRequestId()
    return new Promise((resolve, reject) => {
      pendingSourceRefreshes.set(requestId, { resolve, reject })
      postMessage({
        type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.sourceRefreshRequest,
        requestId,
        taskId,
        owner: cloneSerializable(owner),
        expectedVideoId: expectedVideoId ?? null,
        reason: reason ?? null,
      })
    })
  }

  function handleGatewayResponse(message) {
    const requestId = normalizeId(message?.requestId)
    if (!requestId) return
    const pending = pendingGatewayRequests.get(requestId)
    if (!pending) return
    pendingGatewayRequests.delete(requestId)

    if (message.ok) {
      pending.resolve(message.result)
      return
    }

    pending.reject(createRpcError(message.error))
  }

  function handleSourceRefreshResult(message) {
    const requestId = normalizeId(message?.requestId)
    if (!requestId) return
    const pending = pendingSourceRefreshes.get(requestId)
    if (!pending) return
    pendingSourceRefreshes.delete(requestId)

    if (message.errorCode) {
      const error = new Error(message.errorCode)
      error.code = message.errorCode
      pending.reject(error)
      return
    }

    pending.resolve(message.sourceSnapshot)
  }

  function handleCommand(message) {
    if (!message || typeof message !== 'object') return

    if (message.type === VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse) {
      handleGatewayResponse(message)
      return
    }
    if (message.type === 'SOURCE_REFRESH_RESULT') {
      handleSourceRefreshResult(message)
      return
    }
    if (!VIDEO_SUMMARY_OFFSCREEN_COMMAND_TYPES.includes(message.type)) return

    switch (message.type) {
      case 'START_TASK':
        void Promise.resolve(
          runtimeTaskRunner.start(
            {
              ...message,
              requestSourceRefresh,
            },
            emitTaskEvent,
          ),
        ).catch((error) => {
          logWarn({
            event: 'video-summary-offscreen.start-failed',
            taskId: normalizeId(message.taskId),
            error: error?.code || error?.message || 'VIDEO_SUMMARY_OFFSCREEN_START_FAILED',
          })
        })
        return
      case 'RETRY_TASK':
        void Promise.resolve(runtimeTaskRunner.retry(message.taskId, message)).catch((error) => {
          logWarn({
            event: 'video-summary-offscreen.retry-failed',
            taskId: normalizeId(message.taskId),
            error: error?.code || error?.message || 'VIDEO_SUMMARY_OFFSCREEN_RETRY_FAILED',
          })
        })
        return
      case 'CANCEL_TASK':
        runtimeTaskRunner.cancel(message.taskId)
        return
      case 'ATTACH_TASK':
        return
      default:
        return
    }
  }

  const onMessage = (message) => {
    try {
      handleCommand(message)
    } catch (error) {
      logError({
        event: 'video-summary-offscreen.command-failed',
        type: message?.type ?? null,
        error: error?.code || error?.message || 'VIDEO_SUMMARY_OFFSCREEN_COMMAND_FAILED',
      })
    }
  }
  const onDisconnect = () => {
    stopped = true
    port.onMessage.removeListener(onMessage)
    port.onDisconnect.removeListener(onDisconnect)
    rejectPendingRequests()
  }

  port.onMessage.addListener(onMessage)
  port.onDisconnect.addListener(onDisconnect)

  return {
    port,
    mediaPipeline: runtimeMediaPipeline,
    mediaKitGateway: runtimeMediaKitGateway,
    modelGateway: runtimeModelGateway,
    taskRunner: runtimeTaskRunner,
    stop() {
      if (stopped) return
      stopped = true
      port.onMessage.removeListener(onMessage)
      port.onDisconnect.removeListener(onDisconnect)
      rejectPendingRequests()
    },
  }
}
