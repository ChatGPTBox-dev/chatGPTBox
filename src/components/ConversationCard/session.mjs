import { pushRecord } from '../../services/apis/shared.mjs'

export function finalizeInterruptedSession(session, answer, retryRecord = null) {
  if (!answer) {
    if (!session.isRetry && !retryRecord) return session
    const lastRecord = session.conversationRecords.at(-1)
    const shouldRestoreRetryRecord =
      retryRecord &&
      (lastRecord?.question !== retryRecord.question || lastRecord?.answer !== retryRecord.answer)
    return {
      ...session,
      conversationRecords: shouldRestoreRetryRecord
        ? [...session.conversationRecords, { ...retryRecord }]
        : session.conversationRecords,
      isRetry: false,
    }
  }
  const updatedSession = {
    ...session,
    conversationRecords: session.conversationRecords.map((record) => ({ ...record })),
  }
  pushRecord(updatedSession, session.question, answer)
  updatedSession.isRetry = false
  return updatedSession
}

export function isSupersededGenerationMessage(message, latestSupersededGenerationId) {
  return (
    message.stoppedGenerationId !== undefined &&
    message.stoppedGenerationId <= latestSupersededGenerationId
  )
}

export function isSupersededRequestMessage(message, currentRequestGenerationId) {
  return (
    message.requestGenerationId !== undefined &&
    message.requestGenerationId !== currentRequestGenerationId
  )
}

export function createConversationPortMessage({
  session,
  stop,
  stopGenerationId,
  requestGenerationId,
}) {
  return {
    session,
    stop,
    ...(stopGenerationId === undefined ? {} : { stopGenerationId }),
    ...(requestGenerationId === undefined ? {} : { requestGenerationId }),
  }
}

export function createRetrySession(session, conversationRecords, retryRecord) {
  return {
    ...session,
    conversationRecords,
    isRetry: retryRecord === null,
  }
}

export function getInterruptedCompletionState(message, partialAnswer, retryRecord) {
  const shouldFinalize = Boolean(
    message.proxyDisconnected || (!message.session && (partialAnswer || retryRecord)),
  )
  return {
    shouldFinalize,
    restoredRetryAnswer:
      shouldFinalize && !partialAnswer && retryRecord ? retryRecord.answer : null,
  }
}

/**
 * The content the trailing answer ends up with once the stream completes.
 *
 * A completion normally carries the whole answer and replaces what is shown, which is also
 * what clears the loading placeholder a reasoning-only turn leaves behind. A provider can
 * send a second, contentless completion right after the first one (ChatGPT Web's EOF message
 * and Waylaidwanderer's `onEnd` do), so an empty completion is only allowed to clear the
 * placeholder -- it must never blank an answer that is already on screen.
 *
 * @param {string|null} restoredRetryAnswer answer an interrupted retry restored, if any
 * @param {string} partialAnswer the answer the stream buffered
 * @param {string} currentContent the trailing answer's content right now
 * @param {string} placeholder the markup the card shows while it waits
 * @returns {string} the content to show
 */
export function getCompletedAnswerContent(
  restoredRetryAnswer,
  partialAnswer,
  currentContent,
  placeholder,
) {
  const answer = restoredRetryAnswer ?? partialAnswer
  if (answer) return answer
  return currentContent === placeholder ? '' : currentContent
}
