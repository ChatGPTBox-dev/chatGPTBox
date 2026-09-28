import { getModelValue } from '../utils/model-name-convert.mjs'

const DEFAULT_CAPABILITIES = {
  inputTokenBudget: 4000,
  maxOutputTokens: 20_000,
}

const SAFE_TOOL_CALL_ERROR_CODES = new Set([
  'MODEL_TOOL_CALL_MISSING',
  'MODEL_TOOL_CALL_MULTIPLE',
  'MODEL_TOOL_NAME_MISMATCH',
  'MODEL_TOOL_ARGUMENTS_INVALID',
  'MODEL_TOOL_SCHEMA_INVALID',
  'MODEL_TOOL_ARGUMENTS_TOO_LARGE',
  'MODEL_GATEWAY_UNSUPPORTED',
  'MODEL_GATEWAY_ABORTED',
  'MODEL_GATEWAY_TOOL_CALLER_MISSING',
])

function toSafeToolCallErrorCode(error) {
  const candidate =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.message === 'string'
      ? error.message
      : null
  if (candidate && SAFE_TOOL_CALL_ERROR_CODES.has(candidate)) return candidate
  return 'MODEL_GATEWAY_TOOL_CALL_FAILED'
}

function createListenerSet() {
  const listeners = new Set()
  return {
    addListener(listener) {
      listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    emit(payload) {
      for (const listener of listeners) listener(payload)
    },
    clear() {
      listeners.clear()
    },
  }
}

function createCapabilityDescriptor(supported) {
  return {
    supported,
    reason: supported ? null : 'MODEL_GATEWAY_UNSUPPORTED',
    ...DEFAULT_CAPABILITIES,
  }
}

function cloneModelSnapshot(modelSnapshot) {
  if (!modelSnapshot || typeof modelSnapshot !== 'object') return {}
  return {
    ...modelSnapshot,
    apiMode:
      modelSnapshot.apiMode && typeof modelSnapshot.apiMode === 'object'
        ? { ...modelSnapshot.apiMode }
        : modelSnapshot.apiMode,
  }
}

function resolveModelName(modelSnapshot, config) {
  if (modelSnapshot?.modelName === 'customModel' && !modelSnapshot?.apiMode) {
    return String(config?.customModelName || '').trim()
  }
  if (
    modelSnapshot?.apiMode?.groupName === 'customApiModelKeys' &&
    typeof modelSnapshot.apiMode.customName === 'string' &&
    modelSnapshot.apiMode.customName.trim()
  ) {
    return modelSnapshot.apiMode.customName.trim()
  }
  return getModelValue(modelSnapshot)
}

function toConversationRecord(message) {
  const text = String(message?.content || '').trim()
  if (!text) return null
  if (message?.role === 'assistant') return { question: '', answer: text }
  return { question: text, answer: '' }
}

function splitMessages(messages) {
  const normalizedMessages = Array.isArray(messages) ? messages : []
  if (normalizedMessages.length === 0) {
    return {
      question: '',
      conversationRecords: [],
    }
  }

  const lastMessage = normalizedMessages[normalizedMessages.length - 1]
  const question = String(lastMessage?.content || '').trim()
  const conversationRecords = normalizedMessages
    .slice(0, -1)
    .map(toConversationRecord)
    .filter(Boolean)

  return { question, conversationRecords }
}

function createIsolatedPort(controller, onAnswer) {
  const onMessage = createListenerSet()
  const onDisconnect = createListenerSet()
  const port = {
    _abortController: controller,
    onMessage,
    onDisconnect,
    postMessage(payload) {
      if (typeof payload?.answer === 'string') onAnswer(payload.answer)
    },
    disconnect() {
      onDisconnect.emit()
      onMessage.clear()
      onDisconnect.clear()
    },
  }

  controller.signal.addEventListener(
    'abort',
    () => {
      onMessage.emit({ stop: true })
    },
    { once: true },
  )

  return port
}

function buildLogContext({
  event,
  requestId,
  taskId,
  modelSnapshot,
  outputContract,
  maxOutputTokens,
}) {
  return {
    event,
    requestId,
    taskId,
    apiModeGroup: modelSnapshot?.apiMode?.groupName || null,
    providerId: modelSnapshot?.apiMode?.providerId || null,
    outputType: outputContract?.type || null,
    maxOutputTokens,
  }
}

function buildToolLogContext({ event, requestId, taskId, modelSnapshot, tool, result }) {
  return {
    event,
    requestId,
    taskId,
    toolName: tool?.name ?? null,
    argumentBytes: Number.isFinite(result?.argumentBytes) ? result.argumentBytes : null,
    apiModeGroup: modelSnapshot?.apiMode?.groupName || null,
    providerId: modelSnapshot?.apiMode?.providerId || null,
  }
}

function normalizeProtocolDiagnosticsFinishReason(value) {
  const allowlist = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'other'])
  if (typeof value !== 'string' || !value) return null
  return allowlist.has(value) ? value : 'other'
}

function projectProtocolDiagnostics(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null

  const eventCount =
    Number.isInteger(candidate.eventCount) && candidate.eventCount >= 0
      ? candidate.eventCount
      : null
  const choiceEventCount =
    Number.isInteger(candidate.choiceEventCount) && candidate.choiceEventCount >= 0
      ? candidate.choiceEventCount
      : null

  const finishReasons = Array.isArray(candidate.finishReasons)
    ? Array.from(
        new Set(
          candidate.finishReasons.map(normalizeProtocolDiagnosticsFinishReason).filter(Boolean),
        ),
      )
    : null

  const protocolDiagnostics = {
    eventCount,
    choiceEventCount,
    finishReasons,
    sawContent: candidate.sawContent === true,
    sawReasoningContent: candidate.sawReasoningContent === true,
    sawDeltaToolCalls: candidate.sawDeltaToolCalls === true,
    sawMessageToolCalls: candidate.sawMessageToolCalls === true,
    sawLegacyFunctionCall: candidate.sawLegacyFunctionCall === true,
  }

  for (const [key, value] of Object.entries(protocolDiagnostics)) {
    if (value === null) delete protocolDiagnostics[key]
  }

  return Object.keys(protocolDiagnostics).length > 0 ? protocolDiagnostics : null
}

