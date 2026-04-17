import { pushRecord, setAbortController } from './shared.mjs'
import Claude from '../clients/claude'
import { getModelValue } from '../../utils/model-name-convert.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} sessionKey
 */
export async function generateAnswersWithClaudeWebApi(port, question, session, sessionKey) {
  const bot = new Claude({ sessionKey })
  await bot.init()
  const { controller, cleanController } = setAbortController(port)
  const model = getModelValue(session)

  let answer = ''
  const progressFunc = ({ completion }) => {
    answer = completion
    port.postMessage({ answer: answer, done: false, session: null })
  }

  const doneFunc = () => {
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: answer, done: true, session: session })
  }

  const params = {
    progress: progressFunc,
    done: doneFunc,
    model,
    signal: controller.signal,
  }

  if (!session.claude_conversation)
    await bot
      .startConversation(question, params)
      .then((conversation) => {
        conversation.request = null
        conversation.claude = null
        session.claude_conversation = conversation
        port.postMessage({ answer: answer, done: true, session: session })
        cleanController()
      })
      .catch((err) => {
        cleanController()
        throw err
      })
  else
    await bot
      .sendMessage(question, {
        conversation: session.claude_conversation,
        ...params,
      })
      .then(cleanController)
      .catch((err) => {
        cleanController()
        throw err
      })
}
