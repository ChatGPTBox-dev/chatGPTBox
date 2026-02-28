// custom api version

// There is a lot of duplicated code here, but it is very easy to refactor.
// The current state is mainly convenient for making targeted changes at any time,
// and it has not yet had a negative impact on maintenance.
// If necessary, I will refactor.

import { getUserConfig } from '../../config/index.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty } from 'lodash-es'
import { pushRecord, setAbortController } from './shared.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} modelName
 */
export async function generateAnswersWithCustomApi(
  port,
  question,
  session,
  apiUrl,
  apiKey,
  modelName,
) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)

  const config = await getUserConfig()
  const prompt = getConversationPairs(
    session.conversationRecords.slice(-config.maxConversationContextLength),
    false,
  )
  prompt.push({ role: 'user', content: question })

  let answer = ''
  let finished = false

  let with_reasoning = false
  let has_reasoning_start = false
  let has_reasoning_end = false

  const REASONING_START_SIGN = '[Think]\n\n'
  const REASONING_END_SIGN = '\n\n[Response]\n\n'

  const finish = () => {
    finished = true
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: null, done: true, session: session })
  }
  await fetchSSE(apiUrl, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: prompt,
      model: modelName,
      stream: true,
      ...getChatCompletionsTokenParams('custom', modelName, config.maxResponseTokenLength),
      temperature: config.temperature,
    }),
    onMessage(message) {
      console.debug('sse message', message)
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

      if (data.response) answer = data.response
      else {
        const delta = data.choices[0]?.delta?.content
        const delta_reasoning = data.choices[0]?.delta?.reasoning_content
        const content = data.choices[0]?.message?.content
        const content_reasoning = data.choices[0]?.message?.reasoning_content
        const text = data.choices[0]?.text
        if (delta !== undefined) {
          // streaming handling
          if (delta_reasoning) {
            with_reasoning = true
            if (!has_reasoning_start) {
              answer += REASONING_START_SIGN
              has_reasoning_start = true
            }
            answer += delta_reasoning
          }
          if (delta) {
            if (with_reasoning && !has_reasoning_end) {
              answer += REASONING_END_SIGN
              has_reasoning_end = true
            }
            answer += delta
          }
        } else if (content) {
          // single response handling
          if (content_reasoning) {
            answer = REASONING_START_SIGN + content_reasoning + REASONING_END_SIGN + content
          } else {
            answer = content
          }
        } else if (text) {
          answer += text
        }
      }
      port.postMessage({ answer: answer, done: false, session: null })

      if (data.choices[0]?.finish_reason) {
        finish()
        return
      }
    },
    async onStart() {},
    async onEnd() {
      port.postMessage({ done: true })
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
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
