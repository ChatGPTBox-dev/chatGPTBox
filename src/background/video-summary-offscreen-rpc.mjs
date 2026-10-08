import { VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS } from '../video-summary/contracts.mjs'
import { parseOffscreenCommand, parseOffscreenMessage } from '../video-summary/protocol.mjs'

const SAFE_GATEWAY_CONDITIONS = new Set(['login-required', 'provider-page-required', 'temporary'])
const SAFE_GATEWAY_OPERATIONS = new Set(
  Object.values(VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS).flat(),
)
const SAFE_CODE = /^[A-Z][A-Z0-9_:-]{0,95}$/
const SAFE_MODEL_NAME = /^[A-Za-z0-9_.:/-]{1,120}$/

function ownerPath(owner) {
  return [owner.tabId, owner.documentId, owner.platform, owner.mediaId]
}

function getNestedMap(root, keys, create = false) {
  let current = root
  for (const key of keys) {
    let next = current.get(key)
    if (!next && create) {
      next = new Map()
      current.set(key, next)
    }
    if (!next) return null
    current = next
  }
  return current
}

function createAbortError() {
  return new DOMException('Aborted', 'AbortError')
}

function safeCode(value, fallback) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback
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
    operation: SAFE_GATEWAY_OPERATIONS.has(operation) ? operation : 'generateText',
  }
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    result.httpStatus = error.httpStatus
  }
  if (typeof error?.providerCode === 'string' && SAFE_CODE.test(error.providerCode)) {
    result.providerCode = error.providerCode
  }
  if (Number.isInteger(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    result.retryAfterMs = error.retryAfterMs
  }
  if (SAFE_GATEWAY_CONDITIONS.has(error?.condition)) result.condition = error.condition
  const modelName = typeof error?.modelName === 'string' ? error.modelName.trim() : ''
  if (SAFE_MODEL_NAME.test(modelName)) result.modelName = modelName
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
  const controllers = new Map()
  let attachedPort = null
  let listeners = null

  function postCommand(value) {
    if (!attachedPort) throw new Error('VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED')
    attachedPort.postMessage(parseOffscreenCommand(value))
  }

  function getRequests(fence, create = false) {
    const taskMap = getNestedMap(controllers, ownerPath(fence.owner), create)
    if (!taskMap) return null
    let generationMap = taskMap.get(fence.taskId)
    if (!generationMap && create) {
      generationMap = new Map()
      taskMap.set(fence.taskId, generationMap)
    }
    if (!generationMap) return null
    let attemptMap = generationMap.get(fence.generation)
    if (!attemptMap && create) {
      attemptMap = new Map()
      generationMap.set(fence.generation, attemptMap)
    }
    if (!attemptMap) return null
    let requests = attemptMap.get(fence.attempt)
    if (!requests && create) {
      requests = new Map()
      attemptMap.set(fence.attempt, requests)
    }
    return requests || null
  }

  function removeController(fence, requestId, controller) {
    const taskMap = getNestedMap(controllers, ownerPath(fence.owner))
    const generationMap = taskMap?.get(fence.taskId)
    const attemptMap = generationMap?.get(fence.generation)
    const requests = attemptMap?.get(fence.attempt)
    if (requests?.get(requestId) !== controller) return
    requests.delete(requestId)
    if (requests.size === 0) attemptMap.delete(fence.attempt)
    if (attemptMap.size === 0) generationMap.delete(fence.generation)
    if (generationMap.size === 0) taskMap.delete(fence.taskId)
  }

  function cancelRequest({ fence, requestId }) {
    getRequests(fence)?.get(requestId)?.abort(createAbortError())
  }

  function cancelGeneration({ owner, taskId, generation }) {
    const taskMap = getNestedMap(controllers, ownerPath(owner))
    const attemptMap = taskMap?.get(taskId)?.get(generation)
    if (!attemptMap) return
    for (const requests of attemptMap.values()) {
      for (const controller of requests.values()) controller.abort(createAbortError())
    }
  }

  function cancelAll() {
    for (const tabMap of controllers.values())
      for (const documentMap of tabMap.values())
        for (const platformMap of documentMap.values())
          for (const taskMap of platformMap.values())
            for (const generationMap of taskMap.values())
              for (const attemptMap of generationMap.values())
                for (const requests of attemptMap.values())
                  for (const controller of requests.values()) controller.abort(createAbortError())
  }

  async function dispatchGateway(message) {
    let response
    let outcome
    let authorizedRequest = false
    let controller
    try {
      const authorized = coordinator.authorizeGatewayRequest({
        fence: message.fence,
        requestId: message.requestId,
        gateway: message.gateway,
        operation: message.operation,
        args: message.args,
      })
      authorizedRequest = true
      const requests = getRequests(message.fence, true)
      controller = new AbortController()
      requests.set(message.requestId, controller)
      const gateway = gateways[message.gateway]
      const result =
        message.operation === 'markFallbackEligible'
          ? {}
          : await gateway?.[message.operation]?.(structuredClone(authorized.args), {
              signal: controller.signal,
            })
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
    } finally {
      if (controller) removeController(message.fence, message.requestId, controller)
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
    if (attachedPort) postCommand(response)
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
        else if (parsed.type === 'CANCEL_GATEWAY_REQUEST') cancelRequest(parsed)
        else coordinator.handleOffscreenMessage(parsed)
      }
      const disconnect = () => {
        cancelAll()
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
    cancelGeneration,
  }
}
