import BingAIClient from '../clients/bing/index.mjs'
import { getUserConfig } from '../../config/index.mjs'
import { pushRecord, setAbortController } from './shared.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} accessToken
 * @param {boolean} sydneyMode
 */
export async function generateAnswersWithBingWebApi(
  port,
  question,
  session,
  accessToken,
  sydneyMode = false,
) {
  const { controller, messageListener, disconnectListener } = setAbortController(port)
  const config = await getUserConfig()
  let modelMode = getModelValue(session)
  if (!modelMode) modelMode = config.modelMode

  console.debug('mode', modelMode)

  const bingAIClient = new BingAIClient({ userToken: accessToken, features: { genImage: false } })
  if (session.bingWeb_jailbreakConversationCache)
    bingAIClient.conversationsCache.set(
      session.bingWeb_jailbreakConversationId,
      session.bingWeb_jailbreakConversationCache,
    )

  let answer = ''
  const response = await bingAIClient
    .sendMessage(question, {
      abortController: controller,
      toneStyle: modelMode,
      jailbreakConversationId: sydneyMode,
      onProgress: (message) => {
        answer = message
        // reference markers [^number^]
        answer = answer.replaceAll(/\[\^(\d+)\^\]/g, '<sup>$1</sup>')
        port.postMessage({ answer: answer, done: false, session: null })
      },
      ...(session.bingWeb_conversationId
        ? {
            conversationId: session.bingWeb_conversationId,
            encryptedConversationSignature: session.bingWeb_encryptedConversationSignature,
            clientId: session.bingWeb_clientId,
            invocationId: session.bingWeb_invocationId,
          }
        : session.bingWeb_jailbreakConversationId
        ? {
            jailbreakConversationId: session.bingWeb_jailbreakConversationId,
            parentMessageId: session.bingWeb_parentMessageId,
          }
        : {}),
    })
    .catch((err) => {
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
      throw err
    })

  if (!sydneyMode) {
    session.bingWeb_encryptedConversationSignature = response.encryptedConversationSignature
    session.bingWeb_conversationId = response.conversationId
    session.bingWeb_clientId = response.clientId
    session.bingWeb_invocationId = response.invocationId
  } else {
    session.bingWeb_jailbreakConversationId = response.jailbreakConversationId
    session.bingWeb_parentMessageId = response.messageId
    session.bingWeb_jailbreakConversationCache = bingAIClient.conversationsCache.get(
      response.jailbreakConversationId,
    )
  }

  if (response.details.sourceAttributions && response.details.sourceAttributions.length > 0) {
    const footnotes =
      '\n\\-\n' +
      response.details.sourceAttributions
        .map((attr, index) => `\\[${index + 1}]: [${attr.providerDisplayName}](${attr.seeMoreUrl})`)
        .join('\n')
    answer += footnotes
  }

  pushRecord(session, question, answer)
  console.debug('conversation history', { content: session.conversationRecords })
  port.onMessage.removeListener(messageListener)
  port.onDisconnect.removeListener(disconnectListener)
  port.postMessage({ answer: answer, done: true, session: session })
}
