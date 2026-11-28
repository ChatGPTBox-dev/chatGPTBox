import Browser from 'webextension-polyfill'
import { initSession } from './init-session.mjs'
import { getUserConfig } from '../config/index.mjs'
import { getSessionContentRevision } from '../components/ConversationCard/session.mjs'
import { getGeminiContinuationRevision } from './apis/gemini-web-continuation.mjs'
import { getAllOpenAIProviders, getProviderById } from './apis/provider-registry.mjs'
import { canonicalizeSessionModelFields } from '../config/model-key-migrations.mjs'
import { resolveCommittedMigratedSessions } from '../popup/sections/general-provider-override-utils.mjs'
import { rollbackProviderSecretOverrideSessionMigration } from '../popup/sections/provider-secret-utils.mjs'
import { importDataIntoStorage } from '../popup/sections/import-data-cleanup.mjs'

export const initDefaultSession = async () => {
  const config = await getUserConfig()
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

// A floating card may retry an archive after losing the write acknowledgement.
// Never expose the stored conversation list or overwrite an existing archive.
async function archiveSession(session) {
  if (
    !session ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    typeof session.sessionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      session.sessionId,
    ) ||
    !Array.isArray(session.conversationRecords)
  )
    throw new Error('Invalid archive session')
  const currentSessions = await getSessions()
  if (!currentSessions.some((stored) => stored.sessionId === session.sessionId)) {
    currentSessions.unshift(session)
    await Browser.storage.local.set({ sessions: currentSessions })
  }
  return null
}

export const deleteSession = async (sessionId) => {
  const currentSessions = await getSessions()
  const index = currentSessions.findIndex((session) => session.sessionId === sessionId)
  if (index === -1) return currentSessions
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

// A mounted panel can still hold the provider ID that existed before an
// override migration. Preserve the stored provider binding if the panel did
// not change its selection. A deliberate mode change remains authoritative.
function sameCustomModeRow(left, right) {
  return (
    left?.groupName === 'customApiModelKeys' &&
    right?.groupName === left.groupName &&
    (left.itemName ?? '') === (right.itemName ?? '') &&
    (left.customName ?? '') === (right.customName ?? '') &&
    Boolean(left.isCustom) === Boolean(right.isCustom) &&
    (left.customUrl ?? '') === (right.customUrl ?? '')
  )
}

export function reconcileStoredProviderMode(requestedMode, storedMode, baselineMode, config) {
  if (
    sameCustomModeRow(requestedMode, baselineMode) &&
    sameCustomModeRow(storedMode, baselineMode) &&
    (requestedMode.providerId ?? '') === (baselineMode.providerId ?? '') &&
    (storedMode.providerId ?? '') !== (baselineMode.providerId ?? '')
  ) {
    return storedMode
  }
  // A disabled provider is still configured; never reroute an explicit selection.
  const normalizeId = (value) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const requestedId = normalizeId(requestedMode?.providerId)
  const isConfigured =
    config &&
    requestedId &&
    getAllOpenAIProviders(config).some((provider) =>
      [provider.id, ...(provider.legacyProviderIds ?? [])].some(
        (id) => normalizeId(id) === requestedId,
      ),
    )
  // An override rolled back while the card was mounted is no longer configured.
  if (
    config &&
    baselineMode &&
    sameCustomModeRow(requestedMode, storedMode) &&
    requestedMode.providerId !== storedMode.providerId &&
    requestedMode.providerId &&
    !isConfigured &&
    getProviderById(config, storedMode.providerId)
  ) {
    return storedMode
  }
  return requestedMode
}

export const updateSession = async (
  newSession,
  baselineMode,
  expectedRevision,
  writeMode = 'full',
) => {
  const currentSessions = await getSessions()
  const index = currentSessions.findIndex((session) => session.sessionId === newSession.sessionId)
  if (index === -1) return currentSessions
  const stored = currentSessions[index]
  // Safety notices and stale writes must never replace a transcript edited in another panel.
  // Clearing is destructive and requires a matching baseline even when no revision was supplied.
  if (
    writeMode === 'unsafe' ||
    ((writeMode === 'clear' || expectedRevision !== undefined) &&
      expectedRevision !== getSessionContentRevision(stored))
  ) {
    const incoming = getGeminiContinuationRevision(
      newSession.geminiWeb_conversation ?? newSession.bard_conversationObj,
    )
    const current = getGeminiContinuationRevision(
      stored.geminiWeb_conversation ?? stored.bard_conversationObj,
    )
    if (
      newSession.geminiWeb_conversationUnsafe === true &&
      incoming &&
      incoming === current &&
      stored.geminiWeb_conversationUnsafe !== true
    ) {
      currentSessions[index] = {
        ...stored,
        geminiWeb_conversationUnsafe: true,
        updatedAt: new Date().toISOString(),
      }
      await Browser.storage.local.set({ sessions: currentSessions })
    }
    return currentSessions
  }
  let apiMode = reconcileStoredProviderMode(newSession.apiMode, stored.apiMode, baselineMode)
  if (
    apiMode === newSession.apiMode &&
    baselineMode &&
    sameCustomModeRow(apiMode, stored.apiMode) &&
    apiMode.providerId !== stored.apiMode.providerId
  ) {
    apiMode = reconcileStoredProviderMode(
      apiMode,
      stored.apiMode,
      baselineMode,
      await getUserConfig(),
    )
  }
  const incomingRevision = getGeminiContinuationRevision(
    newSession.geminiWeb_conversation ?? newSession.bard_conversationObj,
  )
  const preserveUnsafe =
    writeMode !== 'clear' &&
    stored.geminiWeb_conversationUnsafe === true &&
    (!incomingRevision ||
      incomingRevision ===
        getGeminiContinuationRevision(stored.geminiWeb_conversation ?? stored.bard_conversationObj))
  currentSessions[index] = {
    ...newSession,
    ...(preserveUnsafe ? { geminiWeb_conversationUnsafe: true } : {}),
    ...(apiMode !== newSession.apiMode ? { apiMode } : {}),
    updatedAt: new Date().toISOString(),
  }
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

async function loadStoredSessions() {
  const { sessions } = await Browser.storage.local.get('sessions')
  return Array.isArray(sessions) ? sessions : []
}

async function migrateProviderOverrideSessions(migration) {
  const result = await resolveCommittedMigratedSessions(
    async () => ({ ok: true, sessions: await loadStoredSessions() }),
    migration,
  )
  if (!result?.ok || !Array.isArray(result.migratedSessions)) {
    return { ...result, ok: false, changed: false }
  }
  const changed = result.migratedSessions !== result.sessions
  if (changed) await Browser.storage.local.set({ sessions: result.migratedSessions })
  return { ...result, changed }
}

async function rollbackProviderOverrideSessions(originalSessions, migration) {
  const sessions = await loadStoredSessions()
  const rolledBackSessions = rollbackProviderSecretOverrideSessionMigration(
    sessions,
    originalSessions,
    migration,
  )
  if (rolledBackSessions !== sessions) {
    await Browser.storage.local.set({ sessions: rolledBackSessions })
  }
}

async function importLocalData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid backup file')
  }
  // Include normalization, existing-secret reads and writes in the same queue.
  await importDataIntoStorage(Browser.storage.local, data)
  return null
}

