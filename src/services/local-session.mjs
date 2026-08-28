import Browser from 'webextension-polyfill'
import { v4 as uuidv4 } from 'uuid'
import { initSession } from './init-session.mjs'
import { getUserConfig } from '../config/index.mjs'
import { canonicalizeSessionModelFields } from '../config/model-key-migrations.mjs'

const TITLE_GENERATION_STALE_MS = 2 * 60 * 1000
const SESSION_STORAGE_LOCK_NAME = 'chatgptbox-session-storage'

let sessionMutationQueue = Promise.resolve()

function enqueueSessionMutation(mutation) {
  const runMutation = () => {
    const locks = globalThis.navigator?.locks
    if (locks && typeof locks.request === 'function') {
      return locks.request(SESSION_STORAGE_LOCK_NAME, mutation)
    }
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

function hasManagedSessionTitleState(session) {
  return (
    session?.sessionNameSource === 'generated' ||
    session?.sessionNameSource === 'manual' ||
    session?.sessionTitleGenerationStatus === 'pending' ||
    session?.sessionTitleGenerationStatus === 'succeeded' ||
    session?.sessionTitleGenerationStatus === 'failed'
  )
}

function preserveStoredSessionTitleState(newSession, storedSession) {
  if (
    !storedSession ||
    !hasManagedSessionTitleState(storedSession) ||
    hasManagedSessionTitleState(newSession)
  ) {
    return newSession
  }

  const merged = { ...newSession }
  for (const field of SESSION_TITLE_FIELDS) {
    if (Object.hasOwn(storedSession, field)) merged[field] = storedSession[field]
  }
  return merged
}

async function persistSessions(sessions) {
  await Browser.storage.local.set({ sessions })
  return sessions
}

function findSessionIndex(sessions, sessionId) {
  return sessions.findIndex((session) => session.sessionId === sessionId)
}

export function isSessionTitleGenerationStale(session, now = Date.now()) {
  if (session?.sessionTitleGenerationStatus !== 'pending') return false
  const startedAt = Date.parse(session?.sessionTitleGenerationStartedAt || '')
  return !Number.isFinite(startedAt) || now - startedAt >= TITLE_GENERATION_STALE_MS
}

function hasProtectedSessionTitle(session) {
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
    let currentSessions
    if (newSession) {
      const ret = await getSession(newSession.sessionId)
      currentSessions = ret.currentSessions
      if (ret.session) {
        const index = findSessionIndex(currentSessions, newSession.sessionId)
        currentSessions[index] = preserveStoredSessionTitleState(newSession, currentSessions[index])
      } else {
        currentSessions.unshift(newSession)
      }
    } else {
      newSession = await initDefaultSession()
      currentSessions = await getSessions()
      currentSessions.unshift(newSession)
    }
    await Browser.storage.local.set({ sessions: currentSessions })
    return { session: newSession, currentSessions }
  })

export const deleteSession = (sessionId) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getSessions()
    const index = findSessionIndex(currentSessions, sessionId)
    if (index === -1) return currentSessions

    currentSessions.splice(index, 1)
    if (currentSessions.length > 0) {
      await Browser.storage.local.set({ sessions: currentSessions })
      return currentSessions
    }
    return await resetSessionsUnsafe()
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
    const currentSessions = await getSessions()
    const index = findSessionIndex(currentSessions, newSession.sessionId)
    if (index === -1) return currentSessions

    const mergedSession = preserveStoredSessionTitleState(newSession, currentSessions[index])
    mergedSession.updatedAt = new Date().toISOString()
    currentSessions[index] = mergedSession
    await Browser.storage.local.set({ sessions: currentSessions })
    return currentSessions
  })

export const claimSessionTitleGeneration = (sessionId) =>
  enqueueSessionMutation(async () => {
    const currentSessions = await getSessions()
    const index = findSessionIndex(currentSessions, sessionId)
    if (index === -1) return { claimed: false, session: null, currentSessions }

    const session = currentSessions[index]
    if (hasProtectedSessionTitle(session)) {
      return { claimed: false, session, currentSessions }
    }
    if (
      session.sessionTitleGenerationStatus === 'succeeded' ||
      session.sessionTitleGenerationStatus === 'failed'
    ) {
      return { claimed: false, session, currentSessions }
    }

    if (
      session.sessionTitleGenerationStatus === 'pending' &&
      !isSessionTitleGenerationStale(session)
    ) {
      return { claimed: false, session, currentSessions }
    }

    const now = new Date().toISOString()
    session.sessionTitleGenerationStatus = 'pending'
    session.sessionTitleGenerationStartedAt = now
    session.sessionTitleGenerationId = uuidv4()
    session.sessionTitleGenerationAttempts =
      Number.isFinite(session.sessionTitleGenerationAttempts)
        ? session.sessionTitleGenerationAttempts + 1
        : 1
    session.updatedAt = now
    await persistSessions(currentSessions)
    return { claimed: true, session, currentSessions }
  })

export const completeSessionTitleGeneration = (sessionId, title, generationId) =>
  enqueueSessionMutation(async () => {
    const normalizedTitle = String(title || '').trim()
    const currentSessions = await getSessions()
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
    const currentSessions = await getSessions()
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
  await Browser.storage.local.set({ sessions: currentSessions })
  return currentSessions
}

export const resetSessions = () => enqueueSessionMutation(resetSessionsUnsafe)

export const getSessions = async () => {
  const { sessions } = await Browser.storage.local.get('sessions')
  if (Array.isArray(sessions) && sessions.length > 0) {
    const migratedSessions = sessions.map(canonicalizeSessionModelFields)
    if (JSON.stringify(migratedSessions) !== JSON.stringify(sessions)) {
      await Browser.storage.local.set({ sessions: migratedSessions })
    }
    return migratedSessions
  }
  return await resetSessionsUnsafe()
}
