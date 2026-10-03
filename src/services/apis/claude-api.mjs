import { getUserConfig } from '../../config/index.mjs'
import {
  createApiResponseError,
  parseJsonMessage,
  pushRecord,
  setAbortController,
} from './shared.mjs'
import { FETCH_RESPONSE_STREAM_FAILED, fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { getTemperatureParams } from './temperature-params.mjs'

function getThinkingConfig(model) {
  if (model === 'claude-sonnet-5') return { type: 'disabled' }
  if (model === 'claude-sonnet-5-5') return { type: 'between_tools' }
}

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithClaudeApi(port, question, session) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)
  const config = await getUserConfig()
  const apiUrl = config.customAnthropicApiUrl
  const model = getModelValue(session)

  const prompt = getConversationPairs(
    session.conversationRecords.slice(-config.maxConversationContextLength),
    false,
  )
  prompt.push({ role: 'user', content: question })

  const body = {
    model,
    messages: prompt,
    stream: true,
    max_tokens: config.maxResponseTokenLength,
    ...getTemperatureParams(config, model),
  }
  const thinking = getThinkingConfig(model)
  if (thinking) body.thinking = thinking

  let answer = ''
  let reasoning = ''
  let stopReason = ''
  let completionError
  let wasAborted = false
  let completedSuccessfully = false
  const streamError = await fetchSSE(`${apiUrl}/v1/messages`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': config.anthropicApiKey,
      'anthropic-dangerous-direct-browser-access': true,
    },
    body: JSON.stringify(body),
    onMessage(message) {
      console.debug('sse message', message)

      const data = parseJsonMessage(message)
      if (data === undefined) return
      if (data?.type === 'error') {
        controller.abort()
        const error = new Error(JSON.stringify(data))
        if (completedSuccessfully) error.code = FETCH_RESPONSE_STREAM_FAILED
        throw error
      }
      if (completedSuccessfully) return
      if (data?.type === 'message_delta') {
        stopReason = data?.delta?.stop_reason || stopReason
        return
      }
      if (data?.type === 'message_stop') {
        if (stopReason === 'max_tokens') {
          completionError = new Error(
            'Claude reached the response token limit. Increase Max Response Token Length and try again.',
          )
        }
        if (stopReason === 'model_context_window_exceeded') {
          completionError = new Error(
            'Claude reached the model context window limit. Clear the conversation and try again.',
          )
        }
        if (stopReason === 'refusal') {
          completionError = new Error('Claude declined to respond to this request.')
        }
        if (!completionError && !['end_turn', 'stop_sequence'].includes(stopReason)) {
          completionError = new Error('Claude response stream ended before completion.')
        }
        if (completionError) {
          controller.abort()
          throw completionError
        }
        pushRecord(session, question, answer)
        console.debug('conversation history', { content: session.conversationRecords })
        port.postMessage({ answer: null, done: true, session: session })
        completedSuccessfully = true
        return
      }

      // Extended thinking arrives as its own delta type. It is shown as reasoning and never
      // recorded as the answer, exactly like the reasoning field of an OpenAI-compatible API.
      const thinkingDelta = data?.delta?.thinking
      if (typeof thinkingDelta === 'string' && thinkingDelta) {
        reasoning += thinkingDelta
        port.postMessage({ reasoning, done: false, session: null })
      }

      const delta = data?.delta?.text
      if (delta) {
        answer += delta
        port.postMessage({ answer: answer, done: false, session: null })
      }
    },
    async onStart() {},
    async onEnd(aborted) {
      wasAborted = aborted
      try {
        port.onMessage.removeListener(messageListener)
      } finally {
        port.onDisconnect.removeListener(disconnectListener)
      }
    },
    async onError(resp) {
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
      if (resp instanceof Error) throw resp
      throw await createApiResponseError(resp)
    },
  }).catch((error) => error)
  if (wasAborted) return
  if (completionError) throw completionError
  if (
    streamError &&
    (!completedSuccessfully || streamError.code !== FETCH_RESPONSE_STREAM_FAILED)
  ) {
    throw streamError
  }
  if (!completedSuccessfully) {
    throw new Error('Claude response stream ended before completion.')
  }
}
