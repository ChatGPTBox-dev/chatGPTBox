import {
  createSession,
  resetSessions,
  getSessions,
  updateSession,
  getSession,
  deleteSession,
} from '../../services/local-session.mjs'
import { useEffect, useRef, useState, useMemo } from 'react'
import './styles.scss'
import { useConfig } from '../../hooks/use-config.mjs'
import { useTranslation } from 'react-i18next'
import ConfirmButton from '../../components/ConfirmButton'
import ConversationCard from '../../components/ConversationCard'
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
  const [searchQuery, setSearchQuery] = useState('')
  const currentPort = useRef(null)

  const setSessionIdSafe = async (sessionId) => {
    if (currentPort.current) {
      try {
        currentPort.current.postMessage({ stop: true })
        currentPort.current.disconnect()
      } catch (e) {
        /* empty */
      }
      currentPort.current = null
    }
    const { session, currentSessions } = await getSession(sessionId)
    if (session) setSessionId(sessionId)
    else if (currentSessions.length > 0) setSessionId(currentSessions[0].sessionId)
  }

  useEffect(() => {
    document.documentElement.dataset.theme = config.themeMode
  }, [config.themeMode])

  useEffect(() => {
    // eslint-disable-next-line
    ;(async () => {
      const urlFrom = new URLSearchParams(window.location.search).get('from')
      const sessions = await getSessions()
      if (
        urlFrom !== 'store' &&
        sessions[0].conversationRecords &&
        sessions[0].conversationRecords.length > 0
      ) {
        await createNewChat()
      } else {
        setSessions(sessions)
        await setSessionIdSafe(sessions[0].sessionId)
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
        setCurrentSession((await getSession(sessionId)).session)
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
    const { session, currentSessions } = await createSession()
    setSessions(currentSessions)
    await setSessionIdSafe(session.sessionId)
  }

  const exportConversations = async () => {
    const sessions = await getSessions()
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'text/json;charset=utf-8' })
    FileSaver.saveAs(blob, 'conversations.json')
  }

  const clearConversations = async () => {
    const sessions = await resetSessions()
    setSessions(sessions)
    await setSessionIdSafe(sessions[0].sessionId)
  }

  // Utility function to safely convert any value to a string
  const toSafeString = (value) =>
    typeof value === 'string' ? value : value == null ? '' : String(value)

  // Filter sessions based on search query (memoized for performance)
  const filteredSessions = useMemo(() => {
    const query = toSafeString(searchQuery).trim().toLowerCase()
    if (!query) return sessions

    return sessions.filter((session) => {
      // Search in session name
      const sessionName = toSafeString(session.sessionName).toLowerCase()
      if (sessionName.includes(query)) {
        return true
      }

      // Search in conversation records
      if (Array.isArray(session.conversationRecords)) {
        return session.conversationRecords.some((record) => {
          const question = toSafeString(record?.question).toLowerCase()
          const answer = toSafeString(record?.answer).toLowerCase()
          return question.includes(query) || answer.includes(query)
        })
      }

      return false
    })
  }, [sessions, searchQuery])

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
          <div className="search-container">
            <input
              type="search"
              placeholder={t('Search conversations...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
              aria-label={t('Search')}
              autoComplete="off"
            />
          </div>
          <div className="chat-list">
            {filteredSessions.map((session, index) => (
              <button
                key={session.sessionId || `session-${index}`}
                className={`normal-button ${sessionId === session.sessionId ? 'active' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
                onClick={() => {
                  setSessionIdSafe(session.sessionId)
                }}
              >
                {session.sessionName}
                <span className="gpt-util-group">
                  <DeleteButton
                    size={14}
                    text={t('Delete Conversation')}
                    onConfirm={async () => {
                      const updatedSessions = await deleteSession(session.sessionId)
                      setSessions(updatedSessions)
                      if (updatedSessions && updatedSessions.length > 0) {
                        await setSessionIdSafe(updatedSessions[0].sessionId)
                      } else {
                        // No sessions left after deletion
                        setSessionId(null)
                        setCurrentSession(null)
                      }
                    }}
                  />
                </span>
              </button>
            ))}
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
            <div className="chatgptbox-container" style={{ height: '100%' }}>
              <ConversationCard
                session={currentSession}
                notClampSize={true}
                pageMode={true}
                onUpdate={(port, session, cData) => {
                  currentPort.current = port
                  if (cData.length > 0 && cData[cData.length - 1].done) {
                    updateSession(session).then(setSessions)
                    setCurrentSession(session)
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