export function createModelGateway({
  getUserConfig,
  resolveOpenAICompatibleRequest,
  generateAnswersWithOpenAICompatible,
  invokeOpenAICompatibleTool,
  logger,
}) {
  const controllers = new Map()

  return {
    async describeCapabilities(modelIdentity) {
      try {
        const config = await getUserConfig()
        const request = resolveOpenAICompatibleRequest(config, cloneModelSnapshot(modelIdentity))
        return createCapabilityDescriptor(Boolean(request))
      } catch {
        return createCapabilityDescriptor(false)
      }
    },
    async invokeTool({ requestId, taskId, modelSnapshot, messages, maxOutputTokens, tool }) {
      const key = `${taskId}:${requestId}`
      const controller = new AbortController()
      const immutableSnapshot = cloneModelSnapshot(modelSnapshot)
      const immutableMessages = structuredClone(Array.isArray(messages) ? messages : [])
      const immutableTool = structuredClone(tool || {})
      controllers.set(key, controller)

      let result = null

      try {
        const config = await getUserConfig()
        const request = resolveOpenAICompatibleRequest(config, immutableSnapshot)
        if (!request) throw new Error('MODEL_GATEWAY_UNSUPPORTED')

        const model = resolveModelName(immutableSnapshot, config)
        const frozenConfig = Object.freeze({
          ...structuredClone(config),
          maxResponseTokenLength: maxOutputTokens,
        })

        logger?.info?.(
          buildToolLogContext({
            event: 'video-summary-model-gateway.invokeTool',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            tool: immutableTool,
            result: null,
          }),
        )

        if (typeof invokeOpenAICompatibleTool !== 'function') {
          throw new Error('MODEL_GATEWAY_TOOL_CALLER_MISSING')
        }

        result = await invokeOpenAICompatibleTool({
          requestUrl: request.requestUrl,
          model,
          apiKey: request.apiKey,
          messages: immutableMessages,
          maxOutputTokens,
          config: frozenConfig,
          provider: request.providerId,
          extraBody: request.extraBody,
          extraHeaders: request.extraHeaders,
          tool: immutableTool,
          signal: controller.signal,
        })

        if (controller.signal.aborted) throw new Error('MODEL_GATEWAY_ABORTED')

        logger?.info?.(
          buildToolLogContext({
            event: 'video-summary-model-gateway.invokeTool.complete',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            tool: immutableTool,
            result,
          }),
        )

        return result
      } catch (error) {
        const errorCode = toSafeToolCallErrorCode(error)
        logger?.warn?.({
          ...buildToolLogContext({
            event: 'video-summary-model-gateway.invokeTool.failed',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            tool: immutableTool,
            result,
          }),
          errorCode,
          protocolDiagnostics: projectProtocolDiagnostics(error?.protocolDiagnostics) || undefined,
        })
        throw error
      } finally {
        controllers.delete(key)
      }
    },
    async generate({
      requestId,
      taskId,
      modelSnapshot,
      messages,
      maxOutputTokens,
      outputContract,
    }) {
      const key = `${taskId}:${requestId}`
      const controller = new AbortController()
      let text = ''
      const immutableSnapshot = cloneModelSnapshot(modelSnapshot)
      const port = createIsolatedPort(controller, (answer) => {
        text = answer
      })
      controllers.set(key, controller)

      try {
        const config = await getUserConfig()
        const request = resolveOpenAICompatibleRequest(config, immutableSnapshot)
        if (!request) throw new Error('MODEL_GATEWAY_UNSUPPORTED')

        const { question, conversationRecords } = splitMessages(messages)
        const model = resolveModelName(immutableSnapshot, config)
        logger?.info?.(
          buildLogContext({
            event: 'video-summary-model-gateway.generate',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            outputContract,
            maxOutputTokens,
          }),
        )

        await generateAnswersWithOpenAICompatible({
          port,
          question,
          session: { conversationRecords },
          endpointType: request.endpointType,
          requestUrl: request.requestUrl,
          model,
          apiKey: request.apiKey,
          config: {
            ...config,
            maxResponseTokenLength: maxOutputTokens,
          },
          provider: request.providerId,
          extraBody: request.extraBody,
          extraHeaders: request.extraHeaders,
          allowLegacyResponseField: request.provider?.allowLegacyResponseField,
        })

        if (controller.signal.aborted) throw new Error('MODEL_GATEWAY_ABORTED')

        logger?.info?.(
          buildLogContext({
            event: 'video-summary-model-gateway.complete',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            outputContract,
            maxOutputTokens,
          }),
        )
        return { text }
      } catch (error) {
        logger?.warn?.({
          ...buildLogContext({
            event: 'video-summary-model-gateway.failed',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            outputContract,
            maxOutputTokens,
          }),
          error: error?.message || 'MODEL_GATEWAY_ERROR',
        })
        throw error
      } finally {
        controllers.delete(key)
        port.disconnect()
      }
    },
    cancel({ requestId, taskId }) {
      controllers.get(`${taskId}:${requestId}`)?.abort()
    },
  }
}
