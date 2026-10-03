import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty } from 'lodash-es'
import { getCompletionPromptBase, pushRecord, setAbortController } from './shared.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'
import { getTemperatureParams } from './temperature-params.mjs'
import { splitInlineReasoning } from './inline-reasoning.mjs'

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

function hasFinished(data) {
  return Boolean(data?.choices?.[0]?.finish_reason)
}

/**
 * Reasoning models put their thinking in their own field rather than in the content, and
 * deliberately do not replay it in context. Surfacing it separately keeps it out of the
 * conversation records.
 */
function getReasoningDelta(data) {
  const delta = data?.choices?.[0]?.delta
  const reasoning = delta?.reasoning_content ?? delta?.reasoning
  return typeof reasoning === 'string' ? reasoning : ''
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
  }

  let answer = ''
  let reasoning = ''
  let postedAnswer = ''
  let postedReasoning = ''
  let finished = false

  // The answer channel may carry the thinking itself, wrapped in a leading <think>-style
  // block, instead of (or alongside) a dedicated reasoning field; both sources reach the
  // reader as reasoning and stay out of the conversation records.
  const resolveStreamText = () => {
    const inline = splitInlineReasoning(answer)
    return {
      // A block that never closed is thinking that was cut off mid-thought, so it is not an
      // answer either: recording it would send the model its own unfinished reasoning back.
      answer: inline.answer,
      reasoning: [reasoning, inline.reasoning].filter(Boolean).join('\n\n'),
    }
  }

  const postStreamText = () => {
    const streamText = resolveStreamText()
    if (streamText.answer !== postedAnswer) {
      postedAnswer = streamText.answer
      port.postMessage({ answer: streamText.answer, done: false, session: null })
    }
    if (streamText.reasoning && streamText.reasoning !== postedReasoning) {
      postedReasoning = streamText.reasoning
      port.postMessage({ reasoning: streamText.reasoning, done: false, session: null })
    }
  }

  const finish = () => {
    if (finished) return
    finished = true
    const { answer: finalAnswer, reasoning: finalReasoning } = resolveStreamText()
    // A turn that was nothing but thinking has no answer to record; keeping it out of the
    // records is what stops the model from being sent its own unfinished reasoning back as
    // context. A plain empty answer is still recorded, as it always has been.
    if (finalAnswer || !finalReasoning) pushRecord(session, question, finalAnswer)
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

      const reasoningDelta = getReasoningDelta(data)
      if (reasoningDelta) reasoning += reasoningDelta
      answer = buildMessageAnswer(answer, data, allowLegacyResponseField)
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
            const streamText = resolveStreamText()
            const shouldPostSession = Boolean(streamText.answer) || session.isRetry
            if (shouldPostSession && isCurrentSessionRequest()) {
              if (streamText.answer) {
                pushRecord(session, question, streamText.answer)
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
      const error = await resp.json().catch(() => ({}))
      throw new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
    },
  })
}
