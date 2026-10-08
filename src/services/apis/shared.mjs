import { isEmpty } from 'lodash-es'

export const getChatSystemPromptBase = async () => {
  return `You are a helpful, creative, clever, and very friendly assistant. You are familiar with various languages in the world.`
}

export const getCompletionPromptBase = async () => {
  return (
    `The following is a conversation with an AI assistant.` +
    `The assistant is helpful, creative, clever, and very friendly. The assistant is familiar with various languages in the world.\n\n` +
    `Human: Hello, who are you?\n` +
    `AI: I am an AI assistant. How can I help you today?\n`
  )
}

export const getCustomApiPromptBase = async () => {
  return `I am a helpful, creative, clever, and very friendly assistant. I am familiar with various languages in the world.`
}

export function acknowledgePortStop(port, message) {
  if (message.stopAcknowledged || port._stopAcknowledged) return false
  try {
    port.postMessage({
      done: true,
      ...(message.stopGenerationId === undefined
        ? {}
        : { stoppedGenerationId: message.stopGenerationId }),
    })
  } catch (e) {
    return false
  }
  port._stopAcknowledged = true
  message.stopAcknowledged = true
  return true
}

export function setAbortController(port, onStop, onDisconnect) {
  const controller = new AbortController()
  const sessionRequestGeneration = port._sessionRequestGeneration
  let stopGenerationId
  const messageListener = (msg) => {
    if (msg.stop) {
      stopGenerationId = msg.stopGenerationId
      port.onMessage.removeListener(messageListener)
      console.debug('stop generating')
      acknowledgePortStop(port, msg)
      controller.abort()
      if (onStop) onStop()
    }
  }
  port.onMessage.addListener(messageListener)

  const disconnectListener = () => {
    port.onDisconnect.removeListener(disconnectListener)
    console.debug('port disconnected')
    controller.abort()
    if (onDisconnect) onDisconnect()
  }
  port.onDisconnect.addListener(disconnectListener)

  const cleanController = () => {
    try {
      port.onMessage.removeListener(messageListener)
      port.onDisconnect.removeListener(disconnectListener)
    } catch (e) {
      // ignore
    }
  }

  return {
    controller,
    cleanController,
    messageListener,
    disconnectListener,
    getStopGenerationId: () => stopGenerationId,
    isCurrentSessionRequest: () => port._sessionRequestGeneration === sessionRequestGeneration,
  }
}

export function pushRecord(session, question, answer) {
  const recordLength = session.conversationRecords.length
  let lastRecord
  if (recordLength > 0) lastRecord = session.conversationRecords[recordLength - 1]

  if (session.isRetry && lastRecord && lastRecord.question === question) lastRecord.answer = answer
  else session.conversationRecords.push({ question: question, answer: answer })
}

/**
 * Whether a finished turn belongs in the conversation records.
 *
 * A turn that was nothing but thinking has no answer to record; keeping it out of the records
 * is what stops a model being sent its own unfinished reasoning back as context. A plain empty
 * answer is still recorded, as it always has been. Every provider that can stream reasoning
 * shares this rule so the paths cannot drift apart.
 *
 * @param {string} answer
 * @param {string} reasoning
 * @returns {boolean}
 */
export function shouldRecordTurn(answer, reasoning) {
  return Boolean(answer) || !reasoning
}

/**
 * The user-facing error for a non-ok HTTP response: the provider's JSON body when there is
 * one, and the status line otherwise. Every transport reports failures the same way.
 *
 * @param {Response} resp
 * @returns {Promise<Error>}
 */
export async function createApiResponseError(resp) {
  const error = await resp.json().catch(() => ({}))
  return new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
}

/**
 * Decode one SSE payload. A line that is not JSON is logged and dropped, which is how a
 * stray comment or keep-alive is ignored.
 *
 * @param {string} message
 * @returns {any} the decoded payload, or undefined when it was not JSON
 */
export function parseJsonMessage(message) {
  try {
    return JSON.parse(message)
  } catch (error) {
    console.debug('json error', error)
    return undefined
  }
}
