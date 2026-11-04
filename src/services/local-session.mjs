import Browser from 'webextension-polyfill'
import { v4 as uuidv4 } from 'uuid'
import { initSession } from './init-session.mjs'
import { getUserConfig } from '../config/index.mjs'
import { canonicalizeSessionModelFields } from '../config/model-key-migrations.mjs'

const TITLE_GENERATION_STALE_MS = 2 * 60 * 1000
const SESSION_STORAGE_LOCK_NAME = 'chatgptbox-session-storage'
export const MAX_SESSION_TITLE_GENERATION_ATTEMPTS = 1

let sessionMutationQueue = Promise.resolve()

function enqueueSessionMutation(mutation) {
  const runMutation = () => {
    const locks = globalThis.navigator?.locks
    if (locks && typeof locks.request === 'function') {
      return locks.request(SESSION_STORAGE_LOCK_NAME, mutation)
    }
    // Automatic title generation is disabled when cross-context Web Locks are unavailable.
    // Keep the legacy in-context queue for existing session operations and test environments.
    return mutation()
  }

  const operation = sessionMutationQueue.then(runMutation, runMutation)
  sessionMutationQueue = operation.catch(() => {})
  return operation
}

const SESSION_TITLE_FIELDS = [
  'sessionName',
  'sessionNameSource',
  'sessionTitleGenerationStatus',
  'sessionTitleGenerationStartedAt',
  'sessionTitleGenerationId',
  'sessionTitleGenerationAttempts',
]

function parseSessionTimestamp(value) {
  const timestamp = Date.parse(value || '')
  return Number.isFinite(timestamp) ? timestamp : null
}

function hasExplicitSessionTitleChange(newSession, storedSession) {
  const incomingName =
    typeof newSession?.sessionName === 'string' ? newSession.sessionName.trim() : ''
  const storedName =
    typeof storedSession?.sessionName === 'string' ? storedSession.sessionName.trim() : ''
  if (newSession?.sessionNameSource === 'manual') return incomingName !== storedName
  if (!incomingName || incomingName === storedName) return false

  const incomingUpdatedAt = parseSessionTimestamp(newSession?.updatedAt)
  const storedUpdatedAt = parseSessionTimestamp(storedSession?.updatedAt)
  return (
    incomingUpdatedAt === null ||
    storedUpdatedAt === null ||
    incomingUpdatedAt >= storedUpdatedAt
  )
}

function applyExplicitSessionTitleChange(newSession) {
  return {
    ...newSession,
    sessionNameSource: 'manual',
    sessionTitleGenerationStatus: 'idle',
    sessionTitleGenerationStartedAt: null,
    sessionTitleGenerationId: null,
    sessionTitleGenerationAttempts: 0,
  }
}

function preserveStoredSessionTitleState(newSession, storedSession) {
  if (!storedSession) return newSession
  if (hasExplicitSessionTitleChange(newSession, storedSession)) {
    return applyExplicitSessionTitleChange(newSession)
  }

  const merged = { ...newSession }
  for (const field of SESSION_TITLE_FIELDS) {
    if (Object.hasOwn(storedSession, field)) merged[field] = storedSession[field]
  }
  return merged
}

