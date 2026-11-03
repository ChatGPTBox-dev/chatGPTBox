import Browser from 'webextension-polyfill'
import { initSession } from './init-session.mjs'
import { getUserConfig } from '../config/index.mjs'
import { canonicalizeSessionModelFields } from '../config/model-key-migrations.mjs'

export const initDefaultSession = async () => {
  // Fresh, because this names the model a new conversation starts with, and the
  // panel holding it can have been open since before the user changed the model in
  // another context. A cached read here would name the previous model permanently,
  // where before this cache every call read the completed write.
  const config = await getUserConfig({ fresh: true })
  return initSession({
    sessionName: new Date().toLocaleString(),
    modelName: config.modelName,
    apiMode: config.apiMode,
    autoClean: false,
    extraCustomModelName: config.customModelName,
  })
}

export const createSession = async (newSession) => {
  let currentSessions
  if (newSession) {
    const ret = await getSession(newSession.sessionId)
    currentSessions = ret.currentSessions
    if (ret.session)
      currentSessions[
        currentSessions.findIndex((session) => session.sessionId === newSession.sessionId)
      ] = newSession
    else currentSessions.unshift(newSession)
  } else {
    newSession = await initDefaultSession()
    currentSessions = await getSessions()
    currentSessions.unshift(newSession)
  }
  await Browser.storage.local.set({ sessions: currentSessions })
  return { session: newSession, currentSessions }
}

export const deleteSession = async (sessionId) => {
  const currentSessions = await getSessions()
  const index = currentSessions.findIndex((session) => session.sessionId === sessionId)
  currentSessions.splice(index, 1)
  if (currentSessions.length > 0) {
    await Browser.storage.local.set({ sessions: currentSessions })
    return currentSessions
  }
  return await resetSessions()
}

export const getSession = async (sessionId) => {
  const currentSessions = await getSessions()
  return {
    session: currentSessions.find((session) => session.sessionId === sessionId),
    currentSessions,
  }
}

export const updateSession = async (newSession) => {
  newSession.updatedAt = new Date().toISOString()
  const currentSessions = await getSessions()
  currentSessions[
    currentSessions.findIndex((session) => session.sessionId === newSession.sessionId)
  ] = newSession
  await Browser.storage.local.set({ sessions: currentSessions })
  return currentSessions
}

export const resetSessions = async () => {
  const currentSessions = [await initDefaultSession()]
  await Browser.storage.local.set({ sessions: currentSessions })
  return currentSessions
}

export const getSessions = async () => {
  const { sessions } = await Browser.storage.local.get('sessions')
  if (Array.isArray(sessions) && sessions.length > 0) {
    const migratedSessions = sessions.map(canonicalizeSessionModelFields)
    if (JSON.stringify(migratedSessions) !== JSON.stringify(sessions)) {
      await Browser.storage.local.set({ sessions: migratedSessions })
    }
    return migratedSessions
  }
  return await resetSessions()
}
