import {
  claimSessionTitleGeneration,
  completeSessionTitleGeneration,
  createSession,
  deleteSession,
  failSessionTitleGeneration,
  getSession,
  getSessions,
  isSessionTitleGenerationStale,
  resetSessions,
  updateSession,
} from '../../services/local-session.mjs'
import {
  generateConversationTitle,
  getSessionDisplayName,
} from '../../services/session-title.mjs'
import { isConversationTitleModelAvailable } from '../../services/conversation-title-model.mjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.scss'
import { useConfig } from '../../hooks/use-config.mjs'
import { useConversationTitleConfig } from '../../hooks/use-conversation-title-config.mjs'
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
  const [conversationTitleConfig] = useConversationTitleConfig()
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [currentSession, setCurrentSession] = useState(null)
  const [renderContent, setRenderContent] = useState(false)
  const currentPort = useRef(null)
  const titleGenerationInFlightRef = useRef(new Set())

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

  const generateTitleIfNeeded = useCallback(
    async (session) => {
      const titleRuntimeConfig = { ...config, ...conversationTitleConfig }
      if (
        !conversationTitleConfig.autoGenerateConversationTitle ||
        !isConversationTitleModelAvailable(titleRuntimeConfig)
      ) {
        return
      }
      if (!session?.sessionId || titleGenerationInFlightRef.current.has(session.sessionId)) return
      if (!Array.isArray(session.conversationRecords) || session.conversationRecords.length !== 1) {
        return
      }

      const firstRecord = session.conversationRecords[0]
      if (!String(firstRecord?.question || '').trim() || !String(firstRecord?.answer || '').trim()) {
        return
      }

      titleGenerationInFlightRef.current.add(session.sessionId)
      let generationId
      try {
        const claim = await claimSessionTitleGeneration(session.sessionId)
        if (!claim.claimed) return
        setSessions([...claim.currentSessions])

        generationId = claim.session.sessionTitleGenerationId
        const title = await generateConversationTitle({
          config: titleRuntimeConfig,
          question: firstRecord.question,
          answer: firstRecord.answer,
        })
        const completed = await completeSessionTitleGeneration(
          session.sessionId,
          title,
          generationId,
        )
        setSessions([...completed.currentSessions])
      } catch (error) {
        console.warn('[conversation-title] Failed to generate a conversation title:', error)
        const failed = await failSessionTitleGeneration(session.sessionId, generationId)
        setSessions([...failed.currentSessions])
      } finally {
        titleGenerationInFlightRef.current.delete(session.sessionId)
      }
    },
    [config, conversationTitleConfig],
  )

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

  useEffect(() => {
    const selectedSession = sessions.find((session) => session.sessionId === sessionId)
    if (selectedSession) setCurrentSession(selectedSession)
  }, [sessions, sessionId])

  useEffect(() => {
    const titleRuntimeConfig = { ...config, ...conversationTitleConfig }
    if (
      !conversationTitleConfig.autoGenerateConversationTitle ||
      !isConversationTitleModelAvailable(titleRuntimeConfig)
    ) {
      return
    }

    const selectedSession = sessions.find((session) => session.sessionId === sessionId)
    const canStartOrRecover =
      selectedSession &&
      Array.isArray(selectedSession.conversationRecords) &&
      selectedSession.conversationRecords.length === 1 &&
      (selectedSession.sessionTitleGenerationStatus === undefined ||
        selectedSession.sessionTitleGenerationStatus === 'idle' ||
        isSessionTitleGenerationStale(selectedSession))
    if (canStartOrRecover) void generateTitleIfNeeded(selectedSession)
  }, [config, conversationTitleConfig, generateTitleIfNeeded, sessionId, sessions])

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
            {sessions.map((session) => {
              const displayName = getSessionDisplayName(session, t('New Chat'))
              return (
                <button
                  key={session.sessionId}
                  className={`normal-button ${sessionId === session.sessionId ? 'active' : ''}`}
                  style="display: flex; align-items: center; justify-content: space-between;"
                  title={displayName}
                  onClick={() => {
                    setSessionIdSafe(session.sessionId)
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {displayName}
                  </span>
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
              )
            })}
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
                onUpdate={(port, session, cData) => {
                  currentPort.current = port
                  if (cData.length > 0 && cData[cData.length - 1].done) {
                    void (async () => {
                      const updatedSessions = await updateSession(session)
                      const savedSession =
                        updatedSessions.find((item) => item.sessionId === session.sessionId) || session
                      setSessions(updatedSessions)
                      setCurrentSession(savedSession)
                      await generateTitleIfNeeded(savedSession)
                    })()
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
