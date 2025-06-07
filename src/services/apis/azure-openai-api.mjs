import { getUserConfig } from '../../config/index.mjs'
import { pushRecord, setAbortController } from './shared.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { isEmpty } from 'lodash-es'
import { getModelValue } from '../../utils/model-name-convert.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithAzureOpenaiApi(port, question, session) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)
  const config = await getUserConfig()
  let model = getModelValue(session)
  if (!model) model = config.azureDeploymentName

  const prompt = getConversationPairs(
    session.conversationRecords.slice(-config.maxConversationContextLength),
    false,
  )
  prompt.push({ role: 'user', content: question })

  let answer = ''
  await fetchSSE(
    `${config.azureEndpoint.replace(
      /\/$/,
      '',
    )}/openai/deployments/${model}/chat/completions?api-version=2024-02-01`,
    {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.azureApiKey,
      },
      body: JSON.stringify({
        messages: prompt,
        stream: true,
        max_tokens: config.maxResponseTokenLength,
        temperature: config.temperature,
        presence_penalty: config.presence_penalty,
        frequency_penalty: config.frequency_penalty,
      }),
      onMessage(message) {
        console.debug('sse message', message)
        let data
        try {
          data = JSON.parse(message)
        } catch (error) {
          console.debug('json error', error)
          return
        }
        if (
          data.choices &&
          data.choices.length > 0 &&
          data.choices[0] &&
          data.choices[0].delta &&
          'content' in data.choices[0].delta
        ) {
          answer += data.choices[0].delta.content
          port.postMessage({ answer: answer, done: false, session: null })
        }

        if (data.choices && data.choices.length > 0 && data.choices[0]?.finish_reason) {
          pushRecord(session, question, answer)
          console.debug('conversation history', { content: session.conversationRecords })
          port.postMessage({ answer: null, done: true, session: session })
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
        throw new Error(
          !isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`,
        )
      },
    },
  )
}
