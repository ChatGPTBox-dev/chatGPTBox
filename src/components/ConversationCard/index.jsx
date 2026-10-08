import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'
import InputBox from '../InputBox'
import ConversationItem from '../ConversationItem'
import {
  apiModeToModelName,
  createElementAtPosition,
  getApiModesFromConfig,
  getUniquelySelectedApiModeIndex,
  isFirefox,
  isMobile,
  isSafari,
  isUsingModelName,
  modelNameToDesc,
} from '../../utils'
import {
  ArchiveIcon,
  DesktopDownloadIcon,
  LinkExternalIcon,
  MoveToBottomIcon,
  SearchIcon,
} from '@primer/octicons-react'
import { Pin, WindowDesktop, XLg } from 'react-bootstrap-icons'
import FileSaver from 'file-saver'
import { render } from 'preact'
import FloatingToolbar from '../FloatingToolbar'
import { useClampWindowSize } from '../../hooks/use-clamp-window-size'
import { getUserConfig, isUsingBingWebModel, Models } from '../../config/index.mjs'
import { useTranslation } from 'react-i18next'
import DeleteButton from '../DeleteButton'
import { useConfig } from '../../hooks/use-config.mjs'
import { createSession } from '../../services/local-session.mjs'
import { v4 as uuidv4 } from 'uuid'
import { initSession } from '../../services/init-session.mjs'
import { findLastIndex } from 'lodash-es'
import { generateAnswersWithBingWebApi } from '../../services/apis/bing-web.mjs'
import { handlePortError } from '../../services/wrappers.mjs'
import {
  getApiModeDisplayLabel,
  getConversationAiName,
} from '../../popup/sections/api-modes-provider-utils.mjs'
import { getDisplayErrorText } from '../../utils/error-text.mjs'
import {
  createConversationPortMessage,
  createRetrySession,
  finalizeInterruptedSession,
  getCompletedAnswerContent,
  getInterruptedCompletionState,
  isSupersededGenerationMessage,
  isSupersededRequestMessage,
} from './session.mjs'
import { createFrameScheduler, createStreamBuffer } from './stream-buffer.mjs'
import { waitingPlaceholder } from '../MarkdownRender/waiting-placeholder.mjs'

const logo = Browser.runtime.getURL('logo.png')
const UNMATCHED_API_MODE_VALUE = '__current-session-api-mode__'

class ConversationItemData extends Object {
  /**
   * @param {'question'|'answer'|'error'} type
   * @param {string} content
   * @param {bool} done
   */
  constructor(type, content, done = false, reasoning = '') {
    super()
    this.type = type
    this.content = content
    this.done = done
    this.reasoning = reasoning
  }
}

