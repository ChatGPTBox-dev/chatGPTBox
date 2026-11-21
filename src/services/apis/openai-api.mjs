import { getUserConfig } from '../../config/index.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { generateAnswersWithOpenAICompatible } from './openai-compatible-core.mjs'
import { withAbortController } from './shared.mjs'
import {
  generateAnswersWithOpenAIResponses,
  isResponsesRouteUnsupportedError,
} from './openai-responses-core.mjs'
import {
  API_PROTOCOL_RESPONSES,
  deriveResponsesUrlFromChatUrl,
  getOpenAICompatibleRequestDiagnostic,
  normalizeExplicitApiProtocol,
  resolveOpenAICompatibleRequest,
} from './provider-registry.mjs'

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
}

function normalizeBaseUrlWithoutVersionSuffix(baseUrl, fallback) {
  return normalizeBaseUrl(baseUrl || fallback).replace(/\/v1$/i, '')
}

function resolveModelName(session, config) {
  if (session.modelName === 'customModel' && !session.apiMode) {
    return config.customModelName
  }
  if (
    session.apiMode?.groupName === 'customApiModelKeys' &&
    session.apiMode?.customName &&
    session.apiMode.customName.trim()
  ) {
    return session.apiMode.customName.trim()
  }
  return getModelValue(session)
}

const OPENAI_COMPATIBLE_RUNTIME_CONFIG_KEYS = [
  'maxConversationContextLength',
  'maxResponseTokenLength',
  'temperatureOverrideEnabled',
  'temperature',
]

const OPENROUTER_API_ORIGIN = 'https://openrouter.ai'
const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://github.com/ChatGPTBox-dev/chatGPTBox',
  'X-OpenRouter-Title': 'ChatGPTBox',
  'X-OpenRouter-Categories': 'general-chat,writing-assistant',
}

function hasOpenAICompatibleRuntimeConfig(config) {
  if (!config || typeof config !== 'object') return false
  return OPENAI_COMPATIBLE_RUNTIME_CONFIG_KEYS.every((key) => Object.hasOwn(config, key))
}

async function resolveOpenAICompatibleRuntimeConfig(config) {
  if (hasOpenAICompatibleRuntimeConfig(config)) return config
  return {
    ...(await getUserConfig()),
    ...(config && typeof config === 'object' ? config : {}),
  }
}

function buildOpenAICompatibleResolutionErrorMessage(diagnostic) {
  const groupName = String(diagnostic?.groupName || '').trim() || 'unknown-group'
  const normalizedProviderId =
    String(diagnostic?.normalizedProviderId || '').trim() || 'unknown-provider'
  let hint = 'Check whether the provider still exists, is enabled, and has a valid endpoint.'
  if (diagnostic?.hasDisabledMatchingCustomProvider) {
    hint = 'A matching custom provider exists but is disabled.'
  } else if (diagnostic?.hasDisabledMatchingCustomProviderByLegacyUrl) {
    hint = 'A matching custom provider was found by the saved legacy endpoint but is disabled.'
  } else if (diagnostic?.hasMatchingCustomProviderByLegacyUrl) {
    hint =
      'A provider was found by the saved legacy endpoint; the mode configuration may need to be re-saved.'
  }
  return (
    `Failed to resolve OpenAI-compatible provider settings for ${groupName}/${normalizedProviderId}. ` +
    hint
  )
}

function hasOpenAILineage(request) {
  return (
    request?.providerId === 'openai' ||
    request?.secretProviderId === 'openai' ||
    request?.provider?.sourceProviderId === 'openai'
  )
}

function shouldUseResponsesProtocol(request, config, session) {
  // The legacy prompt-based completions endpoint has no Responses equivalent.
  if (request?.endpointType === 'completion') return false
  const explicitProtocol =
    normalizeExplicitApiProtocol(session?.apiMode?.apiProtocol) ||
    normalizeExplicitApiProtocol(request?.provider?.apiProtocol)
  if (explicitProtocol) return explicitProtocol === API_PROTOCOL_RESPONSES
  if (
    String(config?.openaiApiProtocol || '')
      .trim()
      .toLowerCase() !== API_PROTOCOL_RESPONSES
  ) {
    return false
  }
  return hasOpenAILineage(request)
}

function resolveResponsesRequestUrl(request) {
  if (request?.apiProtocol === API_PROTOCOL_RESPONSES) return request.requestUrl
  return (
    String(request?.provider?.responsesUrl || '').trim() ||
    deriveResponsesUrlFromChatUrl(request?.requestUrl)
  )
}

function shouldFallbackToChatCompletions(error) {
  // Only fall back on initial HTTP failures. Mid-stream errors (no status)
  // may already have emitted partial answers; retrying via Chat would duplicate them.
  if (error?.status == null) return false
  return isResponsesRouteUnsupportedError(error)
}

