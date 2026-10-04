const PORT_PREFIX = 'bilibili-video-summary-chatgpt-proxy:'

function createError(code, { condition, modelName } = {}) {
  const error = new Error(code)
  error.code = code
  if (condition) error.condition = condition
  if (modelName) error.modelName = modelName
  return error
}

function createProviderPageError(modelName) {
  return createError('MODEL_PROVIDER_PAGE_REQUIRED', {
    condition: 'provider-page-required',
    modelName,
  })
}

export function createVideoSummaryChatgptProxy({ tabs, getConfiguredTabId, logger }) {
  return {
    async generate({ requestId, session, signal }) {
      const modelName = session?.modelName
      if (signal?.aborted) throw createError('MODEL_GATEWAY_ABORTED', { modelName })

      const tabId = await getConfiguredTabId()
      if (!tabId) throw createProviderPageError(modelName)

      try {
        const tab = await tabs.get(tabId)
        if (!tab?.id) throw createProviderPageError(modelName)
      } catch {
        throw createProviderPageError(modelName)
      }
      if (signal?.aborted) throw createError('MODEL_GATEWAY_ABORTED', { modelName })

      let port
      try {
        port = tabs.connect(tabId, { name: `${PORT_PREFIX}${requestId}` })
      } catch {
        throw createProviderPageError(modelName)
      }

      return new Promise((resolve, reject) => {
        let text = ''
        let finishReason = null
        let settled = false

        const cleanup = () => {
          signal?.removeEventListener?.('abort', handleAbort)
          port.onMessage.removeListener(handleMessage)
          port.onDisconnect.removeListener(handleDisconnect)
        }
        const settle = (callback, value) => {
          if (settled) return
          settled = true
          cleanup()
          try {
            port.disconnect()
          } catch {
            logger?.warn?.({
              event: 'video-summary-chatgpt-proxy.disconnect.failed',
              requestId,
              modelName,
            })
          }
          callback(value)
        }
        const handleMessage = (message) => {
          if (message?.requestId !== requestId) return
          if (typeof message.answer === 'string') text = message.answer
          if (typeof message.finishReason === 'string') finishReason = message.finishReason
          if (message.error !== undefined) {
            settle(
              reject,
              createError('MODEL_GATEWAY_PROVIDER_ERROR', {
                modelName,
              }),
            )
            return
          }
          if (message.done) settle(resolve, { text, finishReason })
        }
        const handleDisconnect = () => settle(reject, createProviderPageError(modelName))
        const handleAbort = () => {
          try {
            port.postMessage({ type: 'CANCEL_GENERATE_TEXT', requestId })
          } catch {
            logger?.warn?.({
              event: 'video-summary-chatgpt-proxy.cancel.failed',
              requestId,
              modelName,
            })
          }
          settle(reject, createError('MODEL_GATEWAY_ABORTED', { modelName }))
        }

        port.onMessage.addListener(handleMessage)
        port.onDisconnect.addListener(handleDisconnect)
        signal?.addEventListener?.('abort', handleAbort, { once: true })

        try {
          port.postMessage({ type: 'GENERATE_TEXT', requestId, session })
          logger?.info?.({ event: 'video-summary-chatgpt-proxy.generate', requestId, modelName })
        } catch {
          settle(reject, createProviderPageError(modelName))
        }
      })
    },
  }
}