function resetSessionTitleState(session, timestamp = new Date().toISOString()) {
  return {
    ...session,
    sessionName: null,
    sessionNameSource: null,
    sessionTitleGenerationStatus: 'idle',
    sessionTitleGenerationStartedAt: null,
    sessionTitleGenerationId: null,
    sessionTitleGenerationAttempts: 0,
    sessionLifecycleId: uuidv4(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function prepareNewStoredConversation(session) {
  if (
    session?.sessionNameSource ||
    !Array.isArray(session?.conversationRecords) ||
    session.conversationRecords.length === 0
  ) {
    return session
  }

  return resetSessionTitleState(session)
}

function getSessionLifecycleId(session) {
  const lifecycleId = session?.sessionLifecycleId
  return typeof lifecycleId === 'string' && lifecycleId ? lifecycleId : null
}

function hasFreshConversationLifecycle(newSession, storedSession) {
  const incomingLifecycleId = getSessionLifecycleId(newSession)
  const storedLifecycleId = getSessionLifecycleId(storedSession)
  if (incomingLifecycleId || storedLifecycleId) {
    if (!incomingLifecycleId) return false
    if (!storedLifecycleId) return true
    return incomingLifecycleId !== storedLifecycleId
  }

  return (
    typeof newSession?.createdAt === 'string' &&
    Boolean(newSession.createdAt) &&
    typeof storedSession?.createdAt === 'string' &&
    Boolean(storedSession.createdAt) &&
    newSession.createdAt !== storedSession.createdAt
  )
}

function isConversationClear(newSession, storedSession) {
  if (
    !Array.isArray(storedSession?.conversationRecords) ||
    storedSession.conversationRecords.length === 0
  ) {
    return false
  }

  const hasEmptyIncomingConversation =
    Array.isArray(newSession?.conversationRecords) && newSession.conversationRecords.length === 0
  return hasEmptyIncomingConversation || hasFreshConversationLifecycle(newSession, storedSession)
}

function getSessionTitleGenerationAttempts(session) {
  const attempts = session?.sessionTitleGenerationAttempts
  return Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0
}

function matchesExpectedTitleTranscript(session, expectedTranscript) {
  if (!expectedTranscript) return true

  const expectedLifecycleId = getSessionLifecycleId({
    sessionLifecycleId: expectedTranscript.lifecycleId,
  })
  const sessionLifecycleId = getSessionLifecycleId(session)
  if (expectedLifecycleId) return sessionLifecycleId === expectedLifecycleId
  if (sessionLifecycleId) return false
  if (expectedTranscript.createdAt && session?.createdAt !== expectedTranscript.createdAt) return false

  const firstRecord = Array.isArray(session?.conversationRecords)
    ? session.conversationRecords[0]
    : null
  return (
    String(firstRecord?.question || '') === String(expectedTranscript.question || '') &&
    String(firstRecord?.answer || '') === String(expectedTranscript.answer || '')
  )
}

async function readStoredSessionsUnsafe() {
  const { sessions } = await Browser.storage.local.get('sessions')
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { sessions: null, needsPersist: false }
  }

  const migratedSessions = sessions.map(canonicalizeSessionModelFields)
  return {
    sessions: migratedSessions,
    needsPersist: JSON.stringify(migratedSessions) !== JSON.stringify(sessions),
  }
}

async function persistSessions(sessions) {
  await Browser.storage.local.set({ sessions })
  return sessions
}

async function getOrInitializeSessionsUnsafe() {
  const stored = await readStoredSessionsUnsafe()
  if (stored.sessions) {
    if (stored.needsPersist) await persistSessions(stored.sessions)
    return stored.sessions
  }
  return resetSessionsUnsafe()
}

function findSessionIndex(sessions, sessionId) {
  return sessions.findIndex((session) => session.sessionId === sessionId)
}

export function isSessionTitleGenerationStale(session, now = Date.now()) {
  if (session?.sessionTitleGenerationStatus !== 'pending') return false
  const startedAt = Date.parse(session?.sessionTitleGenerationStartedAt || '')
  return !Number.isFinite(startedAt) || now - startedAt >= TITLE_GENERATION_STALE_MS
}

export function getSessionTitleGenerationStaleDelay(session, now = Date.now()) {
  if (session?.sessionTitleGenerationStatus !== 'pending') return null
  const startedAt = Date.parse(session?.sessionTitleGenerationStartedAt || '')
  if (!Number.isFinite(startedAt)) return 0
  return Math.max(0, TITLE_GENERATION_STALE_MS - (now - startedAt))
}

function hasProtectedSessionTitle(session) {
  if (session?.sessionNameSource === 'manual') return true
  if (typeof session?.sessionName !== 'string' || !session.sessionName.trim()) return false
  return session.sessionNameSource !== 'heuristic'
}

export const initDefaultSession = async () => {
  const config = await getUserConfig()
  return initSession({
    sessionName: null,
    modelName: config.modelName,
    apiMode: config.apiMode,
    autoClean: false,
    extraCustomModelName: config.customModelName,
  })
}

export const createSession = (newSession) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getOrInitializeSessionsUnsafe()
    if (newSession) {
      const index = findSessionIndex(currentSessions, newSession.sessionId)
      if (index !== -1) {
        newSession = preserveStoredSessionTitleState(newSession, currentSessions[index])
        currentSessions[index] = newSession
      } else {
        newSession = prepareNewStoredConversation(newSession)
        currentSessions.unshift(newSession)
      }
    } else {
      newSession = await initDefaultSession()
      currentSessions.unshift(newSession)
    }
    await persistSessions(currentSessions)
    return { session: newSession, currentSessions }
  })

export const deleteSession = (sessionId) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getOrInitializeSessionsUnsafe()
    const index = findSessionIndex(currentSessions, sessionId)
    if (index === -1) return currentSessions

    currentSessions.splice(index, 1)
    if (currentSessions.length > 0) return persistSessions(currentSessions)
    return resetSessionsUnsafe()
  })

export const getSession = async (sessionId) => {
  const currentSessions = await getSessions()
  return {
    session: currentSessions.find((session) => session.sessionId === sessionId),
    currentSessions,
  }
}

export const updateSession = (newSession) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getOrInitializeSessionsUnsafe()
    const index = findSessionIndex(currentSessions, newSession.sessionId)
    if (index === -1) return currentSessions

    const storedSession = currentSessions[index]
    const hasEmptyIncomingConversation =
      Array.isArray(newSession?.conversationRecords) && newSession.conversationRecords.length === 0
    const resetTimestamp = hasEmptyIncomingConversation
      ? new Date().toISOString()
      : typeof newSession.createdAt === 'string' && newSession.createdAt
        ? newSession.createdAt
        : new Date().toISOString()
    const mergedSession = isConversationClear(newSession, storedSession)
      ? resetSessionTitleState(newSession, resetTimestamp)
      : preserveStoredSessionTitleState(newSession, storedSession)
    mergedSession.updatedAt = new Date().toISOString()
    currentSessions[index] = mergedSession
    await persistSessions(currentSessions)
    return currentSessions
  })

