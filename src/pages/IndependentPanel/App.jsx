import {
  createSession,
  resetSessions,
  getSessions,
  updateSession,
  getSession,
  deleteSession,
} from '../../services/local-session.mjs'
import { useEffect, useRef, useState } from 'react'
import './styles.scss'
import { useConfig } from '../../hooks/use-config.mjs'
import { useTranslation } from 'react-i18next'
import ConfirmButton from '../../components/ConfirmButton'
import ConversationCard from '../../components/ConversationCard'
import DeleteButton from '../../components/DeleteButton'
import { openUrl } from '../../utils/index.mjs'
import Browser from 'webextension-polyfill'
import FileSaver from 'file-saver'

const logo = Browser.runtime.getURL('logo.png')

function App() {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(true)
  const config = useConfig(null, false)
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [currentSession, setCurrentSession] = useState(null)
  const [renderContent, setRenderContent] = useState(false)
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

  const closeSidebar = () => {
    setCollapsed(true)
  }

  const closeSidebarIfOverlay = () => {
    if (window.matchMedia('(max-width: 600px)').matches) {
      closeSidebar()
    }
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

  return (
    <div className="IndependentPanel">
      <div className={`chat-container ${collapsed ? 'sidebar-collapsed' : 'sidebar-open'}`}>
        {!collapsed && (
          <div className="chat-sidebar-backdrop" role="presentation" onClick={closeSidebar} />
        )}
        <div className={`chat-sidebar ${collapsed ? 'collapsed' : ''}`}>
          <div className="chat-sidebar-content">
            <div className="chat-sidebar-topbar">
              <img className="chat-sidebar-logo" src={logo} alt="ChatGPTBox" />
              <button
                type="button"
                className="gpt-util-icon gpt-menu-toggle chat-sidebar-close"
                aria-label="Close sidebar"
                onClick={closeSidebar}
              >
                ✕
              </button>
            </div>
            <div className="chat-sidebar-button-group">
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
                      closeSidebarIfOverlay()
                    }}
                  >
                    {session.sessionName}
                    <span className="gpt-util-group">
                      <DeleteButton
                        size={14}
                        text={t('Delete Conversation')}
                        onConfirm={() =>
                          deleteSession(session.sessionId).then((sessions) => {
                            setSessions(sessions)
                            setSessionIdSafe(sessions[0].sessionId)
                          })
                        }
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
                  closeSidebarIfOverlay()
                }}
              >
                {t('Settings')}
              </button>
            </div>
          </div>
        </div>
        <div className="chat-content">
          {renderContent && currentSession && currentSession.conversationRecords && (
            <div className="chatgptbox-container" style="height:100%;">
              <ConversationCard
                session={currentSession}
                notClampSize={true}
                pageMode={true}
                sidebarOpen={!collapsed}
                onToggleSidebar={toggleSidebar}
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
