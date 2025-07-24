// path/to/services/apis/you-web.mjs

import { pushRecord, setAbortController } from '../../services/apis/shared.mjs'
import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getUserConfig, youWebModelKeys } from '../../config/index.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { getModelValue, isUsingModelName } from '../../utils/model-name-convert.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} sessionCookie
 */
export async function generateAnswersWithYouWebApi(port, question, session, sessionCookie) {
  const { controller, cleanController } = setAbortController(port)
  const config = await getUserConfig()
  const model = getModelValue(session)

  const apiUrl = 'https://you.com/api/streamingSearch'

  // Use the existing chatId from the session or generate a new one
  if (!session.chatId) {
    session.chatId = generateUUID() // You need a function to generate UUIDs
  }

  // Always include the conversation history
  const conversationContext = getConversationPairs(session.conversationRecords, false)

  const traceId = `${session.chatId}|${session.messageId}|${new Date().toISOString()}`

  const params = new URLSearchParams()
  params.append('page', '1')
  params.append('count', '10')
  params.append('safeSearch', 'Off')
  params.append('q', question)
  params.append('chatId', session.chatId) // Use the existing or new chatId
  params.append('traceId', traceId)
  params.append('conversationTurnId', session.messageId)
  params.append('selectedAiModel', model)

  // Conditional chatMode based on modelName
  let chatMode = 'custom'
  if (isUsingModelName('create', session)) {
    chatMode = 'create'
  }
  params.append('selectedChatMode', chatMode)

  params.append('pastChatLength', session.conversationRecords.length.toString())
  params.append('queryTraceId', traceId)
  params.append('use_personalization_extraction', 'false')
  params.append('domain', 'youchat')
  params.append('mkt', 'en-US')
  params.append('chat', JSON.stringify(conversationContext))

  const url = `${apiUrl}?${params.toString()}`

  let answer = ''

  await fetchSSE(url, {
    method: 'GET',
    signal: controller.signal,
    headers: {
      'Content-Type': 'text/event-stream;charset=utf-8',
      Cookie: `sessionKey=${sessionCookie}`,
      'User-Agent': navigator.userAgent,
    },
    onMessage(message) {
      if (message.trim() === '[DONE]') {
        finishMessage()
        return
      }

      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        console.error('SSE message parse error:', error)
        return
      }

      if (data.youChatToken) {
        answer += data.youChatToken
        port.postMessage({ answer: answer, done: false, session: null })
      }
    },
    onStart() {
      // Handle start if needed
    },
    onEnd() {
      finishMessage()
      port.postMessage({ done: true })
      cleanController()
    },
    onError(error) {
      cleanController()
      port.postMessage({ error: error.message, done: true })
    },
  })

  function finishMessage() {
    pushRecord(session, question, answer)
    port.postMessage({ answer: answer, done: true, session: session })
  }
}

// Helper function to generate UUIDs (you can use a library for this if you prefer)
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
