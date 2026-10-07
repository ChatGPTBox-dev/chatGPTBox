const DEFAULT_CAPABILITIES = {
  inputTokenBudget: 4000,
  maxOutputTokens: 20_000,
}

const MIN_OUTPUT_TOKENS = 1
const SAFE_CAPABILITY_CONDITIONS = new Set([
  'login-required',
  'provider-page-required',
  'temporary',
])

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
}

function cloneSerializable(value, fallback) {
  if (value === undefined) return fallback
  try {
    return structuredClone(value)
  } catch {
    return fallback
  }
}

function normalizeVideoSummaryMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('MODEL_GATEWAY_MESSAGES_INVALID')
  }
  return messages.map((message) => {
    const keys = Object.keys(message || {}).sort()
    if (
      keys.join(',') !== 'content,role' ||
      !['system', 'user'].includes(message.role) ||
      typeof message.content !== 'string' ||
      !message.content.trim()
    ) {
      throw new Error('MODEL_GATEWAY_MESSAGES_INVALID')
    }
    return { role: message.role, content: message.content }
  })
}

function normalizeMaxOutputTokens(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested)) return DEFAULT_CAPABILITIES.maxOutputTokens
  return Math.min(
    DEFAULT_CAPABILITIES.maxOutputTokens,
    Math.max(MIN_OUTPUT_TOKENS, Math.trunc(requested)),
  )
}

function safeErrorCode(error, fallback) {
  const code = typeof error?.code === 'string' ? error.code : ''
  return /^MODEL_[A-Z0-9_]+$/.test(code) ? code : fallback
}

function createCapabilityDescriptor({ state, reason = null, condition = null }) {
  const normalizedState =
    state === 'supported' ? 'supported' : state === 'temporary' ? 'temporary' : 'unsupported'
  return {
    supported: normalizedState === 'supported',
    state: normalizedState,
    reason: normalizedState === 'supported' ? null : reason || 'MODEL_GATEWAY_UNSUPPORTED',
    condition: SAFE_CAPABILITY_CONDITIONS.has(condition) ? condition : null,
    ...DEFAULT_CAPABILITIES,
  }
}

function capabilityFromError(error) {
  const condition = SAFE_CAPABILITY_CONDITIONS.has(error?.condition) ? error.condition : 'temporary'
  return createCapabilityDescriptor({
    state: 'temporary',
    reason: safeErrorCode(error, 'MODEL_TEMPORARY_FAILURE'),
    condition,
  })
}

function buildLogContext({
  event,
  requestId,
  taskId,
  modelSnapshot,
  maxOutputTokens,
  finishReason,
  errorCode,
}) {
  return {
    event,
    requestId,
    taskId,
    modelName: modelSnapshot?.modelName || null,
    apiModeGroup: modelSnapshot?.apiMode?.groupName || null,
    providerId: modelSnapshot?.apiMode?.providerId || null,
    maxOutputTokens,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(errorCode ? { errorCode } : {}),
  }
}

export function createModelGateway({
  getUserConfig,
  describeModelTextSupport,
  generateTextWithModel,
  logger,
}) {
  const controllers = new Map()

  return {
    async describeCapabilities(modelIdentity, { signal } = {}) {
      throwIfAborted(signal)
      const immutableIdentity = cloneSerializable(modelIdentity, {})
      try {
        const config = cloneSerializable(await getUserConfig(), {})
        throwIfAborted(signal)
        const support = await describeModelTextSupport(config, immutableIdentity, { signal })
        throwIfAborted(signal)
        return createCapabilityDescriptor(support || {})
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        return capabilityFromError(error)
      }
    },
    async generateText(
      { requestId, taskId, modelSnapshot, messages, maxOutputTokens, requestKind, toolPolicy },
      { signal } = {},
    ) {
      throwIfAborted(signal)
      if (requestKind !== 'video-summary' || toolPolicy !== 'none') {
        throw new Error('MODEL_GATEWAY_POLICY_INVALID')
      }
      const normalizedMessages = normalizeVideoSummaryMessages(messages)
      const key = `${taskId}:${requestId}`
      const controller = signal ? null : new AbortController()
      const requestSignal = signal || controller.signal
      const immutableSnapshot = cloneSerializable(modelSnapshot, {})
      const immutableMessages = cloneSerializable(normalizedMessages, [])
      const boundedOutputTokens = normalizeMaxOutputTokens(maxOutputTokens)
      if (controller) controllers.set(key, controller)

      try {
        logger?.info?.(
          buildLogContext({
            event: 'video-summary-model-gateway.generateText',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            maxOutputTokens: boundedOutputTokens,
          }),
        )
        const response = await generateTextWithModel(
          {
            modelSnapshot: immutableSnapshot,
            messages: immutableMessages,
            maxOutputTokens: boundedOutputTokens,
            requestKind,
            toolPolicy,
            signal: requestSignal,
          },
          { signal: requestSignal },
        )
        throwIfAborted(requestSignal)
        const result = {
          text: typeof response?.text === 'string' ? response.text : '',
          finishReason: response?.finishReason ?? null,
        }
        logger?.info?.(
          buildLogContext({
            event: 'video-summary-model-gateway.generateText.complete',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            maxOutputTokens: boundedOutputTokens,
            finishReason: result.finishReason,
          }),
        )
        return result
      } catch (error) {
        logger?.warn?.(
          buildLogContext({
            event: 'video-summary-model-gateway.generateText.failed',
            requestId,
            taskId,
            modelSnapshot: immutableSnapshot,
            maxOutputTokens: boundedOutputTokens,
            errorCode: safeErrorCode(error, 'MODEL_GATEWAY_GENERATION_FAILED'),
          }),
        )
        throw error
      } finally {
        if (controller && controllers.get(key) === controller) controllers.delete(key)
      }
    },
    cancel({ requestId, taskId }) {
      controllers.get(`${taskId}:${requestId}`)?.abort()
    },
  }
}
