import { getUserConfig } from '../../config/index.mjs'
import { createAdapterDiagnostics, pushRecord, setAbortController } from './shared.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { isEmpty } from 'lodash-es'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { getTemperatureParams } from './temperature-params.mjs'

const CONTEXT_PROVIDER_CODES = new Set([
  'context_length_exceeded',
  'model_context_window_exceeded',
  'prompt_too_long',
])

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithAzureOpenaiApi(
  port,
  question,
  session,
  configOverride,
  adapterOptions,
) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)
  const config = configOverride || (await getUserConfig())
  const diagnostics = createAdapterDiagnostics(adapterOptions)
  let deploymentName = getModelValue(session)
  if (!deploymentName) deploymentName = config.azureDeploymentName

  const prompt = adapterOptions?.requestMessages
    ? adapterOptions.requestMessages.map(({ role, content }) => ({ role, content }))
    : getConversationPairs(
        session.conversationRecords.slice(-config.maxConversationContextLength),
        false,
      )
  if (!adapterOptions?.requestMessages) prompt.push({ role: 'user', content: question })

  let answer = ''
  await fetchSSE(
    `${config.azureEndpoint.replace(
      /\/$/,
      '',
    )}/openai/deployments/${deploymentName}/chat/completions?api-version=2024-02-01`,
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
        // Azure deployment names are opaque aliases, not canonical model identifiers.
        ...getTemperatureParams(config),
      }),
      onMessage(message) {
        diagnostics.debug('sse message', message)
        let data
        try {
          data = JSON.parse(message)
        } catch (error) {
          diagnostics.debug('json error', error)
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
          diagnostics.debug('conversation history', { content: session.conversationRecords })
          port.postMessage({ answer: null, done: true, session: session })
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
        const providerCode = String(error?.error?.code || '').toLowerCase()
        const responseError = new Error(
          !isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`,
        )
        if (CONTEXT_PROVIDER_CODES.has(providerCode)) responseError.providerCode = providerCode
        throw responseError
      },
    },
  )
}
