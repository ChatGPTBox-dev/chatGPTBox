export const VIDEO_SUMMARY_CHATGPT_PROXY_PORT_PREFIX = 'video-summary-chatgpt-proxy:'

function createListenerSet() {
  const listeners = new Set()
  return {
    addListener(listener) {
      if (typeof listener === 'function') listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    emit(message) {
      for (const listener of Array.from(listeners)) listener(message)
    },
    clear() {
      listeners.clear()
    },
  }
}

function createForwardingPort(port, requestId, onTerminal) {
  const messageListeners = createListenerSet()
  const disconnectListeners = createListenerSet()
  return {
    onMessage: messageListeners,
    onDisconnect: disconnectListeners,
    postMessage(message) {
      port.postMessage({ ...message, requestId })
      if (message?.done || message?.error !== undefined) onTerminal()
    },
    disconnect() {
      disconnectListeners.emit()
      messageListeners.clear()
      disconnectListeners.clear()
    },
    cancel() {
      messageListeners.emit({ stop: true })
    },
  }
}

export function registerVideoSummaryChatgptProxyListener({
  runtime,
  getAccessToken,
  generateAnswers,
  logger,
}) {
  const handleConnect = (port) => {
    if (!port?.name?.startsWith(VIDEO_SUMMARY_CHATGPT_PROXY_PORT_PREFIX)) return
    const requestId = port.name.slice(VIDEO_SUMMARY_CHATGPT_PROXY_PORT_PREFIX.length)
    if (!requestId) return

    let forwardingPort = null
    let started = false
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true
      port.onMessage.removeListener(handleMessage)
      port.onDisconnect.removeListener(handleDisconnect)
      forwardingPort?.disconnect()
    }
    const cancel = () => {
      forwardingPort?.cancel()
    }
    const handleDisconnect = () => {
      cancel()
      cleanup()
    }
    const handleMessage = (message) => {
      if (message?.requestId !== requestId) return
      if (message.type === 'CANCEL_GENERATE_TEXT') {
        cancel()
        cleanup()
        return
      }
      if (
        started ||
        message.type !== 'GENERATE_TEXT' ||
        !message.session ||
        typeof message.session !== 'object' ||
        typeof message.session.question !== 'string'
      ) {
        return
      }

      started = true
      forwardingPort = createForwardingPort(port, requestId, cleanup)
      Promise.resolve()
        .then(async () => {
          const accessToken = await getAccessToken()
          if (closed) return
          if (!accessToken) {
            forwardingPort.postMessage({ error: 'MODEL_LOGIN_REQUIRED' })
            return
          }
          await generateAnswers(
            forwardingPort,
            message.session.question,
            message.session,
            accessToken,
          )
        })
        .catch(() => {
          logger?.error?.({
            event: 'video-summary-chatgpt-proxy.generate.failed',
            requestId,
            errorCode: 'MODEL_GATEWAY_PROVIDER_ERROR',
          })
          if (!closed) {
            forwardingPort.postMessage({ error: 'MODEL_GATEWAY_PROVIDER_ERROR' })
          }
        })
    }

    port.onMessage.addListener(handleMessage)
    port.onDisconnect.addListener(handleDisconnect)
  }

  runtime.onConnect.addListener(handleConnect)
  return () => runtime.onConnect.removeListener(handleConnect)
}
