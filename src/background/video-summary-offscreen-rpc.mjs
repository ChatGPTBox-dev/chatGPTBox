import { VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS } from '../video-summary/contracts.mjs'
import { parseOffscreenCommand, parseOffscreenMessage } from '../video-summary/protocol.mjs'

const SAFE_GATEWAY_CONDITIONS = new Set(['login-required', 'provider-page-required', 'temporary'])

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z0-9_:-]+$/.test(value) ? value : fallback
}

function serializeResult(result, operation) {
  if (operation !== 'generateText') return structuredClone(result)
  return {
    text: typeof result?.text === 'string' ? result.text : '',
    finishReason: typeof result?.finishReason === 'string' ? result.finishReason : null,
  }
}

function serializeError(error, operation) {
  const result = {
    code: safeCode(error?.code || error?.message, 'VIDEO_SUMMARY_GATEWAY_REQUEST_FAILED'),
    operation,
    httpStatus: Number.isFinite(error?.httpStatus) ? error.httpStatus : null,
    providerCode: typeof error?.providerCode === 'string' ? error.providerCode : null,
    retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null,
  }
  if ('condition' in (error || {})) {
    result.condition = SAFE_GATEWAY_CONDITIONS.has(error.condition) ? error.condition : null
  }
  if ('modelName' in (error || {})) {
    const modelName = typeof error.modelName === 'string' ? error.modelName.trim() : ''
    result.modelName = /^[A-Za-z0-9_.:/-]{1,120}$/.test(modelName) ? modelName : null
  }
  return result
}

export function createVideoSummaryOffscreenRpc({
  mediaKitGateway,
  modelGateway,
  coordinator,
  logger,
  onDisconnect = () => {},
}) {
  const gateways = { mediakit: mediaKitGateway, model: modelGateway }
  let attachedPort = null
  let listeners = null

  function postCommand(value) {
    if (!attachedPort) throw new Error('VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED')
    attachedPort.postMessage(parseOffscreenCommand(value))
  }

  async function dispatchGateway(message) {
    let response
    let outcome
    let authorizedRequest = false
    try {
      const authorized = coordinator.authorizeGatewayRequest({
        fence: message.fence,
        requestId: message.requestId,
        gateway: message.gateway,
        operation: message.operation,
        args: message.args,
      })
      authorizedRequest = true
      const gateway = gateways[message.gateway]
      const allowed = VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS[message.gateway] || []
      if (!allowed.includes(message.operation)) {
        throw new Error('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')
      }
      const result =
        message.operation === 'markFallbackEligible'
          ? {}
          : await gateway?.[message.operation]?.(structuredClone(authorized.args))
      if (
        message.operation !== 'markFallbackEligible' &&
        typeof gateway?.[message.operation] !== 'function'
      ) {
        throw new Error('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')
      }
      outcome = { ok: true, result: serializeResult(result, message.operation) }
      response = {
        type: 'GATEWAY_RESPONSE',
        requestId: message.requestId,
        fence: message.fence,
        ...outcome,
      }
    } catch (error) {
      outcome = { ok: false, error: serializeError(error, message.operation) }
      response = {
        type: 'GATEWAY_RESPONSE',
        requestId: message.requestId,
        fence: message.fence,
        ...outcome,
      }
    }
    if (authorizedRequest) {
      coordinator.completeGatewayRequest({
        fence: message.fence,
        requestId: message.requestId,
        gateway: message.gateway,
        operation: message.operation,
        outcome,
      })
    }
    postCommand(response)
  }

  function detach(port = attachedPort) {
    if (!port || !listeners) return
    port.onMessage.removeListener(listeners.message)
    port.onDisconnect.removeListener(listeners.disconnect)
    if (attachedPort === port) attachedPort = null
    listeners = null
  }

  return {
    attachPort(port) {
      if (attachedPort) detach(attachedPort)
      const message = (value) => {
        let parsed
        try {
          parsed = parseOffscreenMessage(value)
        } catch (error) {
          logger?.warn?.({
            event: 'video-summary-offscreen-rpc.message-rejected',
            error: error?.message,
          })
          return
        }
        if (parsed.type === 'GATEWAY_REQUEST') void dispatchGateway(parsed)
        else coordinator.handleOffscreenMessage(parsed)
      }
      const disconnect = () => {
        detach(port)
        coordinator.handleOffscreenDisconnect()
        onDisconnect(port)
      }
      attachedPort = port
      listeners = { message, disconnect }
      port.onMessage.addListener(message)
      port.onDisconnect.addListener(disconnect)
      return true
    },
    postCommand,
    detachPort: detach,
  }
}
