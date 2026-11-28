import Browser from 'webextension-polyfill'

async function requestLocalSession(operation, ...args) {
  const response = await Browser.runtime.sendMessage({
    type: 'LOCAL_SESSION',
    data: { operation, args },
  })
  if (response?.ok !== true) throw new Error('Could not access local conversations')
  return response.value
}

export const createSession = (session) =>
  session === undefined
    ? requestLocalSession('createSession')
    : requestLocalSession('archiveSession', session)
export const importLocalData = (data) => requestLocalSession('importLocalData', data)
export const deleteSession = (sessionId) => requestLocalSession('deleteSession', sessionId)
export const getSession = (sessionId) => requestLocalSession('getSession', sessionId)
export const getSessions = () => requestLocalSession('getSessions')
export const resetSessions = () => requestLocalSession('resetSessions')
// An explicit null revision means there is no trusted baseline, not an unguarded full write.
export const updateSession = (session, baselineMode, expectedRevision, writeMode = 'full') =>
  requestLocalSession(
    'updateSession',
    session,
    baselineMode ?? null,
    ...(expectedRevision === undefined && writeMode === 'full'
      ? []
      : [expectedRevision ?? null, writeMode]),
  )

export const migrateProviderOverrideSessions = (migration) =>
  requestLocalSession('migrateProviderOverrideSessions', migration)
export const rollbackProviderOverrideSessions = (originalSessions, migration) =>
  requestLocalSession('rollbackProviderOverrideSessions', originalSessions, migration)
