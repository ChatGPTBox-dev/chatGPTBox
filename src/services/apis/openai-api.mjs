import { getUserConfig } from '../../config/index.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { generateAnswersWithOpenAICompatible } from './openai-compatible-core.mjs'
import { resolveOpenAICompatibleRequest } from './provider-registry.mjs'

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
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

async function touchOllamaKeepAlive(config, model, apiKey) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    return await fetch(`${normalizeBaseUrl(config.ollamaEndpoint)}/api/generate`, {
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
        keep_alive: config.ollamaKeepAliveTime === '-1' ? -1 : config.ollamaKeepAliveTime,
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
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: 'completion',
    requestUrl: `${normalizeBaseUrl(config.customOpenAiApiUrl)}/v1/completions`,
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
export async function generateAnswersWithChatgptApi(port, question, session, apiKey) {
  const config = await getUserConfig()
  return generateAnswersWithChatgptApiCompat(
    `${normalizeBaseUrl(config.customOpenAiApiUrl)}/v1`,
    port,
    question,
    session,
    apiKey,
    {},
    'openai',
  )
}

export async function generateAnswersWithChatgptApiCompat(
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
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: request.endpointType,
    requestUrl: request.requestUrl,
    model,
    apiKey: request.apiKey,
    provider: request.providerId,
    allowLegacyResponseField: request.provider.allowLegacyResponseField,
  })

  if (request.providerId === 'ollama') {
    await touchOllamaKeepAlive(config, model, request.apiKey).catch((error) => {
      console.warn('Ollama keep_alive request failed:', error)
    })
  }
}