function ConversationCard(props) {
  const { t } = useTranslation()
  const [isReady, setIsReady] = useState(!props.question)
  const [port, setPort] = useState(() => Browser.runtime.connect())
  const [triggered, setTriggered] = useState(!props.waitForTrigger)
  const [session, setSession] = useState(props.session)
  const windowSize = useClampWindowSize([750, 1500], [250, 1100])
  const bodyRef = useRef(null)
  const replacedPortRef = useRef(null)
  const partialAnswerRef = useRef('')
  const retryRecordRef = useRef(null)
  const retryGenerationIdRef = useRef(0)
  const requestGenerationIdRef = useRef(0)
  const disposedRef = useRef(false)
  const portRef = useRef(port)
  const foregroundMessageListeners = useRef([])
  const foregroundPortsRef = useRef(new Set())
  const [completeDraggable, setCompleteDraggable] = useState(false)
  const useForegroundFetch = isUsingBingWebModel(session)
  const [apiModes, setApiModes] = useState([])

  /**
   * @type {[ConversationItemData[], (conversationItemData: ConversationItemData[]) => void]}
   */
  const [conversationItemData, setConversationItemData] = useState([])
  const config = useConfig()
  const customOpenAIProviders = Array.isArray(config.customOpenAIProviders)
    ? config.customOpenAIProviders
    : []
  const currentAiName = getConversationAiName(session, t, customOpenAIProviders)
  const selectedApiModeIndex = useMemo(
    () => getUniquelySelectedApiModeIndex(apiModes, session, { sessionCompat: true }),
    [apiModes, session],
  )
  const selectedApiModeLabel =
    selectedApiModeIndex !== -1
      ? getApiModeDisplayLabel(apiModes[selectedApiModeIndex], t, customOpenAIProviders)
      : ''
  const selectedApiModeValue = selectedApiModeLabel
    ? String(selectedApiModeIndex)
    : !session.apiMode && session.modelName === 'customModel'
    ? '-1'
    : UNMATCHED_API_MODE_VALUE

  const disposeOwnedTransports = () => {
    if (disposedRef.current) return
    disposedRef.current = true
    requestGenerationIdRef.current += 1
    retryGenerationIdRef.current += 1

    const foregroundPorts = Array.from(foregroundPortsRef.current)
    foregroundPortsRef.current.clear()
    for (const foregroundPort of foregroundPorts) foregroundPort.disconnect()
    foregroundMessageListeners.current = []

    try {
      portRef.current?.disconnect()
    } catch (e) {
      // The runtime Port may already be disconnected.
    }
  }

  useLayoutEffect(() => {
    portRef.current = port
  }, [port])

  useLayoutEffect(() => {
    disposedRef.current = false
    return () => {
      disposeOwnedTransports()
    }
  }, [])

  useLayoutEffect(() => {
    if (session.conversationRecords.length === 0) {
      if (props.question && triggered)
        setConversationItemData([new ConversationItemData('answer', waitingPlaceholder(t))])
    } else {
      const ret = []
      for (const record of session.conversationRecords) {
        ret.push(new ConversationItemData('question', record.question, true))
        ret.push(new ConversationItemData('answer', record.answer, true))
      }
      setConversationItemData(ret)
    }
  }, [])

  useEffect(() => {
    setCompleteDraggable(!isSafari() && !isFirefox() && !isMobile())
  }, [])

  useEffect(() => {
    if (props.onUpdate) props.onUpdate(port, session, conversationItemData)
  }, [port, session, conversationItemData])

  useEffect(() => {
    const { offsetHeight, scrollHeight, scrollTop } = bodyRef.current
    if (
      config.lockWhenAnswer &&
      scrollHeight <= scrollTop + offsetHeight + config.answerScrollMargin
    ) {
      bodyRef.current.scrollTo({
        top: scrollHeight,
        behavior: 'instant',
      })
    }
  }, [conversationItemData])

  useEffect(async () => {
    // when the page is responsive, session may accumulate redundant data and needs to be cleared after remounting and before making a new request
    if (props.question && triggered) {
      const newSession = initSession({ ...session, question: props.question })
      partialAnswerRef.current = ''
      retryRecordRef.current = null
      streamBufferRef.current.discard()
      setSession(newSession)
      await postMessage({ session: newSession })
    }
  }, [props.question, triggered]) // usually only triggered once

  useLayoutEffect(() => {
    setApiModes(getApiModesFromConfig(config, true))
  }, [
    config.activeApiModes,
    config.customApiModes,
    config.azureDeploymentName,
    config.ollamaModelName,
  ])

  /**
   * @param {string} value
   * @param {boolean} appended
   * @param {'question'|'answer'|'error'} newType
   * @param {boolean} done
   * @param {string} [reasoning] reasoning for the replacement; omit to keep the existing one
   */
  const updateAnswer = (value, appended, newType, done = false, reasoning) => {
    setConversationItemData((old) => {
      const copy = [...old]
      const index = findLastIndex(copy, (v) => v.type === 'answer' || v.type === 'error')
      if (index === -1) return copy
      copy[index] = new ConversationItemData(
        newType,
        appended ? copy[index].content + value : value,
        done,
        reasoning === undefined ? copy[index].reasoning : reasoning,
      )
      return copy
    })
  }

  /**
   * Write the newest streamed text onto the trailing answer item. The reasoning rides in the
   * same patch as the answer, so a frame that carries both is a single state update.
   * @param {{content?: string, reasoning?: string, done?: boolean}} patch
   */
  const updateStreamItem = ({ content, reasoning, done }) => {
    setConversationItemData((old) => {
      const index = findLastIndex(old, (v) => v.type === 'answer')
      if (index === -1) return old
      const item = old[index]
      const copy = [...old]
      copy[index] = new ConversationItemData(
        item.type,
        content === undefined ? item.content : content,
        done === undefined ? item.done : done,
        reasoning === undefined ? item.reasoning : reasoning,
      )
      return copy
    })
  }

  /**
   * Finish the trailing answer once the stream has ended.
   *
   * Replacing the content with what the stream buffered is what clears a loading placeholder
   * left by a reasoning-only turn. Resolving that against the item's current content keeps a
   * duplicate, contentless completion from blanking a reply that is already on screen.
   * @param {string|null} restoredRetryAnswer
   * @param {string} partialAnswer
   */
  const finishAnswer = (restoredRetryAnswer, partialAnswer) => {
    setConversationItemData((old) => {
      const index = findLastIndex(old, (v) => v.type === 'answer' || v.type === 'error')
      if (index === -1) return old
      const item = old[index]
      const copy = [...old]
      copy[index] = new ConversationItemData(
        'answer',
        getCompletedAnswerContent(
          restoredRetryAnswer,
          partialAnswer,
          item.content,
          waitingPlaceholder(t),
        ),
        true,
        item.reasoning,
      )
      return copy
    })
  }

  const streamBufferRef = useRef(null)
  if (streamBufferRef.current === null) {
    streamBufferRef.current = createStreamBuffer({
      ...createFrameScheduler(),
      render: updateStreamItem,
    })
  }

  // A buffered frame can outlive a hidden page, so drop it when the card goes away.
  useEffect(() => {
    return () => streamBufferRef.current?.discard()
  }, [])

  const portMessageListener = (msg) => {
    if (disposedRef.current) return
    if (isSupersededRequestMessage(msg, requestGenerationIdRef.current)) return
    if (isSupersededGenerationMessage(msg, retryGenerationIdRef.current)) return

    // Only a missing field means "nothing to update for this channel": the answer may
    // legitimately arrive as an empty string.
    if (typeof msg.answer === 'string') {
      partialAnswerRef.current = msg.answer
      streamBufferRef.current.push({ content: msg.answer })
    }
    if (msg.reasoning) streamBufferRef.current.push({ reasoning: msg.reasoning })
    if (msg.session) {
      setSession(msg.done ? { ...msg.session, isRetry: false } : msg.session)
    }
    if (msg.done) {
      streamBufferRef.current.flush()
      const partialAnswer = partialAnswerRef.current
      const retryRecord = retryRecordRef.current
      const completionState = getInterruptedCompletionState(msg, partialAnswer, retryRecord)
      if (completionState.shouldFinalize) {
        setSession((currentSession) =>
          finalizeInterruptedSession(currentSession, partialAnswer, retryRecord),
        )
      }
      partialAnswerRef.current = ''
      retryRecordRef.current = null
      finishAnswer(completionState.restoredRetryAnswer, partialAnswer)
      setIsReady(true)
    }
    if (msg.error) {
      // The stream ended in an error: close the trailing answer so its reasoning block is
      // not left open forever.
      streamBufferRef.current.push({ done: true })
      streamBufferRef.current.flush()
      const retryRecord = retryRecordRef.current
      setSession((currentSession) => finalizeInterruptedSession(currentSession, '', retryRecord))
      switch (msg.error) {
        case 'UNAUTHORIZED':
          updateAnswer(
            `${t('UNAUTHORIZED')}<br>${t('Please login at https://chatgpt.com first')}${
              isSafari() ? `<br>${t('Then open https://chatgpt.com/api/auth/session')}` : ''
            }<br>${t('And refresh this page or type you question again')}` +
              `<br><br>${t(
                'Consider creating an api key at https://platform.openai.com/account/api-keys',
              )}`,
            false,
            'error',
            false,
            '',
          )
          break
        case 'CLOUDFLARE':
          updateAnswer(
            `${t('OpenAI Security Check Required')}<br>${
              isSafari()
                ? t('Please open https://chatgpt.com/api/auth/session')
                : t('Please open https://chatgpt.com')
            }<br>${t('And refresh this page or type you question again')}` +
              `<br><br>${t(
                'Consider creating an api key at https://platform.openai.com/account/api-keys',
              )}`,
            false,
            'error',
            false,
            '',
          )
          break
        default: {
          let formattedError = msg.error
          if (typeof msg.error === 'string' && msg.error.trimStart().startsWith('{'))
            try {
              formattedError = JSON.stringify(JSON.parse(msg.error), null, 2)
            } catch (e) {
              /* empty */
            }
          const displayError = getDisplayErrorText(formattedError, t)

          setConversationItemData((currentItems) => {
            const lastItem = currentItems[currentItems.length - 1]
            if (
              lastItem &&
              (lastItem.content === waitingPlaceholder(t) || lastItem.type === 'error')
            ) {
              const updatedItems = [...currentItems]
              updatedItems[updatedItems.length - 1] = new ConversationItemData(
                'error',
                displayError,
              )
              return updatedItems
            }
            return [...currentItems, new ConversationItemData('error', displayError)]
          })
          break
        }
      }
      partialAnswerRef.current = ''
      retryRecordRef.current = null
      setIsReady(true)
    }
  }

  /**
   * @param {Session|undefined} session
   * @param {boolean|undefined} stop
   * @param {number|undefined} stopGenerationId
   */
  const postMessage = async ({ session, stop, stopGenerationId }) => {
    if (disposedRef.current) return
    const requestGenerationId = session ? ++requestGenerationIdRef.current : undefined
    if (useForegroundFetch) {
      if (stop && stopGenerationId === undefined) {
        const stoppedRequestGenerationId = requestGenerationIdRef.current
        const foregroundPorts = Array.from(foregroundPortsRef.current)
        foregroundPortsRef.current.clear()
        for (const foregroundPort of foregroundPorts) foregroundPort.disconnect()
        foregroundMessageListeners.current = []
        portMessageListener({ done: true, requestGenerationId: stoppedRequestGenerationId })
        requestGenerationIdRef.current += 1
        return
      }
      for (const listener of [...foregroundMessageListeners.current]) {
        listener({ session, stop, stopGenerationId, requestGenerationId })
      }
      if (session) {
        let disconnected = false
        const messageListeners = new Set()
        const disconnectListeners = new Set()
        const removeForegroundMessageListener = (listener) => {
          const index = foregroundMessageListeners.current.indexOf(listener)
          if (index !== -1) foregroundMessageListeners.current.splice(index, 1)
        }
        const fakePort = {
          postMessage: (msg) => {
            if (disconnected || disposedRef.current) return
            portMessageListener({ ...msg, requestGenerationId })
          },
          onMessage: {
            addListener: (listener) => {
              if (disconnected) return
              messageListeners.add(listener)
              foregroundMessageListeners.current.push(listener)
            },
            removeListener: (listener) => {
              messageListeners.delete(listener)
              removeForegroundMessageListener(listener)
            },
          },
          onDisconnect: {
            addListener: (listener) => {
              if (disconnected) {
                listener()
                return
              }
              disconnectListeners.add(listener)
            },
            removeListener: (listener) => {
              disconnectListeners.delete(listener)
            },
          },
          disconnect: () => {
            if (disconnected) return
            disconnected = true
            for (const listener of messageListeners) removeForegroundMessageListener(listener)
            messageListeners.clear()
            const listeners = Array.from(disconnectListeners)
            disconnectListeners.clear()
            for (const listener of listeners) {
              try {
                listener()
              } catch (error) {
                console.warn('[ConversationCard] Foreground disconnect listener failed:', error)
              }
            }
          },
        }
        foregroundPortsRef.current.add(fakePort)
        try {
          const bingToken = (await getUserConfig()).bingAccessToken
          if (
            disposedRef.current ||
            disconnected ||
            requestGenerationId !== requestGenerationIdRef.current
          ) {
            return
          }
          if (isUsingModelName('bingFreeSydney', session))
            await generateAnswersWithBingWebApi(
              fakePort,
              session.question,
              session,
              bingToken,
              true,
            )
          else await generateAnswersWithBingWebApi(fakePort, session.question, session, bingToken)
        } catch (err) {
          if (!disposedRef.current && !disconnected) handlePortError(session, fakePort, err, t)
        } finally {
          fakePort.disconnect()
          foregroundPortsRef.current.delete(fakePort)
        }
      }
    } else {
      port.postMessage(
        createConversationPortMessage({
          session,
          stop,
          stopGenerationId,
          requestGenerationId,
        }),
      )
    }
  }

  useEffect(() => {
    const portListener = () => {
      if (replacedPortRef.current === port) {
        replacedPortRef.current = null
        return
      }
      if (disposedRef.current) return
      // A dropped transport ends the stream without a final message, so flush and close: the
      // newest chunk still renders on a hidden page, where animation frames are paused. A
      // foreground generation (Bing web) streams through its own transport, though, so this
      // keepalive port dropping must not finalize the answer or unlock sending.
      if (foregroundPortsRef.current.size === 0) {
        streamBufferRef.current.push({ done: true })
        streamBufferRef.current.flush()
        setIsReady(true)
      }
      const nextPort = Browser.runtime.connect()
      portRef.current = nextPort
      setPort(nextPort)
    }

    const closeChatsMessageListener = (message) => {
      if (disposedRef.current) return
      if (message.type === 'CLOSE_CHATS') {
        if (props.onClose) disposeOwnedTransports()
        else port.disconnect()
        Browser.runtime.onMessage.removeListener(closeChatsMessageListener)
        window.removeEventListener('keydown', closeChatsEscListener)
        if (props.onClose) props.onClose()
      }
    }
    const closeChatsEscListener = async (e) => {
      if (e.key !== 'Escape') return
      const { allowEscToCloseAll } = await getUserConfig()
      if (disposedRef.current || !allowEscToCloseAll) return
      closeChatsMessageListener({ type: 'CLOSE_CHATS' })
    }

    if (props.closeable) {
      Browser.runtime.onMessage.addListener(closeChatsMessageListener)
      window.addEventListener('keydown', closeChatsEscListener)
    }
    port.onDisconnect.addListener(portListener)
    return () => {
      if (props.closeable) {
        Browser.runtime.onMessage.removeListener(closeChatsMessageListener)
        window.removeEventListener('keydown', closeChatsEscListener)
      }
      port.onDisconnect.removeListener(portListener)
    }
  }, [port])
  useEffect(() => {
    if (useForegroundFetch) {
      return () => {}
    } else {
      port.onMessage.addListener(portMessageListener)
      return () => {
        port.onMessage.removeListener(portMessageListener)
      }
    }
  }, [port, conversationItemData])

  const getRetryFn = (session) => async () => {
    streamBufferRef.current.discard()
    // A retry starts a new generation, so the previous attempt's reasoning must go too.
    updateAnswer(waitingPlaceholder(t), false, 'answer', false, '')
    setIsReady(false)

    const conversationRecords = session.conversationRecords.map((record) => ({ ...record }))
    if (retryRecordRef.current === null && conversationRecords.length > 0) {
      const lastRecord = conversationRecords[conversationRecords.length - 1]
      if (
        conversationItemData[conversationItemData.length - 1].done &&
        conversationItemData.length > 1 &&
        lastRecord.question === conversationItemData[conversationItemData.length - 2].content
      ) {
        retryRecordRef.current = conversationRecords.pop()
      }
    }
    const newSession = createRetrySession(session, conversationRecords, retryRecordRef.current)
    setSession(newSession)
    try {
      partialAnswerRef.current = ''
      if (!isReady) {
        ++requestGenerationIdRef.current
        const stopGenerationId = ++retryGenerationIdRef.current
        await postMessage({ stop: true, stopGenerationId })
      }
      await postMessage({ session: newSession })
    } catch (e) {
      const retryRecord = retryRecordRef.current
      setSession((currentSession) => finalizeInterruptedSession(currentSession, '', retryRecord))
      partialAnswerRef.current = ''
      retryRecordRef.current = null
      // The renderer takes text, so the thrown error is stored as its message.
      updateAnswer(e?.message ?? String(e), false, 'error', false, '')
      setIsReady(true)
    }
  }

  const retryFn = useMemo(() => getRetryFn(session), [session, isReady, conversationItemData, port])

  return (
    <div className="gpt-inner">
      <div
        className={
          props.draggable ? `gpt-header${completeDraggable ? ' draggable' : ''}` : 'gpt-header'
        }
        style="user-select:none;"
      >
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 0 15px 15px',
            ...(props.notClampSize ? {} : { flexGrow: isSafari() ? 0 : 1 }),
            ...(isSafari() ? { maxWidth: '200px' } : {}),
          }}
        >
          {props.closeable ? (
            <span
              className="gpt-util-icon"
              title={t('Close the Window')}
              onClick={() => {
                if (props.onClose) disposeOwnedTransports()
                else port.disconnect()
                if (props.onClose) props.onClose()
              }}
            >
              <XLg size={16} />
            </span>
          ) : props.dockable ? (
            <span
              className="gpt-util-icon"
              title={t('Pin the Window')}
              onClick={() => {
                if (props.onDock) props.onDock()
              }}
            >
              <Pin size={16} />
            </span>
          ) : (
            <img src={logo} style="user-select:none;width:20px;height:20px;" />
          )}
          <select
            style={props.notClampSize ? {} : { width: 0, flexGrow: 1 }}
            className="normal-button"
            required
            value={selectedApiModeValue}
            onChange={(e) => {
              if (e.target.value === UNMATCHED_API_MODE_VALUE) return

              let apiMode = null
              let modelName = 'customModel'
              if (e.target.value !== '-1') {
                const selectedApiMode = apiModes[Number(e.target.value)]
                if (!selectedApiMode) return
                apiMode = selectedApiMode
                modelName = apiModeToModelName(apiMode)
              }
              const newSession = {
                ...session,
                modelName,
                apiMode,
                aiName: apiMode
                  ? getApiModeDisplayLabel(apiMode, t, customOpenAIProviders)
                  : modelNameToDesc(modelName, t, config.customModelName),
              }
              if (config.autoRegenAfterSwitchModel && conversationItemData.length > 0)
                getRetryFn(newSession)()
              else setSession(newSession)
            }}
          >
            {selectedApiModeValue === UNMATCHED_API_MODE_VALUE && (
              <option value={UNMATCHED_API_MODE_VALUE} disabled>
                {currentAiName}
              </option>
            )}
            {apiModes.map((apiMode, index) => {
              const desc = getApiModeDisplayLabel(apiMode, t, customOpenAIProviders)
              if (desc) {
                return (
                  <option value={index} key={index}>
                    {desc}
                  </option>
                )
              }
            })}
            <option value={-1}>{t(Models.customModel.desc)}</option>
          </select>
        </span>
        {props.draggable && !completeDraggable && (
          <div className="draggable" style={{ flexGrow: 2, cursor: 'move', height: '55px' }} />
        )}
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 15px 15px 0',
            justifyContent: 'flex-end',
            flexGrow: props.draggable && !completeDraggable ? 0 : 1,
          }}
        >
          {!config.disableWebModeHistory && session && session.conversationId && (
            <a
              title={t('Continue on official website')}
              href={'https://chatgpt.com/chat/' + session.conversationId}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="gpt-util-icon"
              style="color: inherit;"
            >
              <LinkExternalIcon size={16} />
            </a>
          )}
          <span
            className="gpt-util-icon"
            title={t('Float the Window')}
            onClick={() => {
              const position = { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 - 200 }
              const toolbarContainer = createElementAtPosition(position.x, position.y)
              toolbarContainer.className = 'chatgptbox-toolbar-container-not-queryable'
              render(
                <FloatingToolbar
                  session={session}
                  selection=""
                  container={toolbarContainer}
                  closeable={true}
                  triggered={true}
                />,
                toolbarContainer,
              )
            }}
          >
            <WindowDesktop size={16} />
          </span>
          <DeleteButton
            size={16}
            text={t('Clear Conversation')}
            onConfirm={async () => {
              ++requestGenerationIdRef.current
              const stopGenerationId = ++retryGenerationIdRef.current
              try {
                await postMessage({ stop: true, stopGenerationId })
              } catch (error) {
                console.warn(
                  '[ConversationCard] Failed to stop generation before clearing conversation:',
                  error,
                )
              }
              if (disposedRef.current) return
              if (!useForegroundFetch) {
                replacedPortRef.current = port
                port.disconnect()
                const nextPort = Browser.runtime.connect()
                portRef.current = nextPort
                setPort(nextPort)
              }
              partialAnswerRef.current = ''
              retryRecordRef.current = null
              streamBufferRef.current.discard()
              Browser.runtime.sendMessage({
                type: 'DELETE_CONVERSATION',
                data: {
                  conversationId: session.conversationId,
                },
              })
              setConversationItemData([])
              const newSession = initSession({
                ...session,
                question: null,
                conversationRecords: [],
              })
              newSession.sessionId = session.sessionId
              setSession(newSession)
              setIsReady(true)
            }}
          />
          {!props.pageMode && (
            <span
              title={t('Store to Independent Conversation Page')}
              className="gpt-util-icon"
              onClick={() => {
                const newSession = {
                  ...session,
                  sessionName: new Date().toLocaleString(),
                  autoClean: false,
                  sessionId: uuidv4(),
                }
                setSession(newSession)
                createSession(newSession).then(() =>
                  Browser.runtime.sendMessage({
                    type: 'OPEN_URL',
                    data: {
                      url: Browser.runtime.getURL('IndependentPanel.html') + '?from=store',
                    },
                  }),
                )
              }}
            >
              <ArchiveIcon size={16} />
            </span>
          )}
          {conversationItemData.length > 0 && (
            <span
              title={t('Jump to bottom')}
              className="gpt-util-icon"
              onClick={() => {
                bodyRef.current.scrollTo({
                  top: bodyRef.current.scrollHeight,
                  behavior: 'smooth',
                })
              }}
            >
              <MoveToBottomIcon size={16} />
            </span>
          )}
          <span
            title={t('Save Conversation')}
            className="gpt-util-icon"
            onClick={() => {
              let output = ''
              session.conversationRecords.forEach((data) => {
                output += `${t('Question')}:\n\n${data.question}\n\n${t('Answer')}:\n\n${
                  data.answer
                }\n\n<hr/>\n\n`
              })
              const blob = new Blob([output], { type: 'text/plain;charset=utf-8' })
              FileSaver.saveAs(blob, 'conversation.md')
            }}
          >
            <DesktopDownloadIcon size={16} />
          </span>
        </span>
      </div>
      <hr />
      <div
        ref={bodyRef}
        className="markdown-body"
        style={
          props.notClampSize
            ? { flexGrow: 1, minHeight: 0 }
            : { maxHeight: windowSize[1] * 0.55 + 'px', resize: 'vertical' }
        }
      >
        {conversationItemData.map((data, idx) => (
          <ConversationItem
            content={data.content}
            key={idx}
            type={data.type}
            descName={data.type === 'answer' && currentAiName}
            onRetry={idx === conversationItemData.length - 1 ? retryFn : null}
            done={data.done}
            reasoning={data.reasoning}
          />
        ))}
      </div>
      {props.waitForTrigger && !triggered ? (
        <p
          className="manual-btn"
          style={{ display: 'flex', justifyContent: 'center' }}
          onClick={() => {
            setConversationItemData([new ConversationItemData('answer', waitingPlaceholder(t))])
            setTriggered(true)
            setIsReady(false)
          }}
        >
          <span className="icon-and-text">
            <SearchIcon size="small" /> {t('Ask ChatGPT')}
          </span>
        </p>
      ) : (
        <InputBox
          enabled={isReady}
          postMessage={postMessage}
          reverseResizeDir={props.pageMode}
          onSubmit={async (question) => {
            const newQuestion = new ConversationItemData('question', question)
            const newAnswer = new ConversationItemData('answer', waitingPlaceholder(t))
            partialAnswerRef.current = ''
            retryRecordRef.current = null
            streamBufferRef.current.discard()
            setConversationItemData([...conversationItemData, newQuestion, newAnswer])
            setIsReady(false)

            const newSession = { ...session, question, isRetry: false }
            setSession(newSession)
            try {
              await postMessage({ session: newSession })
            } catch (e) {
              if (disposedRef.current) return
              updateAnswer(e?.message ?? String(e), false, 'error', false, '')
            }
            if (disposedRef.current || !bodyRef.current) return
            bodyRef.current.scrollTo({
              top: bodyRef.current.scrollHeight,
              behavior: 'instant',
            })
          }}
        />
      )}
    </div>
  )
}

ConversationCard.propTypes = {
  session: PropTypes.object.isRequired,
  question: PropTypes.string,
  onUpdate: PropTypes.func,
  draggable: PropTypes.bool,
  closeable: PropTypes.bool,
  onClose: PropTypes.func,
  dockable: PropTypes.bool,
  onDock: PropTypes.func,
  notClampSize: PropTypes.bool,
  pageMode: PropTypes.bool,
  waitForTrigger: PropTypes.bool,
}

export default memo(ConversationCard)
