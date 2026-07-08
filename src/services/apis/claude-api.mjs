import { getUserConfig } from '../../config/index.mjs'
import { pushRecord, setAbortController } from './shared.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { isEmpty } from 'lodash-es'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'

function shouldOmitTemperature(model) {
  return model === 'claude-opus-4-7' || model === 'claude-opus-4-8' || model === 'claude-sonnet-5'
}

function shouldDisableDefaultThinking(model) {
  return model === 'claude-sonnet-5'
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
  }
  if (shouldDisableDefaultThinking(model)) {
    body.thinking = { type: 'disabled' }
  }
  if (!shouldOmitTemperature(model)) {
    body.temperature = config.temperature
  }

  let answer = ''
  await fetchSSE(`${apiUrl}/v1/messages`, {
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

      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        console.debug('json error', error)
        return
      }
      if (data?.type === 'message_stop') {
        pushRecord(session, question, answer)
        console.debug('conversation history', { content: session.conversationRecords })
        port.postMessage({ answer: null, done: true, session: session })
        return
      }

      const delta = data?.delta?.text
      if (delta) {
        answer += delta
        port.postMessage({ answer: answer, done: false, session: null })
      }
    },
    async onStart() {},
    async onEnd(aborted) {
      try {
        if (!aborted) {
          port.postMessage({ done: true })
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