function hasNativeOpenAIRequestUrl(requestUrl) {
  const normalizedRequestUrl = normalizeBaseUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const normalizedPathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return (
      parsedRequestUrl.hostname.toLowerCase() === 'api.openai.com' &&
      (normalizedPathname === '/v1/chat/completions' || normalizedPathname === '/v1/completions')
    )
  } catch {
    return false
  }
}

function shouldUseOpenAIRequestShaping(request) {
  if (request?.providerId === 'openai') return true

  const hasOpenAILineage =
    request?.provider?.sourceProviderId === 'openai' || request?.secretProviderId === 'openai'
  if (!hasOpenAILineage) return false

  return hasNativeOpenAIRequestUrl(request?.requestUrl)
}

function resolveProviderRequestShapingId(request) {
  if (shouldUseOpenAIRequestShaping(request)) return 'openai'
  return request?.providerId
}

function getOpenRouterAttributionHeaders(requestUrl) {
  try {
    if (new URL(requestUrl).origin !== OPENROUTER_API_ORIGIN) return {}
  } catch {
    return {}
  }
  return OPENROUTER_ATTRIBUTION_HEADERS
}

function resolveOllamaKeepAliveBaseUrl(request) {
  const requestUrl = normalizeBaseUrl(request?.requestUrl)
  if (requestUrl) {
    try {
      const parsedRequestUrl = new URL(requestUrl)
      parsedRequestUrl.search = ''
      parsedRequestUrl.hash = ''
      const normalizedRequestPathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
      let keepAlivePathname = normalizedRequestPathname
        .replace(/\/chat\/completions$/i, '')
        .replace(/\/completions$/i, '')
      if (keepAlivePathname === normalizedRequestPathname) {
        keepAlivePathname = normalizedRequestPathname.replace(/\/[^/]+$/, '') || '/'
        keepAlivePathname = keepAlivePathname.replace(/\/api$/i, '') || '/'
      }
      parsedRequestUrl.pathname = keepAlivePathname
      const normalizedRequestBaseUrl = normalizeBaseUrlWithoutVersionSuffix(
        parsedRequestUrl.toString(),
        '',
      )
      if (normalizedRequestBaseUrl) return normalizedRequestBaseUrl
    } catch {
      // Fall through to provider baseUrl fallback.
    }
  }

  return normalizeBaseUrlWithoutVersionSuffix(request?.provider?.baseUrl, 'http://127.0.0.1:11434')
}

function hasNativeOllamaChatApiPath(requestUrl) {
  const normalizedRequestUrl = normalizeBaseUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const normalizedPathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return /(^|\/)api\/chat$/i.test(normalizedPathname)
  } catch {
    return false
  }
}

function assertSupportedChatEndpoint(requestUrl) {
  if (hasNativeOllamaChatApiPath(requestUrl)) {
    throw new Error(
      'Unsupported native Ollama chat endpoint. Use the OpenAI-compatible /v1/chat/completions endpoint instead.',
    )
  }
}

function hasOllamaMessagesPath(requestUrl) {
  const normalizedRequestUrl = normalizeBaseUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const normalizedPathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return /(^|\/)v1\/messages$/i.test(normalizedPathname)
  } catch {
    return false
  }
}

function hasOllamaCompatChatCompletionsPath(requestUrl) {
  const normalizedRequestUrl = normalizeBaseUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const normalizedPathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return /(^|\/)v1\/chat\/completions$/i.test(normalizedPathname)
  } catch {
    return false
  }
}

function shouldSendOllamaKeepAlive(request) {
  if (request.providerId === 'ollama') return true
  if (request.secretProviderId === 'ollama') {
    return hasOllamaMessagesPath(request.requestUrl)
  }
  if (request.provider?.sourceProviderId !== 'ollama') return false
  if (hasOllamaMessagesPath(request.requestUrl)) return true
  return hasOllamaCompatChatCompletionsPath(request.requestUrl)
}

async function touchOllamaKeepAlive(ollamaBaseUrl, keepAliveTime, model, apiKey) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const normalizedOllamaBaseUrl = normalizeBaseUrlWithoutVersionSuffix(
      ollamaBaseUrl,
      'http://127.0.0.1:11434',
    )
    return await fetch(`${normalizedOllamaBaseUrl}/api/generate`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        prompt: 't',
        options: {
          num_predict: 1,
        },
        keep_alive: keepAliveTime === '-1' ? -1 : keepAliveTime,
      }),
    })
  } catch (error) {
    if (error?.name === 'AbortError') return null
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithGptCompletionApi(port, question, session, apiKey) {
  const config = await getUserConfig()
  const openAiBaseUrl = normalizeBaseUrlWithoutVersionSuffix(
    config.customOpenAiApiUrl,
    'https://api.openai.com',
  )
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: 'completion',
    requestUrl: `${openAiBaseUrl}/v1/completions`,
    model: getModelValue(session),
    apiKey,
    config,
  })
}

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithOpenAiApi(port, question, session, apiKey) {
  const config = await getUserConfig()
  const openAiBaseUrl = normalizeBaseUrlWithoutVersionSuffix(
    config.customOpenAiApiUrl,
    'https://api.openai.com',
  )
  return generateAnswersWithOpenAiApiCompat(
    `${openAiBaseUrl}/v1`,
    port,
    question,
    session,
    apiKey,
    {},
    'openai',
    config,
  )
}

