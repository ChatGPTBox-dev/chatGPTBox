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

  // Reasoning that arrives through its own field wins. Providers that put the thinking in
  // the answer instead (a leading <think>-style block) get the same treatment, so it is
  // shown as reasoning and stays out of the conversation records.
  const resolveStreamText = ({ final = false } = {}) => {
    if (reasoning) return { answer, reasoning }
    const inline = splitInlineReasoning(answer)
    // A block that never closed is only thinking while the stream is still running. Once it
    // has ended the text is kept as the answer, so a response truncated mid-thinking (or an
    // answer that merely starts with a tag) is not lost from the conversation.
    if (final && inline.unclosed) return { answer, reasoning: '' }
    return { answer: inline.answer, reasoning: inline.reasoning }
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
    // Finalisation only ever differs from what was streamed by no longer treating an
    // unclosed block as thinking. The card already shows that text in its thinking block,
    // so it is recorded here without being posted again as an answer — sending it would
    // make the renderer show the same thinking twice.
    pushRecord(session, question, resolveStreamText({ final: true }).answer)
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
            const streamText = resolveStreamText({ final: true })
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
