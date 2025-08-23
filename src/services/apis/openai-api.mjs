// api version

import { getUserConfig } from '../../config/index.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty } from 'lodash-es'
import { getCompletionPromptBase, pushRecord, setAbortController } from './shared.mjs'
import { getModelValue, isUsingO1Model } from '../../utils/model-name-convert.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithGptCompletionApi(port, question, session, apiKey) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)
  const model = getModelValue(session)

  const config = await getUserConfig()
  const prompt =
    (await getCompletionPromptBase()) +
    getConversationPairs(
      session.conversationRecords.slice(-config.maxConversationContextLength),
      true,
    ) +
    `Human: ${question}\nAI: `
  const apiUrl = config.customOpenAiApiUrl

  let answer = ''
  let finished = false
  const finish = () => {
    finished = true
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: null, done: true, session: session })
  }
  await fetchSSE(`${apiUrl}/v1/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      prompt: prompt,
      model,
      stream: true,
      max_tokens: config.maxResponseTokenLength,
      temperature: config.temperature,
      stop: '\nHuman',
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

      const choice = data.choices?.[0]
      if (!choice) {
        console.debug('No choice in response data')
        return
      }

      answer += choice.text
      port.postMessage({ answer: answer, done: false, session: null })

      if (choice.finish_reason) {
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

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithChatgptApi(port, question, session, apiKey) {
  const config = await getUserConfig()
  return generateAnswersWithChatgptApiCompat(
    config.customOpenAiApiUrl + '/v1',
    port,
    question,
    session,
    apiKey,
  )
}

export async function generateAnswersWithChatgptApiCompat(
  baseUrl,
  port,
  question,
  session,
  apiKey,
  extraBody = {},
) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)
  const model = getModelValue(session)
  const isO1Model = isUsingO1Model(session)

  const config = await getUserConfig()
  const prompt = getConversationPairs(
    session.conversationRecords.slice(-config.maxConversationContextLength),
    false,
  )

  // Filter out system messages for o1 models (only user and assistant are allowed)
  const filteredPrompt = isO1Model
    ? prompt.filter((msg) => msg.role === 'user' || msg.role === 'assistant')
    : prompt

  filteredPrompt.push({ role: 'user', content: question })

  let answer = ''
  let finished = false
  const finish = () => {
    finished = true
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: null, done: true, session: session })
  }

  // Build request body with o1-specific parameters
  const requestBody = {
    messages: filteredPrompt,
    model,
    ...extraBody,
  }

  if (isO1Model) {
    // o1 models use max_completion_tokens instead of max_tokens
    requestBody.max_completion_tokens = config.maxResponseTokenLength
    // o1 models don't support streaming during beta
    requestBody.stream = false
    // o1 models have fixed parameters during beta
    requestBody.temperature = 1
    requestBody.top_p = 1
    requestBody.n = 1
    requestBody.presence_penalty = 0
    requestBody.frequency_penalty = 0
  } else {
    // Non-o1 models use the existing behavior
    requestBody.stream = true
    requestBody.max_tokens = config.maxResponseTokenLength
    requestBody.temperature = config.temperature
  }

  await fetchSSE(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
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

      if (isO1Model) {
        // For o1 models (non-streaming), get the complete response
        const choice = data.choices?.[0]
        if (!choice) {
          console.debug('No choice in response data for o1 model')
          return
        }
        const content = choice.message?.content
        if (content) {
          answer = content
          port.postMessage({ answer: answer, done: false, session: null })
          finish()
        }
      } else {
        // For non-o1 models (streaming), handle delta content
        const choice = data.choices?.[0]
        if (!choice) {
          console.debug('No choice in response data')
          return
        }
        const delta = choice.delta?.content
        const content = choice.message?.content
        const text = choice.text
        if (delta !== undefined) {
          answer += delta
        } else if (content) {
          answer = content
        } else if (text) {
          answer += text
        }
        port.postMessage({ answer: answer, done: false, session: null })

        if (choice.finish_reason) {
          finish()
          return
        }
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
