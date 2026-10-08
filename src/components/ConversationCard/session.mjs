import { pushRecord } from '../../services/apis/shared.mjs'

function clearGeminiWebRetryConversation(session) {
  if (!Object.hasOwn(session, 'geminiWeb_retryConversation')) return session
  const updatedSession = { ...session }
  delete updatedSession.geminiWeb_retryConversation
  return updatedSession
}

function isGeminiWebSession(session) {
  const modelName = typeof session?.modelName === 'string' ? session.modelName : ''
  return (
    session?.apiMode?.groupName === 'bardWebModelKeys' ||
    modelName === 'bardWebFree' ||
    modelName.startsWith('bardWebFree-')
  )
}

function getGeminiWebRetryConversation(session, conversationRecords) {
  const removedRecordIndex = conversationRecords.length
  const lastGeminiRecordIndex = Number.isInteger(session.geminiWeb_lastRecordIndex)
    ? session.geminiWeb_lastRecordIndex
    : null
  const hasPreviousConversation = Object.hasOwn(session, 'geminiWeb_previousConversation')

  if (lastGeminiRecordIndex === removedRecordIndex) {
    return hasPreviousConversation ? session.geminiWeb_previousConversation : null
  }
  if (lastGeminiRecordIndex !== null && lastGeminiRecordIndex < removedRecordIndex) {
    return session.geminiWeb_conversation ?? session.bard_conversationObj ?? {}
  }
  if (
    lastGeminiRecordIndex === null &&
    (hasPreviousConversation || session.geminiWeb_conversation || session.bard_conversationObj)
  ) {
    return null
  }
  return {}
}

export function finalizeInterruptedSession(session, answer, retryRecord = null) {
  if (!answer) {
    if (!session.isRetry && !retryRecord) return clearGeminiWebRetryConversation(session)
    const lastRecord = session.conversationRecords.at(-1)
    const shouldRestoreRetryRecord =
      retryRecord &&
      (lastRecord?.question !== retryRecord.question || lastRecord?.answer !== retryRecord.answer)
    return clearGeminiWebRetryConversation({
      ...session,
      conversationRecords: shouldRestoreRetryRecord
        ? [...session.conversationRecords, { ...retryRecord }]
        : session.conversationRecords,
      isRetry: false,
    })
  }
  const updatedSession = {
    ...session,
    conversationRecords: session.conversationRecords.map((record) => ({ ...record })),
  }
  pushRecord(updatedSession, session.question, answer)
  updatedSession.isRetry = false
  return clearGeminiWebRetryConversation(updatedSession)
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
  const retrySession = {
    ...session,
    conversationRecords,
    isRetry: retryRecord === null,
  }
  delete retrySession.geminiWeb_retryConversation
  if (retryRecord !== null && isGeminiWebSession(session)) {
    retrySession.geminiWeb_retryConversation = getGeminiWebRetryConversation(
      session,
      conversationRecords,
    )
  }
  return retrySession
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
