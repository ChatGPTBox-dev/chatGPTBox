export function markProxyGenerationStarted(port, proxyGenerationId, requestGenerationId) {
  if (proxyGenerationId !== undefined) port._proxyGenerationId = proxyGenerationId
  port._proxyRequestGenerationId = requestGenerationId
  port._generating = true
  port._suppressReconnectError = false
}

export function tagProxyRequestGeneration(port, message) {
  return port._proxyRequestGenerationId === undefined
    ? message
    : { ...message, requestGenerationId: port._proxyRequestGenerationId }
}

export function isCurrentProxyGenerationMessage(port, message) {
  return (
    message.stoppedGenerationId !== undefined ||
    port._proxyGenerationId === undefined ||
    (port._generating && message.proxyGenerationId === port._proxyGenerationId)
  )
}

export function markProxyGenerationFinished(port) {
  port._generating = false
  port._suppressReconnectError = false
}

export function forwardProxyMessage(port, message) {
  const forwardedMessage =
    message?.stop && port._stopAcknowledged ? { ...message, stopAcknowledged: true } : message
  if (message?.stop) interruptProxyGeneration(port)
  port.proxy.postMessage(forwardedMessage)
}

export function markProxyGenerationFinishedFromMessage(port, message) {
  if (
    !isCurrentProxyGenerationMessage(port, message) ||
    message.stoppedGenerationId !== undefined ||
    (!message.error && !message.done)
  )
    return false
  markProxyGenerationFinished(port)
  return true
}

export function interruptProxyGeneration(port) {
  if (!port._generating) return false
  port._generating = false
  port._suppressReconnectError = true
  return true
}

export function clearProxyReconnectErrorSuppression(port) {
  port._suppressReconnectError = false
}

export function consumeProxyReconnectErrorSuppression(port) {
  const shouldSuppress = Boolean(port._suppressReconnectError)
  port._suppressReconnectError = false
  return shouldSuppress
}

export function shouldSkipProxyReconnect(port) {
  return port._isClosed || Boolean(port.proxy)
}