export async function generateAnswersWithOpenAiApiCompat(
  baseUrl,
  port,
  question,
  session,
  apiKey,
  extraBody = {},
  provider = 'compat',
  config = null,
) {
  const runtimeConfig = await resolveOpenAICompatibleRuntimeConfig(config)
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: 'chat',
    requestUrl: `${normalizeBaseUrl(baseUrl)}/chat/completions`,
    model: getModelValue(session),
    apiKey,
    config: runtimeConfig,
    extraBody,
    provider,
  })
}

/**
 * Unified entry point for OpenAI-compatible providers.
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {UserConfig} config
 */
export async function generateAnswersWithOpenAICompatibleApi(port, question, session, config) {
  return withAbortController(port, (abortContext) =>
    generateOpenAICompatibleRequest(port, question, session, config, abortContext),
  )
}

async function generateOpenAICompatibleRequest(port, question, session, config, abortContext) {
  const runtimeConfig = await resolveOpenAICompatibleRuntimeConfig(config)
  if (abortContext.controller.signal.aborted) return
  const request = resolveOpenAICompatibleRequest(runtimeConfig, session)
  if (!request) {
    const diagnostic = getOpenAICompatibleRequestDiagnostic(runtimeConfig, session)
    console.warn('[openai-compatible] Failed to resolve provider request', diagnostic)
    throw new Error(buildOpenAICompatibleResolutionErrorMessage(diagnostic))
  }
  const model = resolveModelName(session, runtimeConfig)
  const providerRequestShapingId = resolveProviderRequestShapingId(request)
  let completedRequest = request
  if (shouldUseResponsesProtocol(request, runtimeConfig, session)) {
    const responsesRequestUrl = resolveResponsesRequestUrl(request)
    try {
      await generateAnswersWithOpenAIResponses({
        abortContext,
        port,
        question,
        session,
        requestUrl: responsesRequestUrl,
        model,
        apiKey: request.apiKey,
        config: runtimeConfig,
        provider: providerRequestShapingId,
        extraHeaders: getOpenRouterAttributionHeaders(responsesRequestUrl),
      })
    } catch (error) {
      if (abortContext.controller.signal.aborted) return
      if (!shouldFallbackToChatCompletions(error)) throw error
      if (!request.chatCompletionsUrl) throw error
      const fallbackChatUrl = request.chatCompletionsUrl
      try {
        if (!['http:', 'https:'].includes(new URL(fallbackChatUrl).protocol)) throw error
      } catch {
        throw error
      }
      console.warn(
        '[openai-compatible] Responses API unsupported, falling back to Chat Completions',
        { requestUrl: responsesRequestUrl, error },
      )
      const fallbackRequest = { ...request, requestUrl: fallbackChatUrl }
      assertSupportedChatEndpoint(fallbackRequest.requestUrl)
      await generateAnswersWithOpenAICompatible({
        abortContext,
        port,
        question,
        session,
        endpointType: request.endpointType,
        requestUrl: fallbackRequest.requestUrl,
        model,
        apiKey: request.apiKey,
        config: runtimeConfig,
        provider: resolveProviderRequestShapingId(fallbackRequest),
        extraHeaders: getOpenRouterAttributionHeaders(fallbackRequest.requestUrl),
        allowLegacyResponseField: request.provider.allowLegacyResponseField,
      })
      completedRequest = fallbackRequest
    }
  } else {
    assertSupportedChatEndpoint(request.requestUrl)
    await generateAnswersWithOpenAICompatible({
      abortContext,
      port,
      question,
      session,
      endpointType: request.endpointType,
      requestUrl: request.requestUrl,
      model,
      apiKey: request.apiKey,
      config: runtimeConfig,
      provider: providerRequestShapingId,
      extraHeaders: getOpenRouterAttributionHeaders(request.requestUrl),
      allowLegacyResponseField: request.provider.allowLegacyResponseField,
    })
  }

  if (!abortContext.controller.signal.aborted && shouldSendOllamaKeepAlive(completedRequest)) {
    const ollamaKeepAliveBaseUrl = resolveOllamaKeepAliveBaseUrl(completedRequest)
    await touchOllamaKeepAlive(
      ollamaKeepAliveBaseUrl,
      runtimeConfig.ollamaKeepAliveTime,
      model,
      request.apiKey,
    ).catch((error) => {
      console.warn('Ollama keep_alive request failed:', error)
    })
  }
}