// All extension pages and content scripts use the background's single queue.
// Reads that initialize/migrate the list must be serialized with writes as well.
const sessionOperations = {
  createSession,
  archiveSession,
  importLocalData,
  deleteSession,
  getSession,
  getSessions,
  resetSessions,
  updateSession,
  migrateProviderOverrideSessions,
  rollbackProviderOverrideSessions,
}
let sessionQueue = Promise.resolve()

export function runLocalSessionOperation(operation, args = []) {
  if (!Object.hasOwn(sessionOperations, operation) || !Array.isArray(args)) {
    return Promise.reject(new Error('Invalid local session operation'))
  }
  const result = sessionQueue.then(() => sessionOperations[operation](...args))
  sessionQueue = result.catch(() => {})
  return result
}

// Content scripts need only the write-only archive operation. Full session
// management and backup import are reserved for extension-owned documents.
export async function handleLocalSessionMessage(data, sender) {
  const extensionRoot = Browser.runtime.getURL('').replace(/\/?$/, '/')
  const senderUrl = sender?.url || sender?.documentUrl || sender?.origin
  const isExtensionPage =
    typeof senderUrl === 'string' &&
    (senderUrl === extensionRoot.slice(0, -1) || senderUrl.startsWith(extensionRoot))
  const sameExtension = Boolean(sender?.id) && sender.id === Browser.runtime.id
  if (!sameExtension && (sender?.id || !isExtensionPage)) return { ok: false }
  if (!isExtensionPage && data?.operation !== 'archiveSession') return { ok: false }
  if (data?.operation === 'archiveSession' && data?.args?.length !== 1) return { ok: false }

  try {
    const value = await runLocalSessionOperation(data?.operation, data?.args)
    return { ok: true, value }
  } catch (error) {
    console.error('[background] Local session operation failed:', error)
    return { ok: false }
  }
}

// Used by the background port listener without importing the session queue into content scripts.
export async function resolveStoredProviderMode(session, baselineMode, config) {
  const { session: storedSession } = await runLocalSessionOperation('getSession', [
    session.sessionId,
  ])
  return reconcileStoredProviderMode(session.apiMode, storedSession?.apiMode, baselineMode, config)
}
