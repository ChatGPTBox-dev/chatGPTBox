import { pushRecord } from '../../services/apis/shared.mjs'
import { getGeminiContinuationRevision } from '../../services/apis/gemini-web-continuation.mjs'

export function getSessionContentRevision(session) {
  if (!session) return null
  return JSON.stringify([
    session.createdAt ?? null,
    session.question ?? null,
    session.conversationRecords ?? [],
    getGeminiContinuationRevision(session.geminiWeb_conversation ?? session.bard_conversationObj),
  ])
}

function clearGeminiWebRetryConversation(session) {
  if (!Object.hasOwn(session, 'geminiWeb_retryConversation')) return session
  const updatedSession = { ...session }
  delete updatedSession.geminiWeb_retryConversation
  return updatedSession
}

function isGeminiWebSession(session) {
  if (session?.apiMode) return session.apiMode.groupName === 'bardWebModelKeys'
  const modelName = typeof session?.modelName === 'string' ? session.modelName : ''
  return modelName === 'bardWebFree' || modelName.startsWith('bardWebFree-')
}

function getGeminiWebRequestConversation(session) {
  if (Object.hasOwn(session ?? {}, 'geminiWeb_retryConversation')) {
    return session.geminiWeb_retryConversation
  }
  return session?.geminiWeb_conversation ?? session?.bard_conversationObj ?? {}
}

export function hasGeminiWebRemoteContinuation(session) {
  if (!isGeminiWebSession(session)) return false
  const conversation = getGeminiWebRequestConversation(session)
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) return false
  const nonempty = (value) => value != null && value !== ''
  return (
    ['c', 'r', 'rc'].some((key) => nonempty(conversation[key])) ||
    (Array.isArray(conversation.metadata) && conversation.metadata.some(nonempty))
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
    if (session.geminiWeb_conversationUnsafe === true) return null
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

function replacesLastGeminiAnswer(session, retryRecord) {
  return (
    Boolean(retryRecord) &&
    !isGeminiWebSession(session) &&
    session.geminiWeb_lastRecordIndex === retryRecord.recordIndex
  )
}

export function finalizeCompletedSession(session, retryRecord = null) {
  const completed = { ...session, isRetry: false }
  if (
    replacesLastGeminiAnswer(session, retryRecord) &&
    session.conversationRecords.length > retryRecord.recordIndex
  ) {
    completed.geminiWeb_conversationUnsafe = true
  }
  return completed
}

export function finalizeInterruptedSession(session, answer, retryRecord = null) {
  if (replacesLastGeminiAnswer(session, retryRecord)) {
    answer = ''
  }
  if (!answer) {
    if (!session.isRetry && !retryRecord) return clearGeminiWebRetryConversation(session)
    const shouldRestoreRetryRecord =
      retryRecord && retryRecord.recordIndex === session.conversationRecords.length
    const restoredRecord = retryRecord ? { ...retryRecord } : null
    if (restoredRecord) delete restoredRecord.recordIndex
    return clearGeminiWebRetryConversation({
      ...session,
      conversationRecords: shouldRestoreRetryRecord
        ? [...session.conversationRecords, restoredRecord]
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
  persistedApiMode,
}) {
  return {
    session,
    stop,
    ...(persistedApiMode ? { persistedApiMode } : {}),
    ...(stopGenerationId === undefined ? {} : { stopGenerationId }),
    ...(requestGenerationId === undefined ? {} : { requestGenerationId }),
  }
}

export function shouldReplaceLastRetryRecord(records, recordIndex) {
  return Number.isInteger(recordIndex) && recordIndex >= 0 && recordIndex === records.length - 1
}

export function createRetrySession(session, conversationRecords, retryRecord) {
  const retrySession = {
    ...session,
    question: retryRecord?.question ?? session.question,
    conversationRecords,
    // A retry without a stored answer must not replace an earlier identical question.
    isRetry: retryRecord === null && conversationRecords.at(-1)?.question !== session.question,
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

export function getInterruptedCompletionState(message, partialAnswer, retryRecord, session) {
  const shouldFinalize = Boolean(
    message.proxyDisconnected || (!message.session && (partialAnswer || retryRecord)),
  )
  const restoreGeminiAnswer = session && replacesLastGeminiAnswer(session, retryRecord)
  return {
    shouldFinalize,
    restoredRetryAnswer:
      shouldFinalize && retryRecord && (!partialAnswer || restoreGeminiAnswer)
        ? retryRecord.answer
        : null,
  }
}
