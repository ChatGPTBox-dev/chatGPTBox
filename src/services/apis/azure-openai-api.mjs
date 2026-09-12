import { getUserConfig } from '../../config/index.mjs'
import { pushRecord, withAbortController } from './shared.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { isEmpty } from 'lodash-es'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { getTemperatureParams } from './temperature-params.mjs'
import {
  generateAnswersWithOpenAIResponses,
  isResponsesRouteUnsupportedError,
} from './openai-responses-core.mjs'

// Azure Responses API is in preview; the version below supports `/openai/responses`.
// If the deployment does not support it, we fall back to Chat Completions.
const AZURE_RESPONSES_API_VERSION = '2025-04-01-preview'

function shouldFallbackToChatCompletions(error) {
  // Only fall back on initial HTTP failures. Mid-stream errors (no status)
  // may already have emitted partial answers; retrying via Chat would duplicate them.
  if (error?.status == null) return false
  return isResponsesRouteUnsupportedError(error)
}

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithAzureOpenaiApi(port, question, session) {
  return withAbortController(port, (abortContext) =>
    generateAzureOpenaiRequest(port, question, session, abortContext),
  )
}

async function generateAzureOpenaiRequest(port, question, session, abortContext) {
  const config = await getUserConfig()
  if (abortContext.controller.signal.aborted) return
  if (config.azureUseResponses === true) {
    let deploymentName = getModelValue(session)
    if (!deploymentName) deploymentName = config.azureDeploymentName
    const requestUrl = `${config.azureEndpoint.replace(
      /\/$/,
      '',
    )}/openai/responses?api-version=${AZURE_RESPONSES_API_VERSION}`
    try {
      await generateAnswersWithOpenAIResponses({
        abortContext,
        port,
        question,
        session,
        requestUrl,
        model: deploymentName,
        // Deployment names are opaque aliases, not canonical model identifiers.
        temperatureModel: null,
        apiKey: '',
        config,
        provider: 'azure',
        extraHeaders: { 'api-key': config.azureApiKey },
      })
      return
    } catch (error) {
      if (abortContext.controller.signal.aborted) return
      if (!shouldFallbackToChatCompletions(error)) throw error
      console.warn(
        '[azure-openai] Responses API unsupported, falling back to Chat Completions',
        error,
      )
    }
  }
  return generateAnswersWithAzureChatCompletions(port, question, session, config, abortContext)
}

async function generateAnswersWithAzureChatCompletions(
  port,
  question,
  session,
  config,
  abortContext,
) {
  const { controller } = abortContext
  if (controller.signal.aborted) return
  let deploymentName = getModelValue(session)
  if (!deploymentName) deploymentName = config.azureDeploymentName

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
        if (controller.signal.aborted) return
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
      async onEnd(aborted) {
        if (!aborted && !controller.signal.aborted) {
          port.postMessage({ done: true })
        }
      },
      async onError(resp) {
        if (resp instanceof Error) throw resp
        const error = await resp.json().catch(() => ({}))
        throw new Error(
          !isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`,
        )
      },
    },
  )
}
