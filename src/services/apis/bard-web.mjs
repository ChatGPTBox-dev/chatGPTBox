import { pushRecord } from './shared.mjs'
import Bard from '../clients/bard/index.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} cookies
 * @param {() => boolean} isLatestSessionRequest
 */
export async function generateAnswersWithBardWebApi(
  port,
  question,
  session,
  cookies,
  isLatestSessionRequest = () => true,
) {
  // const { controller, messageListener, disconnectListener } = setAbortController(port)
  const bot = new Bard(cookies)

  // eslint-disable-next-line
  try {
    const { answer, conversationObj } = await bot.ask(question, session.bard_conversationObj || {})
    if (!isLatestSessionRequest()) return
    session.bard_conversationObj = conversationObj
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    // port.onMessage.removeListener(messageListener)
    // port.onDisconnect.removeListener(disconnectListener)
    port.postMessage({ answer: answer, done: true, session: session })
  } catch (err) {
    // port.onMessage.removeListener(messageListener)
    // port.onDisconnect.removeListener(disconnectListener)
    throw err
  }
}
