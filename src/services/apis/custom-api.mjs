import { generateAnswersWithOpenAICompatible } from './openai-compatible-core.mjs'

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
  await generateAnswersWithOpenAICompatible({
    port,
    question,
    session,
    endpointType: 'chat',
    requestUrl: apiUrl,
    model: modelName,
    apiKey,
    provider: 'custom',
    allowLegacyResponseField: true,
  })
}
