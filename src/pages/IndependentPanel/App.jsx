import {
  createSession,
  resetSessions,
  getSessions,
  updateSession,
  getSession,
  deleteSession,
} from '../../services/local-session-client.mjs'
import { useEffect, useRef, useState } from 'react'
import './styles.scss'
import { useConfig } from '../../hooks/use-config.mjs'
import { useTranslation } from 'react-i18next'
import ConfirmButton from '../../components/ConfirmButton'
import ConversationCard from '../../components/ConversationCard'
import { getSessionContentRevision } from '../../components/ConversationCard/session.mjs'
import DeleteButton from '../../components/DeleteButton'
import { openUrl } from '../../utils/index.mjs'
import Browser from 'webextension-polyfill'
import FileSaver from 'file-saver'

function App() {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(true)
  const config = useConfig(null, false)
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [currentSession, setCurrentSession] = useState(null)
  const [renderContent, setRenderContent] = useState(false)
  const currentPort = useRef(null)
  const activeSessionIdRef = useRef(null)
  const selectionGenerationRef = useRef(0)
  const persistQueueRef = useRef(Promise.resolve())
  const lastPersistedSnapshotRef = useRef('')
  const lastRequestedSnapshotRef = useRef('')
  const rejectedSnapshotRef = useRef('')
  const lastSettledUnsafeSnapshotRef = useRef('')

  const enqueueSessionMutation = (operation) => {
    persistQueueRef.current = persistQueueRef.current.catch(() => {}).then(operation)
    return persistQueueRef.current
  }

  const sessionFingerprint = (session) => JSON.stringify({ ...session, updatedAt: undefined })

  const getPersistedSession = (id) => {
    if (!lastPersistedSnapshotRef.current) return null
    const previous = JSON.parse(lastPersistedSnapshotRef.current)
    return previous.sessionId === id ? previous : null
  }

  const getPersistedApiMode = (id) => {
    const previous = lastRequestedSnapshotRef.current
      ? JSON.parse(lastRequestedSnapshotRef.current)
      : null
    const apiMode = previous?.sessionId === id ? previous.apiMode : null
    if (apiMode?.groupName !== 'customApiModelKeys') return null
    const { groupName, itemName, customName, isCustom, customUrl, providerId } = apiMode
    return { groupName, itemName, customName, isCustom, customUrl, providerId }
  }

  const persistSession = (session, { completed, cleared }) => {
    const snapshot = { ...session }
    return enqueueSessionMutation(async () => {
      const fingerprint = sessionFingerprint(snapshot)
      if (
        fingerprint === lastRequestedSnapshotRef.current ||
        fingerprint === rejectedSnapshotRef.current
      )
        return
      const previous = getPersistedSession(snapshot.sessionId)
      const writeMode =
        cleared &&
        previous &&
        (snapshot.createdAt !== previous.createdAt || previous.conversationRecords.length > 0)
          ? 'clear'
          : completed || cleared
          ? 'full'
          : 'unsafe'
      if (writeMode === 'unsafe' && fingerprint === lastSettledUnsafeSnapshotRef.current) return
      const nextSessions = await updateSession(
        snapshot,
        getPersistedApiMode(snapshot.sessionId),
        getSessionContentRevision(previous),
        writeMode,
      )
      // An acknowledged safety-only no-op is not a successful full transcript save.
      // Cache it separately so storage failures and later completed turns can still retry.
      if (activeSessionIdRef.current === snapshot.sessionId) {
        lastSettledUnsafeSnapshotRef.current = writeMode === 'unsafe' ? fingerprint : ''
      }
      const saved = nextSessions.find((item) => item.sessionId === snapshot.sessionId)
      if (
        saved &&
        getSessionContentRevision(saved) === getSessionContentRevision(snapshot) &&
        (snapshot.geminiWeb_conversationUnsafe !== true ||
          saved.geminiWeb_conversationUnsafe === true)
      ) {
        if (activeSessionIdRef.current === snapshot.sessionId) {
          lastPersistedSnapshotRef.current = sessionFingerprint(saved)
          if (writeMode !== 'unsafe') {
            lastRequestedSnapshotRef.current = fingerprint
            rejectedSnapshotRef.current = ''
          }
        }
      } else if (completed || cleared) {
        // Do not rebase stale local history onto the newer stored transcript.
        if (activeSessionIdRef.current === snapshot.sessionId)
          rejectedSnapshotRef.current = fingerprint
        if (
          window.confirm(
            t(
              'This conversation changed elsewhere and was not saved. Export your unsaved conversation before reopening it?',
            ),
          )
        ) {
          const blob = new Blob([JSON.stringify([snapshot], null, 2)], {
            type: 'text/json;charset=utf-8',
          })
          FileSaver.saveAs(blob, 'unsaved-conversation.json')
        }
      }
      setSessions(nextSessions)
    })
  }

  const setSessionIdSafe = async (nextSessionId) => {
    const generation = ++selectionGenerationRef.current
    await persistQueueRef.current.catch(() => {})
    const { session, currentSessions } = await getSession(nextSessionId)
    if (generation !== selectionGenerationRef.current) return
    const target = session?.sessionId ?? currentSessions[0]?.sessionId
    if (!target || target === activeSessionIdRef.current) return
    activeSessionIdRef.current = target
    if (currentPort.current) {
      try {
        currentPort.current.postMessage({ stop: true })
        currentPort.current.disconnect()
      } catch (e) {
        /* empty */
      }
      currentPort.current = null
    }
    setSessionId(target)
  }

  useEffect(() => {
    document.documentElement.dataset.theme = config.themeMode
  }, [config.themeMode])

  useEffect(() => {
    // eslint-disable-next-line
    ;(async () => {
      const params = new URLSearchParams(window.location.search)
      const urlFrom = params.get('from')
      const sessions = await getSessions()
      if (
        urlFrom !== 'store' &&
        sessions[0].conversationRecords &&
        sessions[0].conversationRecords.length > 0
      ) {
        await createNewChat()
      } else {
        setSessions(sessions)
        const archived =
          urlFrom === 'store' && sessions.find((item) => item.sessionId === params.get('sessionId'))
        await setSessionIdSafe((archived || sessions[0]).sessionId)
      }
    })()
  }, [])

  useEffect(() => {
    if ('sessions' in config && config['sessions']) setSessions(config['sessions'])
  }, [config])

  useEffect(() => {
    // eslint-disable-next-line
    ;(async () => {
      if (sessions.length > 0) {
        const { session } = await getSession(sessionId)
        if (activeSessionIdRef.current !== sessionId) return
        lastPersistedSnapshotRef.current = session ? sessionFingerprint(session) : ''
        lastRequestedSnapshotRef.current = lastPersistedSnapshotRef.current
        rejectedSnapshotRef.current = ''
        lastSettledUnsafeSnapshotRef.current = ''
        setCurrentSession(session)
        setRenderContent(false)
        setTimeout(() => {
          setRenderContent(true)
        })
      }
    })()
  }, [sessionId])

  const toggleSidebar = () => {
    setCollapsed(!collapsed)
  }

  const createNewChat = async () => {
    const { session, currentSessions } = await enqueueSessionMutation(() => createSession())
    setSessions(currentSessions)
    await setSessionIdSafe(session.sessionId)
  }

  const exportConversations = async () => {
    await persistQueueRef.current.catch(() => {})
    const sessions = await getSessions()
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'text/json;charset=utf-8' })
    FileSaver.saveAs(blob, 'conversations.json')
  }

  const clearConversations = async () => {
    const sessions = await enqueueSessionMutation(() => resetSessions())
    setSessions(sessions)
    await setSessionIdSafe(sessions[0].sessionId)
  }

  return (
    <div className="IndependentPanel">
      <div className="chat-container">
        <div className={`chat-sidebar ${collapsed ? 'collapsed' : ''}`}>
          <div className="chat-sidebar-button-group">
            <button className="normal-button" onClick={toggleSidebar}>
              {collapsed ? t('Pin') : t('Unpin')}
            </button>
            <button className="normal-button" onClick={createNewChat}>
              {t('New Chat')}
            </button>
            <button className="normal-button" onClick={exportConversations}>
              {t('Export')}
            </button>
          </div>
          <hr />
          <div className="chat-list">
            {sessions.map(
              (
                session,
                index, // TODO editable session name
              ) => (
                <button
                  key={index}
                  className={`normal-button ${sessionId === session.sessionId ? 'active' : ''}`}
                  style="display: flex; align-items: center; justify-content: space-between;"
                  onClick={() => {
                    setSessionIdSafe(session.sessionId)
                  }}
                >
                  {session.sessionName}
                  <span className="gpt-util-group">
                    <DeleteButton
                      size={14}
                      text={t('Delete Conversation')}
                      onConfirm={() => {
                        const selectionGeneration = selectionGenerationRef.current
                        return enqueueSessionMutation(() => deleteSession(session.sessionId)).then(
                          (nextSessions) => {
                            setSessions(nextSessions)
                            if (
                              selectionGenerationRef.current === selectionGeneration &&
                              activeSessionIdRef.current === session.sessionId &&
                              !nextSessions.some((item) => item.sessionId === session.sessionId)
                            ) {
                              return setSessionIdSafe(nextSessions[0].sessionId)
                            }
                          },
                        )
                      }}
                    />
                  </span>
                </button>
              ),
            )}
          </div>
          <hr />
          <div className="chat-sidebar-button-group">
            <ConfirmButton text={t('Clear conversations')} onConfirm={clearConversations} />
            <button
              className="normal-button"
              onClick={() => {
                openUrl(Browser.runtime.getURL('popup.html'))
              }}
            >
              {t('Settings')}
            </button>
          </div>
        </div>
        <div className="chat-content">
          {renderContent && currentSession && currentSession.conversationRecords && (
            <div className="chatgptbox-container" style="height:100%;">
              <ConversationCard
                session={currentSession}
                notClampSize={true}
                pageMode={true}
                getPersistedApiMode={getPersistedApiMode}
                onUpdate={(port, session, cData) => {
                  const isActive = activeSessionIdRef.current === session.sessionId
                  if (isActive) currentPort.current = port
                  const completed = cData.length > 0 && cData[cData.length - 1].done
                  const cleared =
                    cData.length === 0 &&
                    session.conversationRecords.length === 0 &&
                    session.question == null
                  if (completed || cleared || session.geminiWeb_conversationUnsafe === true) {
                    persistSession(session, { completed, cleared }).catch((error) => {
                      console.error('[IndependentPanel] Failed to save conversation:', error)
                      if (
                        (completed || cleared) &&
                        window.confirm(`${t('Error')}: ${error.message || error}\n${t('Export')}?`)
                      ) {
                        const blob = new Blob([JSON.stringify([session], null, 2)], {
                          type: 'text/json;charset=utf-8',
                        })
                        FileSaver.saveAs(blob, 'unsaved-conversation.json')
                      }
                    })
                    if (isActive && (completed || cleared)) setCurrentSession(session)
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
