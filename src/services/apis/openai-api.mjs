import { getUserConfig } from '../../config/index.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { generateAnswersWithOpenAICompatible } from './openai-compatible-core.mjs'
import { resolveOpenAICompatibleRequest } from './provider-registry.mjs'

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

function hasOllamaNativeChatPath(requestUrl) {
  const normalizedRequestUrl = normalizeBaseUrl(requestUrl)
  if (!normalizedRequestUrl) return false
  try {
    const parsedRequestUrl = new URL(normalizedRequestUrl)
    const normalizedPathname = parsedRequestUrl.pathname.replace(/\/+$/, '') || '/'
    return (
      /(^|\/)api\/chat$/i.test(normalizedPathname) ||
      /(^|\/)v1\/messages$/i.test(normalizedPathname)
    )
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
    return hasOllamaNativeChatPath(request.requestUrl)
  }
  if (request.provider?.sourceProviderId !== 'ollama') return false
  if (hasOllamaNativeChatPath(request.requestUrl)) return true
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
) {
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: 'chat',
    requestUrl: `${normalizeBaseUrl(baseUrl)}/chat/completions`,
    model: getModelValue(session),
    apiKey,
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
  const request = resolveOpenAICompatibleRequest(config, session)
  if (!request) {
    throw new Error('Unknown OpenAI-compatible provider configuration')
  }

  const model = resolveModelName(session, config)
  const providerRequestShapingId = resolveProviderRequestShapingId(request)
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: request.endpointType,
    requestUrl: request.requestUrl,
    model,
    apiKey: request.apiKey,
    provider: providerRequestShapingId,
    allowLegacyResponseField: request.provider.allowLegacyResponseField,
  })

  if (shouldSendOllamaKeepAlive(request)) {
    const ollamaKeepAliveBaseUrl = resolveOllamaKeepAliveBaseUrl(request)
    await touchOllamaKeepAlive(
      ollamaKeepAliveBaseUrl,
      config.ollamaKeepAliveTime,
      model,
      request.apiKey,
    ).catch((error) => {
      console.warn('Ollama keep_alive request failed:', error)
    })
  }
}
