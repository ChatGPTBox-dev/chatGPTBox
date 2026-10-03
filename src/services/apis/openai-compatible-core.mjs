import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import {
  createApiResponseError,
  getCompletionPromptBase,
  parseJsonMessage,
  pushRecord,
  setAbortController,
} from './shared.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'
import { getTemperatureParams } from './temperature-params.mjs'

function buildHeaders(apiKey, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/**
 * The answer carried by one response payload. Chat completions and legacy completions put
 * the text in different places, and content that is not a plain string is ignored rather
 * than coerced, so a stray object can never reach the card.
 */
function appendAnswerChunk(answer, data, allowLegacyResponseField) {
  if (allowLegacyResponseField && typeof data?.response === 'string' && data.response) {
    return data.response
  }

  const choice = data?.choices?.[0]
  const delta = choice?.delta?.content
  if (typeof delta === 'string') return answer + delta

  // A non-streaming body, or a provider that sends the full message, replaces the answer.
  const content = choice?.message?.content
  if (typeof content === 'string' && content) return content

  const text = choice?.text
  if (typeof text === 'string' && text) return answer + text

  return answer
}

/**
 * The thinking a reasoning model keeps out of its content: DeepSeek's `reasoning_content`,
 * OpenRouter-style `reasoning`, or a whole non-streaming message. It is read verbatim, so
 * nothing is parsed out of, or into, the answer.
 */
function readReasoningChunk(data) {
  const choice = data?.choices?.[0]
  const delta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
  if (typeof delta === 'string' && delta) return { text: delta, replace: false }

  const message = choice?.message?.reasoning_content ?? choice?.message?.reasoning
  if (typeof message === 'string' && message) return { text: message, replace: true }

  return null
}

function hasFinished(data) {
  return Boolean(data?.choices?.[0]?.finish_reason)
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
  // Azure deployments are addressed by the URL, not by the body, so an empty model means
  // "send none" rather than "send an empty string".
  const modelParam = model ? { model } : {}
  if (endpointType === 'completion') {
    const prompt =
      (await getCompletionPromptBase()) +
      getConversationPairs(conversationRecords.slice(-config.maxConversationContextLength), true) +
      `Human: ${question}\nAI: `
    requestBody = {
      prompt,
      ...modelParam,
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
      ...modelParam,
      stream: true,
      ...tokenParams,
      ...getTemperatureParams(config, model),
      ...safeExtraBody,
    }
  }

  let answer = ''
  let reasoning = ''
  let postedAnswer = ''
  let postedReasoning = ''
  let finished = false

  // The thinking is whatever the reasoning field carried; the content channel is the answer,
  // verbatim. Nothing is parsed out of the answer, so a model or a reader that writes a
  // "<think>" tag is writing text, and the renderer shows it as such.
  const postStreamText = () => {
    if (answer !== postedAnswer) {
      postedAnswer = answer
      port.postMessage({ answer, done: false, session: null })
    }
    if (reasoning && reasoning !== postedReasoning) {
      postedReasoning = reasoning
      port.postMessage({ reasoning, done: false, session: null })
    }
  }

  const finish = () => {
    if (finished) return
    finished = true
    // A turn that was nothing but thinking has no answer to record; keeping it out of the
    // records is what stops the model from being sent its own unfinished reasoning back as
    // context. A plain empty answer is still recorded, as it always has been.
    if (answer || !reasoning) pushRecord(session, question, answer)
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
      const data = parseJsonMessage(message)
      if (data === undefined) return

      const reasoningChunk = readReasoningChunk(data)
      if (reasoningChunk) {
        // A delta grows the thinking; a full message that replaces the content replaces it too.
        reasoning = reasoningChunk.replace ? reasoningChunk.text : reasoning + reasoningChunk.text
      }
      answer = appendAnswerChunk(answer, data, allowLegacyResponseField)
      // A chunk can carry reasoning only; an unchanged answer is not posted again.
      postStreamText()

      if (hasFinished(data)) {
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
                pushRecord(session, question, answer)
              }
              session.isRetry = false
              try {
                const stoppedGenerationId = getStopGenerationId()
                port.postMessage({
                  session,
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
      if (resp instanceof Error) throw resp
      throw await createApiResponseError(resp)
    },
  })
}
