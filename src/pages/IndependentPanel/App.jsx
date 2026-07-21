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
import { setUserConfig } from '../../config/index.mjs'
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
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [forceExpand, setForceExpand] = useState(false)
  const currentPort = useRef(null)
  const searchInputRef = useRef(null)

  const stopCurrentPort = () => {
    if (currentPort.current) {
      try {
        currentPort.current.postMessage({ stop: true })
        currentPort.current.disconnect()
      } catch (e) {
        /* empty */
      }
      currentPort.current = null
    }
  }

  const setSessionIdSafe = async (sessionId) => {
    stopCurrentPort()
    const { session, currentSessions } = await getSession(sessionId)
    if (session && session.sessionId) {
      setSessionId(session.sessionId)
    } else if (Array.isArray(currentSessions) && currentSessions.length > 0) {
      setSessionId(currentSessions[0].sessionId)
    } else {
      setSessionId(null)
      setCurrentSession(null)
    }
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

  // Sync collapsed state from persisted config
  useEffect(() => {
    if (config && typeof config === 'object' && 'independentPanelCollapsed' in config) {
      setCollapsed(!!config.independentPanelCollapsed)
    }
  }, [config?.independentPanelCollapsed])

  useEffect(() => {
    // eslint-disable-next-line
    ;(async () => {
      if (sessions.length > 0) {
        setCurrentSession((await getSession(sessionId)).session)
      }
    })()
  }, [sessionId])

  const toggleSidebar = async () => {
    const next = !collapsed
    // Ensure temporary expansion is cleared when toggling pin state
    setForceExpand(false)
    setCollapsed(next)
    try {
      await setUserConfig({ independentPanelCollapsed: next })
    } catch (e) {
      // no-op: persist failure should not block UI toggle
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
    const next = await resetSessions()
    setSessions(next)
    if (next && next.length > 0) {
      await setSessionIdSafe(next[0].sessionId)
    } else {
      stopCurrentPort()
      setSessionId(null)
      setCurrentSession(null)
      setSearchQuery('')
      setDebouncedQuery('')
    }
  }

  const handleSearchChange = (e) => {
    const raw = e?.target?.value ?? ''
    // Keep Tab/LF/CR, remove other control chars (incl. DEL), then truncate by code points
    const CP_TAB = 9
    const CP_LF = 10
    const CP_CR = 13
    const CP_PRINTABLE_MIN = 32
    const CP_DEL = 127
    const isAllowedCodePoint = (cp) =>
      cp === CP_TAB || cp === CP_LF || cp === CP_CR || (cp >= CP_PRINTABLE_MIN && cp !== CP_DEL)
    const sanitizedArr = Array.from(raw).filter((ch) => {
      const cp = ch.codePointAt(0)
      return cp != null && isAllowedCodePoint(cp)
    })
    const limited = sanitizedArr.slice(0, 500).join('')
    setSearchQuery(limited)
  }

  // Debounce search input for performance
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 200)
    return () => clearTimeout(id)
  }, [searchQuery])

  // Track mount state to guard async setState after unmount
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Keyboard shortcuts: Ctrl/Cmd+F and '/' to focus search
  useEffect(() => {
    const focusSearch = () => {
      if (searchInputRef.current) {
        // Temporarily expand sidebar when focusing search via shortcuts
        setForceExpand(true)
        searchInputRef.current.focus()
        searchInputRef.current.select()
      }
    }
    const onKeyDown = (e) => {
      const target = e.target
      const isTypingField =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      // Always route find shortcut to panel search (and auto-expand temporarily)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        focusSearch()
        return
      }

      // Quick open search with '/' when not typing in a field
      if (!isTypingField && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === '/') {
        e.preventDefault()
        focusSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Utility function to safely convert any value to a string
  const toSafeString = (value) =>
    typeof value === 'string' ? value : value == null ? '' : String(value)

  // Normalization utility for search
  const normalizeForSearch = (value) =>
    toSafeString(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  // Precompute a normalized index for sessions to reduce per-keystroke work
  const normalizedIndex = useMemo(() => {
    if (!Array.isArray(sessions)) return []
    const SEP = '\n—\n'
    return sessions
      .filter((s) => Boolean(s?.sessionId))
      .map((s) => {
        const nameNorm = normalizeForSearch(s.sessionName)
        let bodyNorm = ''
        if (Array.isArray(s.conversationRecords)) {
          bodyNorm = s.conversationRecords
            .map((r) => `${normalizeForSearch(r?.question)} ${normalizeForSearch(r?.answer)}`)
            .join(SEP)
        }
        return { session: s, nameNorm, bodyNorm }
      })
  }, [sessions])

  // Filter sessions based on search query using the precomputed index
  const filteredSessions = useMemo(() => {
    const q = normalizeForSearch(debouncedQuery).trim()
    if (!q) return normalizedIndex.map((i) => i.session)
    return normalizedIndex
      .filter((i) => i.nameNorm.includes(q) || i.bodyNorm.includes(q))
      .map((i) => i.session)
  }, [normalizedIndex, debouncedQuery])

  return (
    <div className="IndependentPanel">
      <div className="chat-container">
        <div className={`chat-sidebar ${collapsed && !forceExpand ? 'collapsed' : ''}`}>
          <div className="chat-sidebar-button-group">
            <button
              type="button"
              className="normal-button"
              aria-expanded={!collapsed}
              onClick={toggleSidebar}
            >
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
          <div className="search-container" role="search">
            <input
              type="search"
              placeholder={t('Search conversations...')}
              value={searchQuery}
              onChange={handleSearchChange}
              className="search-input"
              aria-label={t('Search')}
              aria-controls="chat-list"
              enterKeyHint="search"
              aria-keyshortcuts="/ Control+F Meta+F"
              spellCheck={false}
              autoComplete="off"
              ref={searchInputRef}
              onFocus={() => setForceExpand(true)}
              onBlur={() => setForceExpand(false)}
            />
          </div>
          <hr />
          <div className="chat-list" id="chat-list" role="list">
            {filteredSessions.length === 0 && debouncedQuery.trim().length > 0 && (
              <div className="no-results" role="status" aria-live="polite">
                {t('No conversations found')}
              </div>
            )}
            {filteredSessions.map((session) => (
              <div role="listitem" key={session.sessionId}>
                <button
                  type="button"
                  aria-current={sessionId === session.sessionId ? 'page' : undefined}
                  className={`normal-button chat-list-item ${
                    sessionId === session.sessionId ? 'active' : ''
                  }`}
                  onClick={() => {
                    setSessionIdSafe(session.sessionId)
                  }}
                >
                  <span className="chat-list-title">{session.sessionName}</span>
                  <span
                    className="gpt-util-group"
                    onClick={(e) => {
                      e.stopPropagation()
                    }}
                  >
                    <DeleteButton
                      size={14}
                      text={t('Delete Conversation')}
                      onConfirm={async () => {
                        const deletedId = session.sessionId
                        const updatedSessions = await deleteSession(deletedId)
                        if (!isMountedRef.current) return
                        setSessions(updatedSessions)
                        if (!updatedSessions || updatedSessions.length === 0) {
                          stopCurrentPort()
                          setSessionId(null)
                          setCurrentSession(null)
                          return
                        }
                        // Only change active session if the deleted one was active
                        if (sessionId === deletedId) {
                          // When searching, prefer the next visible item in the filtered result
                          const q = normalizeForSearch(debouncedQuery).trim()
                          if (q) {
                            const SEP = '\n—\n'
                            const nextFiltered = updatedSessions.find((s) => {
                              if (!s || !s.sessionId) return false
                              const nameNorm = normalizeForSearch(s?.sessionName)
                              let bodyNorm = ''
                              if (Array.isArray(s?.conversationRecords)) {
                                bodyNorm = s.conversationRecords
                                  .map(
                                    (r) =>
                                      `${normalizeForSearch(r?.question)} ${normalizeForSearch(
                                        r?.answer,
                                      )}`,
                                  )
                                  .join(SEP)
                              }
                              return nameNorm.includes(q) || bodyNorm.includes(q)
                            })
                            if (nextFiltered) {
                              await setSessionIdSafe(nextFiltered.sessionId)
                              return
                            }
                          }
                          // Fallback to first valid item in full list
                          const next = updatedSessions.find((s) => s && s.sessionId)
                          if (next) {
                            await setSessionIdSafe(next.sessionId)
                          } else {
                            setSessionId(null)
                            setCurrentSession(null)
                          }
                        }
                      }}
                    />
                  </span>
                </button>
              </div>
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
          {currentSession && currentSession.conversationRecords && (
            <div key={currentSession.sessionId} className="chatgptbox-container">
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
