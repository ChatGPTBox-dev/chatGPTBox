import {
  getApiModesFromConfig,
  getModelValue,
  isApiModeSelected,
} from '../utils/model-name-convert.mjs'
import {
  isNativeOllamaChatRequestUrl,
  resolveProviderRequestShapingId,
} from './apis/openai-compatible-request-helpers.mjs'
import { resolveOpenAICompatibleRequest } from './apis/provider-registry.mjs'

const UNSUITABLE_REASONING_MODEL_PATTERN =
  /(?:^|\/)(?:gpt-5(?:[.-]|$)|o3(?:[.-]|$)|deepseek-reasoner(?:[.-]|$))|^chat-latest$/i

export function hasCrossContextSessionLock(locks = globalThis.navigator?.locks) {
  return Boolean(locks && typeof locks.request === 'function')
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

export function isSecureConversationTitleRequestUrl(requestUrl) {
  try {
    const url = new URL(requestUrl)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

export function resolveConversationTitleModelRequest(
  config,
  apiMode = config?.conversationTitleApiMode,
  resolveRequest = resolveOpenAICompatibleRequest,
) {
  if (!apiMode || typeof apiMode !== 'object') {
    throw new Error('No conversation title model is configured.')
  }

  const isEnabled = getApiModesFromConfig(config, true).some((candidate) =>
    isApiModeSelected(candidate, { apiMode }, { sessionCompat: true }),
  )
  if (!isEnabled) {
    throw new Error('The selected conversation title model is no longer enabled.')
  }

  const model = getModelValue({ apiMode })
  if (!model) throw new Error('The selected conversation title model has no model identifier.')

  const request = resolveRequest(config, { apiMode })
  if (!request || request.endpointType !== 'chat' || !request.requestUrl) {
    throw new Error('The selected conversation title model is unavailable or unsupported.')
  }
  if (!isSecureConversationTitleRequestUrl(request.requestUrl)) {
    throw new Error(
      'Conversation title endpoints must use HTTPS, except for loopback HTTP endpoints.',
    )
  }
  if (isNativeOllamaChatRequestUrl(request.requestUrl)) {
    throw new Error(
      'Native Ollama chat endpoints are not supported for conversation titles; ' +
        'use the OpenAI-compatible chat-completions endpoint.',
    )
  }

  const provider = resolveProviderRequestShapingId(request)
  if (UNSUITABLE_REASONING_MODEL_PATTERN.test(model)) {
    throw new Error(
      'Reasoning-heavy models are not supported for conversation titles; ' +
        'choose a fast non-reasoning model.',
    )
  }

  return { model, provider, request }
}

export function isConversationTitleApiModeSupported(
  config,
  apiMode,
  resolveRequest = resolveOpenAICompatibleRequest,
) {
  try {
    resolveConversationTitleModelRequest(config, apiMode, resolveRequest)
    return true
  } catch {
    return false
  }
}

export function isConversationTitleModelAvailable(
  config,
  resolveRequest = resolveOpenAICompatibleRequest,
  locks = globalThis.navigator?.locks,
) {
  try {
    if (!hasCrossContextSessionLock(locks)) return false
    resolveConversationTitleModelRequest(
      config,
      config?.conversationTitleApiMode,
      resolveRequest,
    )
    return true
  } catch {
    return false
  }
}
