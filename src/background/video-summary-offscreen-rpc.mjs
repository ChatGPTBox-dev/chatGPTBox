import {
  VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS,
  VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES,
  VIDEO_SUMMARY_OFFSCREEN_PORT_NAME,
} from '../video-summary/contracts.mjs'

function getLoggerMethod(logger, level) {
  return typeof logger?.[level] === 'function' ? logger[level].bind(logger) : () => {}
}

function normalizeId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toSafeCode(value, fallback) {
  if (typeof value === 'string' && /^[A-Z0-9_:-]+$/.test(value)) return value
  return fallback
}

const SAFE_GATEWAY_CONDITIONS = new Set(['login-required', 'provider-page-required', 'temporary'])

function cloneSerializable(value) {
  return structuredClone(value)
}

function projectSafeCondition(value) {
  return SAFE_GATEWAY_CONDITIONS.has(value) ? value : null
}

function projectSafeModelName(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 120) return null
  return /^[A-Za-z0-9_.:/-]+$/.test(normalized) ? normalized : null
}

function hasOwnProperty(object, property) {
  return Object.prototype.hasOwnProperty.call(object || {}, property)
}

function createRefreshKey({ owner, taskId }) {
  return `${owner?.tabId ?? 'tab'}:${owner?.documentId ?? 'doc'}:${owner?.platform ?? 'platform'}:${
    owner?.videoId ?? 'video'
  }:${taskId ?? 'task'}`
}

function serializeGatewayResult(result, operation) {
  if (operation !== 'generateText') return cloneSerializable(result)
  return {
    text: typeof result?.text === 'string' ? result.text : '',
    finishReason: typeof result?.finishReason === 'string' ? result.finishReason : null,
  }
}

function serializeGatewayError(
  error,
  operation,
  fallbackCode = 'VIDEO_SUMMARY_GATEWAY_REQUEST_FAILED',
) {
  const serialized = {
    code: toSafeCode(error?.code || error?.message, fallbackCode),
    operation: typeof operation === 'string' ? operation : null,
    httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
    providerCode: typeof error?.providerCode === 'string' ? error.providerCode : null,
    retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null,
  }

  if (hasOwnProperty(error, 'condition'))
    serialized.condition = projectSafeCondition(error?.condition)
  if (hasOwnProperty(error, 'modelName'))
    serialized.modelName = projectSafeModelName(error?.modelName)

  return serialized
}

function resolveGateway(gatewayName, gatewaysByName) {
  if (typeof gatewayName !== 'string') return null
  return gatewaysByName[gatewayName] ?? null
}

export function createVideoSummaryOffscreenRpc({
  mediaKitGateway,
  modelGateway,
  logger,
  onTaskEvent = () => {},
  requestSourceRefresh = () => {},
}) {
  const gatewaysByName = {
    mediakit: mediaKitGateway,
    model: modelGateway,
  }
  const pendingSourceRefreshRequests = new Map()
  let attachedPort = null
  let detachListeners = null
  const logWarn = getLoggerMethod(logger, 'warn')
  const logError = getLoggerMethod(logger, 'error')

  function detachPort(port = attachedPort) {
    if (!port || !detachListeners) return
    port.onMessage.removeListener(detachListeners.onMessage)
    port.onDisconnect.removeListener(detachListeners.onDisconnect)
    pendingSourceRefreshRequests.clear()
    if (attachedPort === port) attachedPort = null
    detachListeners = null
  }

  function postMessage(message) {
    if (!attachedPort) return
    attachedPort.postMessage(cloneSerializable(message))
  }

  async function handleGatewayRequest(message) {
    const requestId = normalizeId(message?.requestId)
    const gatewayName = typeof message?.gateway === 'string' ? message.gateway : null
    const operation = typeof message?.operation === 'string' ? message.operation : null
    const allowedOperations = gatewayName
      ? new Set(VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS[gatewayName] || [])
      : null
    const gateway = resolveGateway(gatewayName, gatewaysByName)

    if (!requestId) return

    if (
      !gateway ||
      !allowedOperations?.has(operation) ||
      typeof gateway?.[operation] !== 'function'
    ) {
      postMessage({
        type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
        requestId,
        ok: false,
        error: serializeGatewayError(
          { code: 'VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED' },
          operation,
          'VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED',
        ),
      })
      return
    }

    try {
      const result = await gateway[operation](message?.args ?? {})
      postMessage({
        type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
        requestId,
        ok: true,
        result: serializeGatewayResult(result, operation),
      })
    } catch (error) {
      postMessage({
        type: VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayResponse,
        requestId,
        ok: false,
        error: serializeGatewayError(error, operation),
      })
    }
  }

  function handleSourceRefreshRequest(message) {
    const requestId = normalizeId(message?.requestId)
    const taskId = normalizeId(message?.taskId)
    if (!requestId || !taskId || !message?.owner) return

    pendingSourceRefreshRequests.set(createRefreshKey({ owner: message.owner, taskId }), requestId)
    requestSourceRefresh({
      requestId,
      taskId,
      owner: cloneSerializable(message.owner),
      expectedVideoId: message.expectedVideoId ?? null,
      reason: message.reason ?? null,
    })
  }

  function handleTaskEvent(message) {
    if (!message?.event || typeof message.event !== 'object') return
    onTaskEvent(cloneSerializable(message.event))
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return

    switch (message.type) {
      case VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.taskEvent:
        handleTaskEvent(message)
        return
      case VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.sourceRefreshRequest:
        handleSourceRefreshRequest(message)
        return
      case VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.gatewayRequest:
        void handleGatewayRequest(message).catch((error) => {
          logError({
            event: 'video-summary-offscreen-rpc.gateway-request-failed',
            requestId: normalizeId(message?.requestId),
            gateway: message?.gateway ?? null,
            operation: message?.operation ?? null,
            error: toSafeCode(error?.message, 'VIDEO_SUMMARY_GATEWAY_REQUEST_FAILED'),
          })
        })
        return
      default:
        return
    }
  }

  return {
    attachPort(port) {
      if (port?.name !== VIDEO_SUMMARY_OFFSCREEN_PORT_NAME) return false
      if (attachedPort && attachedPort !== port) detachPort(attachedPort)

      const onMessage = (message) => {
        try {
          handleMessage(message)
        } catch (error) {
          logWarn({
            event: 'video-summary-offscreen-rpc.message-rejected',
            type: message?.type ?? null,
            error: toSafeCode(error?.message, 'VIDEO_SUMMARY_OFFSCREEN_RPC_MESSAGE_REJECTED'),
          })
        }
      }
      const onDisconnect = () => {
        detachPort(port)
      }

      attachedPort = port
      detachListeners = { onMessage, onDisconnect }
      port.onMessage.addListener(onMessage)
      port.onDisconnect.addListener(onDisconnect)
      return true
    },

    detachPort,

    postCommand(command) {
      if (!command || typeof command !== 'object') return

      if (command.type === 'SOURCE_REFRESH_RESULT') {
        const refreshKey = createRefreshKey({
          owner: command.owner,
          taskId: normalizeId(command.taskId),
        })
        const requestId = pendingSourceRefreshRequests.get(refreshKey)
        if (!requestId) return
        pendingSourceRefreshRequests.delete(refreshKey)
        postMessage({
          ...command,
          requestId,
        })
        return
      }

      postMessage(command)
    },
  }
}
