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

function cloneSerializable(value, fallback) {
  if (value === undefined) return fallback
  try {
    return structuredClone(value)
  } catch {
    return fallback
  }
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
    async describeCapabilities(modelIdentity) {
      const immutableIdentity = cloneSerializable(modelIdentity, {})
      try {
        const config = cloneSerializable(await getUserConfig(), {})
        const support = await describeModelTextSupport(config, immutableIdentity)
        return createCapabilityDescriptor(support || {})
      } catch (error) {
        return capabilityFromError(error)
      }
    },
    async generateText({ requestId, taskId, modelSnapshot, messages, maxOutputTokens }) {
      const key = `${taskId}:${requestId}`
      const controller = new AbortController()
      const immutableSnapshot = cloneSerializable(modelSnapshot, {})
      const immutableMessages = cloneSerializable(Array.isArray(messages) ? messages : [], [])
      const boundedOutputTokens = normalizeMaxOutputTokens(maxOutputTokens)
      controllers.set(key, controller)

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
        const response = await generateTextWithModel({
          modelSnapshot: immutableSnapshot,
          messages: immutableMessages,
          maxOutputTokens: boundedOutputTokens,
          signal: controller.signal,
        })
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
        controllers.delete(key)
      }
    },
    cancel({ requestId, taskId }) {
      controllers.get(`${taskId}:${requestId}`)?.abort()
    },
  }
}
