import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty } from 'lodash-es'
import { getCompletionPromptBase, pushRecord, setAbortController } from './shared.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'
import { getTemperatureParams } from './temperature-params.mjs'
import { mergeOpenAIResponseMetadata } from '../../utils/usage-metadata.mjs'

function buildHeaders(apiKey, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function buildMessageAnswer(answer, data, allowLegacyResponseField) {
  if (allowLegacyResponseField && typeof data?.response === 'string' && data.response) {
    return data.response
  }

  const delta = data?.choices?.[0]?.delta?.content
  const content = data?.choices?.[0]?.message?.content
  const text = data?.choices?.[0]?.text
  if (typeof delta === 'string') return answer + delta
  if (typeof content === 'string' && content) return content
  if (typeof text === 'string' && text) return answer + text
  return answer
}

function hasMessageAnswerField(data, allowLegacyResponseField) {
  if (allowLegacyResponseField && typeof data?.response === 'string') return true

  const choice = data?.choices?.[0]
  return (
    typeof choice?.delta?.content === 'string' ||
    typeof choice?.message?.content === 'string' ||
    typeof choice?.text === 'string'
  )
}

function hasFinished(data) {
  return Boolean(data?.choices?.[0]?.finish_reason)
}

function getRequestUrl(requestUrl) {
  try {
    return new URL(requestUrl)
  } catch {
    return null
  }
}

function isNativeOpenAIChatCompletionsRequest(requestUrl, endpointType) {
  if (endpointType !== 'chat') return false
  const url = getRequestUrl(requestUrl)
  if (!url || url.hostname.toLowerCase() !== 'api.openai.com') return false
  return url.pathname.replace(/\/+$/, '') === '/v1/chat/completions'
}

function isOpenRouterRequest(requestUrl, provider) {
  if (provider === 'openrouter') return true
  return getRequestUrl(requestUrl)?.origin === 'https://openrouter.ai'
}

/**
 * @param {object} params
 * @param {Browser.Runtime.Port} params.port
 * @param {string} params.question
 * @param {Session} params.session
 * @param {'chat'|'completion'} params.endpointType
 * @param {string} params.requestUrl
 * @param {string} params.model
 * @param {string} params.apiKey
 * @param {UserConfig} params.config
 * @param {string} [params.provider]
 * @param {Record<string, any>} [params.extraBody]
 * @param {Record<string, string>} [params.extraHeaders]
 * @param {boolean} [params.allowLegacyResponseField]
 */
export async function generateAnswersWithOpenAICompatible({
  port,
  question,
  session,
  endpointType,
  requestUrl,
  model,
  apiKey,
  config,
  provider = 'compat',
  extraBody = {},
  extraHeaders = {},
  allowLegacyResponseField = false,
}) {
  const {
    controller,
    messageListener,
    disconnectListener,
    getStopGenerationId,
    isCurrentSessionRequest,
  } = setAbortController(port)

  let requestBody
  const conversationRecords = Array.isArray(session.conversationRecords)
    ? session.conversationRecords
    : []
  session.conversationRecords = conversationRecords
  const safeExtraBody = { ...extraBody }
  delete safeExtraBody.temperature
  if (endpointType === 'completion') {
    const prompt =
      (await getCompletionPromptBase()) +
      getConversationPairs(conversationRecords.slice(-config.maxConversationContextLength), true) +
      `Human: ${question}\nAI: `
    requestBody = {
      prompt,
      model,
      stream: true,
      max_tokens: config.maxResponseTokenLength,
      ...getTemperatureParams(config, model),
      stop: '\nHuman',
      ...safeExtraBody,
    }
  } else {
    const messages = getConversationPairs(
      conversationRecords.slice(-config.maxConversationContextLength),
      false,
    )
    messages.push({ role: 'user', content: question })
    const tokenParams = getChatCompletionsTokenParams(
      provider,
      model,
      config.maxResponseTokenLength,
    )
    const conflictingTokenParamKey =
      'max_completion_tokens' in tokenParams ? 'max_tokens' : 'max_completion_tokens'
    delete safeExtraBody[conflictingTokenParamKey]
    requestBody = {
      messages,
      model,
      stream: true,
      ...tokenParams,
      ...getTemperatureParams(config, model),
      ...safeExtraBody,
    }
    if (isNativeOpenAIChatCompletionsRequest(requestUrl, endpointType)) {
      requestBody.stream_options = {
        ...(requestBody.stream_options && typeof requestBody.stream_options === 'object'
          ? requestBody.stream_options
          : {}),
        include_usage: true,
      }
    }
  }

  let answer = ''
  let responseMetadata = null
  let sawFinishReason = false
  let finished = false
  const waitForFinalUsage =
    isNativeOpenAIChatCompletionsRequest(requestUrl, endpointType) ||
    isOpenRouterRequest(requestUrl, provider)
  const finish = () => {
    if (finished) return
    finished = true
    pushRecord(session, question, answer, responseMetadata)
    port.postMessage({ answer: null, done: true, session: session })
  }

  await fetchSSE(requestUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: buildHeaders(apiKey, extraHeaders),
    body: JSON.stringify(requestBody),
    onMessage(message) {
      if (finished) return
      if (message.trim() === '[DONE]') {
        finish()
        return
      }
      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        console.debug('json error', error)
        return
      }

      responseMetadata = mergeOpenAIResponseMetadata(responseMetadata, data, model)
      const previousAnswer = answer
      const hasAnswerField = hasMessageAnswerField(data, allowLegacyResponseField)
      answer = buildMessageAnswer(answer, data, allowLegacyResponseField)
      if (answer !== previousAnswer || hasAnswerField) {
        port.postMessage({ answer: answer, done: false, session: null })
      }

      const chunkFinished = hasFinished(data)
      const hasUsage = Boolean(data?.usage && typeof data.usage === 'object')
      if (chunkFinished) sawFinishReason = true
      if (chunkFinished && (!waitForFinalUsage || hasUsage)) {
        finish()
      } else if (sawFinishReason && waitForFinalUsage && hasUsage) {
        finish()
      }
    },
    async onStart() {},
    async onEnd(aborted = false) {
      try {
        if (!finished) {
          if (aborted) {
            const shouldPostSession = Boolean(answer) || session.isRetry
            if (shouldPostSession && isCurrentSessionRequest()) {
              if (answer) {
                pushRecord(session, question, answer, responseMetadata)
              }
              session.isRetry = false
              try {
                const stoppedGenerationId = getStopGenerationId()
                port.postMessage({
                  session,
                  done: true,
                  ...(stoppedGenerationId === undefined ? {} : { stoppedGenerationId }),
                })
              } catch (e) {
                console.warn('[openai-compatible-core] Failed to post session on abort:', e)
              }
            }
          } else {
            finish()
          }
        }
      } finally {
        port.onMessage.removeListener(messageListener)
        port.onDisconnect.removeListener(disconnectListener)
      }
    },
    async onError(resp) {
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
      if (sawFinishReason && waitForFinalUsage) {
        finish()
        return
      }
      if (resp instanceof Error) throw resp
      const error = await resp.json().catch(() => ({}))
      throw new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
    },
  })
}
