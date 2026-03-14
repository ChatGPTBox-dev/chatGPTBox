import { generateAnswersWithOpenAiApiCompat } from './openai-api.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithAimlApi(port, question, session, apiKey) {
  const baseUrl = 'https://api.aimlapi.com/v1'
  return generateAnswersWithOpenAiApiCompat(baseUrl, port, question, session, apiKey)
}
