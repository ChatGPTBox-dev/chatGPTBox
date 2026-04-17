import { getUserConfig } from '../../config/index.mjs'
// import { getToken } from '../../utils/jwt-token-generator.mjs'
import { generateAnswersWithOpenAiApiCompat } from './openai-api.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 */
export async function generateAnswersWithChatGLMApi(port, question, session) {
  const baseUrl = 'https://open.bigmodel.cn/api/paas/v4'
  const config = await getUserConfig()
  return generateAnswersWithOpenAiApiCompat(baseUrl, port, question, session, config.chatglmApiKey)
}
