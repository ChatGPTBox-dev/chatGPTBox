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

export function getCompletedAnswerUpdate(restoredRetryAnswer) {
  return {
    value: restoredRetryAnswer ?? '',
    appended: restoredRetryAnswer === null,
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
