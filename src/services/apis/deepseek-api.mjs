import { generateAnswersWithOpenAiApiCompat } from './openai-api.mjs'

/**
 * @param {Browser.Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} apiKey
 */
export async function generateAnswersWithDeepSeekApi(port, question, session, apiKey) {
  const baseUrl = 'https://api.deepseek.com'
  return generateAnswersWithOpenAiApiCompat(baseUrl, port, question, session, apiKey)
}
