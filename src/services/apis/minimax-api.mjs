import { generateAnswersWithOpenAiApiCompat } from './openai-api.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithMiniMaxApi(port, question, session, apiKey) {
  const baseUrl = 'https://api.minimax.io/v1'
  return generateAnswersWithOpenAiApiCompat(baseUrl, port, question, session, apiKey)
}
