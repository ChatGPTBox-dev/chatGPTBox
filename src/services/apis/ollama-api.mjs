import { getUserConfig } from '../../config/index.mjs'
import { generateAnswersWithOpenAiApiCompat } from './openai-api.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithOllamaApi(port, question, session) {
  const config = await getUserConfig()
  const model = getModelValue(session)
  return generateAnswersWithOpenAiApiCompat(
    config.ollamaEndpoint + '/v1',
    port,
    question,
    session,
    config.ollamaApiKey,
  ).then(() =>
    fetch(config.ollamaEndpoint + '/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ollamaApiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: 't',
        options: {
          num_predict: 1,
        },
        keep_alive: config.ollamaKeepAliveTime === '-1' ? -1 : config.ollamaKeepAliveTime,
      }),
    }),
  )
}
