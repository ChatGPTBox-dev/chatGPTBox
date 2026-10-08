import { resolveGeminiWebPreset } from '../../utils/gemini-web-preset.mjs'
import { pushRecord, setAbortController } from './shared.mjs'
import GeminiWebClient from '../clients/gemini-web/index.mjs'
import { protocolError } from '../clients/gemini-web/protocol.mjs'

function resolveConversationForTurn(session) {
  if (Object.hasOwn(session, 'geminiWeb_retryConversation')) {
    const retryConversation = session.geminiWeb_retryConversation
    if (
      !retryConversation ||
      typeof retryConversation !== 'object' ||
      Array.isArray(retryConversation)
    ) {
      throw protocolError('Invalid conversation state. Start a new conversation.')
    }
    return retryConversation
  }
  return session.geminiWeb_conversation ?? session.bard_conversationObj ?? {}
}

function getPreTurnConversation(conversation, conversationObj) {
  const previousConversation = { ...conversation }
  delete previousConversation.accountId
  if (
    !Object.hasOwn(previousConversation, 'accountPath') &&
    typeof conversationObj?.accountPath === 'string'
  ) {
    previousConversation.accountPath = conversationObj.accountPath
  }
  return previousConversation
}

export async function generateAnswersWithGeminiWebApi(
  port,
  question,
  session,
  config = {},
  isLatestSessionRequest = () => true,
) {
  const conversation = resolveConversationForTurn(session)
  const { model, extendedThinking } = resolveGeminiWebPreset(session?.apiMode, config)
  const { controller, cleanController, isCurrentSessionRequest } = setAbortController(port)
  const abortSupersededRequest = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('The operation was superseded.', 'AbortError'))
    }
  }
  port._abortSupersededSessionRequest = abortSupersededRequest
  const client = new GeminiWebClient()
  const isRequestCurrent = () => isCurrentSessionRequest() && isLatestSessionRequest()
  try {
    const { answer, conversationObj } = await client.ask(
      question,
      conversation,
      controller.signal,
      {
        model,
        temporary: config.disableWebModeHistory === true,
        extendedThinking,
        isRequestCurrent,
      },
    )
    if (controller.signal.aborted || !isRequestCurrent()) return
    session.geminiWeb_previousConversation = getPreTurnConversation(conversation, conversationObj)
    session.geminiWeb_conversation = conversationObj
    delete session.geminiWeb_retryConversation
    delete session.bard_conversationObj
    pushRecord(session, question, answer)
    session.geminiWeb_lastRecordIndex = session.conversationRecords.length - 1
    port.postMessage({ answer, done: true, session })
  } finally {
    if (port._abortSupersededSessionRequest === abortSupersededRequest) {
      delete port._abortSupersededSessionRequest
    }
    cleanController()
  }
}
