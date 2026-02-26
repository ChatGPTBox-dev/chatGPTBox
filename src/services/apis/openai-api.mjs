import { getUserConfig } from '../../config/index.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { generateAnswersWithOpenAICompatible } from './openai-compatible-core.mjs'
import {
  getOpenAICompatibleRequestDiagnostic,
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
  'temperature',
]

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
  const runtimeConfig = await resolveOpenAICompatibleRuntimeConfig(config)
  const request = resolveOpenAICompatibleRequest(runtimeConfig, session)
  if (!request) {
    const diagnostic = getOpenAICompatibleRequestDiagnostic(runtimeConfig, session)
    console.warn('[openai-compatible] Failed to resolve provider request', diagnostic)
    throw new Error(buildOpenAICompatibleResolutionErrorMessage(diagnostic))
  }
  if (hasNativeOllamaChatApiPath(request.requestUrl)) {
    throw new Error(
      'Unsupported native Ollama chat endpoint. Use the OpenAI-compatible /v1/chat/completions endpoint instead.',
    )
  }

  const model = resolveModelName(session, runtimeConfig)
  const providerRequestShapingId = resolveProviderRequestShapingId(request)
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: request.endpointType,
    requestUrl: request.requestUrl,
    model,
    apiKey: request.apiKey,
    config: runtimeConfig,
    provider: providerRequestShapingId,
    allowLegacyResponseField: request.provider.allowLegacyResponseField,
  })

  if (shouldSendOllamaKeepAlive(request)) {
    const ollamaKeepAliveBaseUrl = resolveOllamaKeepAliveBaseUrl(request)
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
