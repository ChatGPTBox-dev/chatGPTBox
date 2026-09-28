import { VIDEO_SUMMARY_PORT_NAME, createVideoSummaryOwner } from '../video-summary/contracts.mjs'

const ATTACH_GRACE_MS = 15_000
const ALLOWED_PORT_MESSAGE_TYPES = new Set([
  'START_TASK',
  'ATTACH_TASK',
  'CANCEL_TASK',
  'RETRY_TASK',
  'SOURCE_REFRESH_RESULT',
])

function getLoggerMethod(logger, level) {
  return typeof logger?.[level] === 'function' ? logger[level].bind(logger) : () => {}
}

function normalizeTaskId(taskId) {
  if (typeof taskId !== 'string') return null
  const normalized = taskId.trim()
  return normalized ? normalized : null
}

function isValidOwnerPart(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function deriveOwnerFromPort(port, videoId) {
  const tabId = port?.sender?.tab?.id
  const documentId = port?.sender?.documentId

  if (!Number.isInteger(tabId) || !isValidOwnerPart(documentId) || !isValidOwnerPart(videoId)) {
    return null
  }

  return createVideoSummaryOwner({
    tabId,
    documentId: documentId.trim(),
    videoId: videoId.trim(),
  })
}

function cloneSerializable(value) {
  return structuredClone(value)
}

export function routeKeyOf({ tabId, documentId, videoId }) {
  return `${tabId}:${documentId}:${videoId}`
}

export function createVideoSummaryRouter({
  mediaKitGateway,
  modelGateway,
  ensureOffscreenDocument,
  clock,
  logger,
  emitCommand = () => {},
}) {
  void mediaKitGateway
  void modelGateway

  const routes = new Map()
  const portBindings = new WeakMap()
  const startedAtMs = clock.now()
  const logWarn = getLoggerMethod(logger, 'warn')
  const logError = getLoggerMethod(logger, 'error')

  function emitSerializableCommand(command) {
    emitCommand(cloneSerializable(command))
  }

  function clearDisconnectTimer(route) {
    if (route.disconnectTimerId != null) {
      clock.clearTimeout(route.disconnectTimerId)
      route.disconnectTimerId = null
    }
    route.attachDeadlineAt = null
  }

  function detachPortBinding(port) {
    const binding = portBindings.get(port)
    if (!binding) return
    port.onMessage.removeListener(binding.onMessage)
    port.onDisconnect.removeListener(binding.onDisconnect)
    portBindings.delete(port)
  }

  function attachPortToRoute(route, port) {
    clearDisconnectTimer(route)
    route.port = port
  }

  function deleteRoute(routeKey, route = routes.get(routeKey)) {
    if (!route) return
    clearDisconnectTimer(route)
    if (route.port) {
      detachPortBinding(route.port)
      route.port = null
    }
    routes.delete(routeKey)
  }

  function scheduleDisconnectCancellation(routeKey, route) {
    clearDisconnectTimer(route)
    route.attachDeadlineAt = clock.now() + ATTACH_GRACE_MS
    route.disconnectTimerId = clock.setTimeout(() => {
      const currentRoute = routes.get(routeKey)
      if (currentRoute !== route || currentRoute.port) return
      routes.delete(routeKey)
      emitSerializableCommand({
        type: 'CANCEL_TASK',
        taskId: route.taskId,
        owner: route.owner,
        reason: 'OWNER_DISCONNECTED',
      })
    }, ATTACH_GRACE_MS)
  }

  function findRouteByPort(port) {
    for (const [routeKey, route] of routes.entries()) {
      if (route.port === port) return { routeKey, route }
    }
    return null
  }

  function acceptAttach(route, taskId) {
    if (!route) {
      return clock.now() - startedAtMs <= ATTACH_GRACE_MS
    }

    if (route.taskId !== taskId) return false
    if (!route.port && route.attachDeadlineAt != null) {
      return clock.now() <= route.attachDeadlineAt
    }
    return route.port == null
  }

  function handleStartTask(port, message) {
    const taskId = normalizeTaskId(message?.taskId)
    const owner = deriveOwnerFromPort(port, message?.videoId)
    if (!taskId || !owner) {
      logWarn({ event: 'video-summary-router.start.invalid', taskIdPresent: Boolean(taskId) })
      return
    }

    const routeKey = routeKeyOf(owner)
    deleteRoute(routeKey)
    const route = {
      owner,
      taskId,
      port,
      attachDeadlineAt: null,
      disconnectTimerId: null,
    }
    routes.set(routeKey, route)
    attachPortToRoute(route, port)

    emitSerializableCommand({
      ...message,
      type: 'START_TASK',
      taskId,
      videoId: owner.videoId,
      owner,
    })
  }

  function handleAttachTask(port, message) {
    const taskId = normalizeTaskId(message?.taskId)
    const owner = deriveOwnerFromPort(port, message?.videoId)
    if (!taskId || !owner) return

    const routeKey = routeKeyOf(owner)
    const existingRoute = routes.get(routeKey)
    if (!acceptAttach(existingRoute, taskId)) return

    const route = existingRoute ?? {
      owner,
      taskId,
      port: null,
      attachDeadlineAt: null,
      disconnectTimerId: null,
    }
    route.owner = owner
    route.taskId = taskId
    routes.set(routeKey, route)
    attachPortToRoute(route, port)

    emitSerializableCommand({
      type: 'ATTACH_TASK',
      taskId,
      videoId: owner.videoId,
      owner,
    })
  }

  function handleCancelTask(port, message) {
    const owner = deriveOwnerFromPort(port, message?.videoId)
    if (!owner) return
    const routeKey = routeKeyOf(owner)
    const route = routes.get(routeKey)
    if (!route) return

    const taskId = normalizeTaskId(message?.taskId) ?? route.taskId
    if (taskId !== route.taskId) return

    emitSerializableCommand({
      type: 'CANCEL_TASK',
      taskId,
      owner,
    })
    deleteRoute(routeKey, route)
  }

  function handleRetryTask(port, message) {
    const owner = deriveOwnerFromPort(port, message?.videoId)
    if (!owner) return
    const route = routes.get(routeKeyOf(owner))
    if (!route) return

    const taskId = normalizeTaskId(message?.taskId) ?? route.taskId
    if (taskId !== route.taskId) return

    emitSerializableCommand({
      ...message,
      type: 'RETRY_TASK',
      taskId,
      videoId: owner.videoId,
      owner,
    })
  }

  function handleSourceRefreshResult(port, message) {
    const owner = deriveOwnerFromPort(port, message?.videoId)
    const taskId = normalizeTaskId(message?.taskId)
    if (!owner || !taskId) return

    const route = routes.get(routeKeyOf(owner))
    if (!route || route.taskId !== taskId) return

    emitSerializableCommand({
      ...message,
      type: 'SOURCE_REFRESH_RESULT',
      taskId,
      videoId: owner.videoId,
      owner,
    })
  }

  function handlePortMessage(port, message) {
    if (!message || typeof message !== 'object') return
    if (!ALLOWED_PORT_MESSAGE_TYPES.has(message.type)) return

    switch (message.type) {
      case 'START_TASK':
        handleStartTask(port, message)
        return
      case 'ATTACH_TASK':
        handleAttachTask(port, message)
        return
      case 'CANCEL_TASK':
        handleCancelTask(port, message)
        return
      case 'RETRY_TASK':
        handleRetryTask(port, message)
        return
      case 'SOURCE_REFRESH_RESULT':
        handleSourceRefreshResult(port, message)
        return
      default:
        return
    }
  }

  function handlePortDisconnect(port) {
    const matched = findRouteByPort(port)
    detachPortBinding(port)
    if (!matched) return

    const { routeKey, route } = matched
    route.port = null
    if (!route.taskId) {
      routes.delete(routeKey)
      return
    }
    scheduleDisconnectCancellation(routeKey, route)
  }

  return {
    async handleConnect(port) {
      if (port?.name !== VIDEO_SUMMARY_PORT_NAME) return

      await ensureOffscreenDocument()

      const onMessage = (message) => {
        try {
          handlePortMessage(port, message)
        } catch (error) {
          logError({
            event: 'video-summary-router.message.failed',
            type: message?.type ?? null,
            error: error?.message || 'VIDEO_SUMMARY_ROUTER_MESSAGE_FAILED',
          })
        }
      }
      const onDisconnect = () => {
        try {
          handlePortDisconnect(port)
        } catch (error) {
          logError({
            event: 'video-summary-router.disconnect.failed',
            error: error?.message || 'VIDEO_SUMMARY_ROUTER_DISCONNECT_FAILED',
          })
        }
      }

      portBindings.set(port, { onMessage, onDisconnect })
      port.onMessage.addListener(onMessage)
      port.onDisconnect.addListener(onDisconnect)
    },

    handleTabRemoved(tabId) {
      for (const [routeKey, route] of Array.from(routes.entries())) {
        if (route.owner.tabId !== tabId) continue
        emitSerializableCommand({
          type: 'CANCEL_TASK',
          taskId: route.taskId,
          owner: route.owner,
          reason: 'OWNER_TAB_REMOVED',
        })
        deleteRoute(routeKey, route)
      }
    },

    handleTaskEvent(event) {
      if (!event || typeof event !== 'object' || !event.owner) return
      const route = routes.get(routeKeyOf(event.owner))
      if (!route || route.taskId !== event.taskId || !route.port) return
      route.port.postMessage(cloneSerializable(event))
    },

    requestSourceRefresh(owner, taskId) {
      const route = routes.get(routeKeyOf(owner))
      if (!route || route.taskId !== taskId || !route.port) return
      route.port.postMessage({
        type: 'REQUEST_SOURCE_REFRESH',
        taskId,
        owner: cloneSerializable(owner),
      })
    },

    debugRoutes() {
      return routes
    },
  }
}