export const claimSessionTitleGeneration = (sessionId, expectedTranscript = null) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getOrInitializeSessionsUnsafe()
    const index = findSessionIndex(currentSessions, sessionId)
    if (index === -1) {
      return { claimed: false, updated: false, session: null, currentSessions }
    }

    const session = currentSessions[index]
    if (!matchesExpectedTitleTranscript(session, expectedTranscript)) {
      return { claimed: false, updated: false, session, currentSessions }
    }
    if (hasProtectedSessionTitle(session)) {
      return { claimed: false, updated: false, session, currentSessions }
    }
    if (session.sessionTitleGenerationStatus === 'succeeded') {
      return { claimed: false, updated: false, session, currentSessions }
    }

    const attempts = getSessionTitleGenerationAttempts(session)
    if (
      session.sessionTitleGenerationStatus === 'failed' &&
      attempts >= MAX_SESSION_TITLE_GENERATION_ATTEMPTS
    ) {
      return { claimed: false, updated: false, session, currentSessions }
    }
    if (
      session.sessionTitleGenerationStatus === 'pending' &&
      !isSessionTitleGenerationStale(session)
    ) {
      return { claimed: false, updated: false, session, currentSessions }
    }
    if (attempts >= MAX_SESSION_TITLE_GENERATION_ATTEMPTS) {
      session.sessionTitleGenerationStatus = 'failed'
      session.sessionTitleGenerationStartedAt = null
      session.sessionTitleGenerationId = null
      session.updatedAt = new Date().toISOString()
      await persistSessions(currentSessions)
      return { claimed: false, updated: true, session, currentSessions }
    }

    const now = new Date().toISOString()
    session.sessionTitleGenerationStatus = 'pending'
    session.sessionTitleGenerationStartedAt = now
    session.sessionTitleGenerationId = uuidv4()
    session.sessionTitleGenerationAttempts = attempts + 1
    session.updatedAt = now
    await persistSessions(currentSessions)
    return { claimed: true, updated: true, session, currentSessions }
  })

export const completeSessionTitleGeneration = (sessionId, title, generationId) =>
  enqueueSessionMutation(async () => {
    const normalizedTitle = String(title || '').trim()
    const currentSessions = await getOrInitializeSessionsUnsafe()
    const index = findSessionIndex(currentSessions, sessionId)
    if (index === -1 || !normalizedTitle) {
      return { updated: false, session: null, currentSessions }
    }

    const session = currentSessions[index]
    if (
      hasProtectedSessionTitle(session) ||
      session.sessionTitleGenerationStatus !== 'pending' ||
      !generationId ||
      session.sessionTitleGenerationId !== generationId
    ) {
      return { updated: false, session, currentSessions }
    }

    const now = new Date().toISOString()
    session.sessionName = normalizedTitle
    session.sessionNameSource = 'generated'
    session.sessionTitleGenerationStatus = 'succeeded'
    session.sessionTitleGenerationStartedAt = null
    session.sessionTitleGenerationId = null
    session.updatedAt = now
    await persistSessions(currentSessions)
    return { updated: true, session, currentSessions }
  })

export const failSessionTitleGeneration = (sessionId, generationId) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getOrInitializeSessionsUnsafe()
    const index = findSessionIndex(currentSessions, sessionId)
    if (index === -1) return { updated: false, session: null, currentSessions }

    const session = currentSessions[index]
    if (
      session.sessionTitleGenerationStatus !== 'pending' ||
      !generationId ||
      session.sessionTitleGenerationId !== generationId
    ) {
      return { updated: false, session, currentSessions }
    }

    session.sessionTitleGenerationStatus = 'failed'
    session.sessionTitleGenerationStartedAt = null
    session.sessionTitleGenerationId = null
    session.updatedAt = new Date().toISOString()
    await persistSessions(currentSessions)
    return { updated: true, session, currentSessions }
  })

async function resetSessionsUnsafe() {
  const currentSessions = [await initDefaultSession()]
  await persistSessions(currentSessions)
  return currentSessions
}

export const resetSessions = () => enqueueSessionMutation(resetSessionsUnsafe)

export const getSessions = async () => {
  const stored = await readStoredSessionsUnsafe()
  if (stored.sessions && !stored.needsPersist) return stored.sessions

  return enqueueSessionMutation(async () => {
    const current = await readStoredSessionsUnsafe()
    if (current.sessions) {
      if (current.needsPersist) await persistSessions(current.sessions)
      return current.sessions
    }
    return resetSessionsUnsafe()
  })
}
