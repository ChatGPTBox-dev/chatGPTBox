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
import {
  getUserConfig,
  isUsingBingWebModel,
  isUsingGeminiWebModel,
  Models,
} from '../../config/index.mjs'
import { useTranslation } from 'react-i18next'
import DeleteButton from '../DeleteButton'
import { useConfig } from '../../hooks/use-config.mjs'
import { createSession } from '../../services/local-session-client.mjs'
import { v4 as uuidv4 } from 'uuid'
import { initSession } from '../../services/init-session.mjs'
import { findLastIndex } from 'lodash-es'
import { generateAnswersWithBingWebApi } from '../../services/apis/bing-web.mjs'
import { handlePortError } from '../../services/wrappers.mjs'
import { getGeminiContinuationRevision } from '../../services/apis/gemini-web-continuation.mjs'
import {
  getApiModeDisplayLabel,
  getConversationAiName,
} from '../../popup/sections/api-modes-provider-utils.mjs'
import { getDisplayErrorText } from '../../utils/error-text.mjs'
import {
  createConversationPortMessage,
  createRetrySession,
  finalizeCompletedSession,
  finalizeInterruptedSession,
  getCompletedAnswerUpdate,
  getInterruptedCompletionState,
  getSessionContentRevision,
  isSupersededGenerationMessage,
  isSupersededRequestMessage,
  shouldReplaceLastRetryRecord,
} from './session.mjs'

const logo = Browser.runtime.getURL('logo.png')
const UNMATCHED_API_MODE_VALUE = '__current-session-api-mode__'

class ConversationItemData extends Object {
  /**
   * @param {'question'|'answer'|'error'} type
   * @param {string} content
   * @param {bool} done
   */
  constructor(type, content, done = false) {
    super()
    this.type = type
    this.content = content
    this.done = done
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
  const retryTargetIndexRef = useRef(session.conversationRecords.length - 1)
  const requestRecordCountRef = useRef(session.conversationRecords.length)
  const retryGenerationIdRef = useRef(0)
  const requestGenerationIdRef = useRef(0)
  const runtimeGeminiContinuationInFlightRef = useRef(false)
  const activeGeminiRequestRef = useRef(false)
  const archiveNavigationPendingRef = useRef(null)
  const archiveInFlightRef = useRef(false)
  const disposedRef = useRef(false)
  const portRef = useRef(port)
  const sessionRef = useRef(session)
  const onUpdateRef = useRef(props.onUpdate)
  const conversationItemDataRef = useRef([])
  const foregroundMessageListeners = useRef([])
  const foregroundPortsRef = useRef(new Set())
  const completeDraggable = useMemo(() => !isSafari() && !isFirefox() && !isMobile(), [])
  const useForegroundFetch = isUsingBingWebModel(session)
  const [apiModes, setApiModes] = useState([])

  /**
   * @type {[ConversationItemData[], (conversationItemData: ConversationItemData[]) => void]}
   */
  const [conversationItemData, setConversationItemData] = useState([])
  sessionRef.current = session
  onUpdateRef.current = props.onUpdate
  conversationItemDataRef.current = conversationItemData
  const config = useConfig()
  const customOpenAIProviders = Array.isArray(config.customOpenAIProviders)
    ? config.customOpenAIProviders
    : []
  const currentAiName = getConversationAiName(session, t, customOpenAIProviders, config)
  const selectedApiModeIndex = useMemo(
    () =>
      getUniquelySelectedApiModeIndex(apiModes, session, {
        sessionCompat: true,
        geminiWebFallbackConfig: config,
      }),
    [apiModes, session, config],
  )
  const selectedApiModeLabel =
    selectedApiModeIndex !== -1
      ? getApiModeDisplayLabel(apiModes[selectedApiModeIndex], t, customOpenAIProviders, config)
      : ''
  const selectedApiModeValue = selectedApiModeLabel
    ? String(selectedApiModeIndex)
    : !session.apiMode && session.modelName === 'customModel'
    ? '-1'
    : UNMATCHED_API_MODE_VALUE

  const markRuntimeGeminiContinuationUnsafe = ({ updateState = true } = {}) => {
    if (!runtimeGeminiContinuationInFlightRef.current) return
    runtimeGeminiContinuationInFlightRef.current = false
    const currentSession = sessionRef.current
    const retryRecord = retryRecordRef.current
    const restoredSession = retryRecord
      ? finalizeInterruptedSession(currentSession, '', retryRecord)
      : currentSession
    const unsafeSession = {
      ...restoredSession,
      geminiWeb_conversationUnsafe: true,
    }
    if (retryRecord) {
      retryTargetIndexRef.current = retryRecord.recordIndex
      retryRecordRef.current = null
    }
    sessionRef.current = unsafeSession
    if (updateState) setSession(unsafeSession)
    else onUpdateRef.current?.(portRef.current, unsafeSession, conversationItemDataRef.current)
  }

  const disposeOwnedTransports = () => {
    if (disposedRef.current) return
    markRuntimeGeminiContinuationUnsafe({ updateState: false })
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
        setConversationItemData([
          new ConversationItemData(
            'answer',
            `<p class="gpt-loading">${t(`Waiting for response...`)}</p>`,
          ),
        ])
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
    if (props.onUpdate) {
      const persistedSession = retryRecordRef.current
        ? finalizeInterruptedSession(session, '', retryRecordRef.current)
        : session
      props.onUpdate(port, persistedSession, conversationItemData)
    }
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
      retryTargetIndexRef.current = -1
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
   */
  const updateAnswer = (value, appended, newType, done = false) => {
    setConversationItemData((old) => {
      const copy = [...old]
      const index = findLastIndex(copy, (v) => v.type === 'answer' || v.type === 'error')
      if (index === -1) return copy
      copy[index] = new ConversationItemData(
        newType,
        appended ? copy[index].content + value : value,
      )
      copy[index].done = done
      return copy
    })
  }

  const portMessageListener = (msg) => {
    if (disposedRef.current) return
    const superseded =
      isSupersededRequestMessage(msg, requestGenerationIdRef.current) ||
      isSupersededGenerationMessage(msg, retryGenerationIdRef.current)
    if (superseded) {
      // The background reservation blocks pending requests. Only a confirmed unsafe outcome
      // permanently invalidates a superseded revision.
      if (msg.geminiWebContinuationRevision && msg.geminiWebConversationUnsafe === true) {
        setSession((currentSession) => {
          const revision = getGeminiContinuationRevision(
            currentSession.geminiWeb_conversation ?? currentSession.bard_conversationObj,
          )
          if (revision !== msg.geminiWebContinuationRevision) return currentSession
          return { ...currentSession, geminiWeb_conversationUnsafe: true }
        })
      }
      return
    }

    if (msg.geminiWebContinuationSubmitted === true) {
      runtimeGeminiContinuationInFlightRef.current = true
    }
    if (msg.geminiWebConversationUnsafe === true) {
      setSession((currentSession) => ({ ...currentSession, geminiWeb_conversationUnsafe: true }))
    }
    if (msg.geminiWebContinuationSafe === true) {
      runtimeGeminiContinuationInFlightRef.current = false
    }
    if (msg.answer) {
      partialAnswerRef.current = msg.answer
      updateAnswer(msg.answer, false, 'answer')
    }
    if (msg.session) {
      const retryRecord = retryRecordRef.current
      setSession((currentSession) => {
        const nextSession = msg.done
          ? finalizeCompletedSession(msg.session, retryRecord)
          : { ...msg.session }
        if (
          (!msg.done || !isUsingGeminiWebModel(msg.session)) &&
          currentSession.geminiWeb_conversationUnsafe === true
        ) {
          nextSession.geminiWeb_conversationUnsafe = true
        }
        return nextSession
      })
    }
    if (msg.done) {
      activeGeminiRequestRef.current = false
      const partialAnswer = partialAnswerRef.current
      const retryRecord = retryRecordRef.current
      if (runtimeGeminiContinuationInFlightRef.current && !msg.session) {
        markRuntimeGeminiContinuationUnsafe()
      } else {
        runtimeGeminiContinuationInFlightRef.current = false
      }
      const completionState = getInterruptedCompletionState(
        msg,
        partialAnswer,
        retryRecord,
        sessionRef.current,
      )
      if (completionState.shouldFinalize) {
        setSession((currentSession) =>
          finalizeInterruptedSession(currentSession, partialAnswer, retryRecord),
        )
      }
      if (
        msg.session &&
        (partialAnswer || msg.session.conversationRecords.length > requestRecordCountRef.current)
      ) {
        retryTargetIndexRef.current = msg.session.conversationRecords.length - 1
      } else if (retryRecord) {
        retryTargetIndexRef.current = retryRecord.recordIndex
      } else if (completionState.shouldFinalize && partialAnswer) {
        retryTargetIndexRef.current = sessionRef.current.conversationRecords.length
      }
      // A redundant terminal notice must not discard an already completed retry target.
      // New submissions and clear reset the index before receiving their first response.
      partialAnswerRef.current = ''
      retryRecordRef.current = null
      const answerUpdate = getCompletedAnswerUpdate(completionState.restoredRetryAnswer)
      updateAnswer(answerUpdate.value, answerUpdate.appended, 'answer', true)
      setIsReady(true)
    }
    if (msg.error) {
      activeGeminiRequestRef.current = false
      runtimeGeminiContinuationInFlightRef.current = false
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
              (lastItem.content.includes('gpt-loading') || lastItem.type === 'error')
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
      retryTargetIndexRef.current = retryRecord?.recordIndex ?? -1
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
    const requestGenerationId =
      session || (stop && !useForegroundFetch) ? ++requestGenerationIdRef.current : undefined
    if (session) {
      requestRecordCountRef.current = session.conversationRecords.length
      activeGeminiRequestRef.current = isUsingGeminiWebModel(session)
    }
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
      try {
        port.postMessage(
          createConversationPortMessage({
            session,
            stop,
            stopGenerationId,
            requestGenerationId,
            persistedApiMode: session ? props.getPersistedApiMode?.(session.sessionId) : null,
          }),
        )
      } catch (error) {
        if (session) {
          runtimeGeminiContinuationInFlightRef.current = false
          activeGeminiRequestRef.current = false
        }
        throw error
      }
    }
  }

  useEffect(() => {
    const portListener = () => {
      if (replacedPortRef.current === port) {
        replacedPortRef.current = null
        return
      }
      if (disposedRef.current) return
      activeGeminiRequestRef.current = false
      const retryRecord = retryRecordRef.current
      markRuntimeGeminiContinuationUnsafe()
      if (retryRecord) {
        // A disconnect can also interrupt a replacement before submission.
        setSession((currentSession) => finalizeInterruptedSession(currentSession, '', retryRecord))
        retryTargetIndexRef.current = retryRecord.recordIndex
        retryRecordRef.current = null
        partialAnswerRef.current = ''
        updateAnswer(retryRecord.answer, false, 'answer', true)
      }
      const nextPort = Browser.runtime.connect()
      portRef.current = nextPort
      setPort(nextPort)
      setIsReady(true)
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
    updateAnswer(`<p class="gpt-loading">${t('Waiting for response...')}</p>`, false, 'answer')
    setIsReady(false)

    const conversationRecords = session.conversationRecords.map((record) => ({ ...record }))
    if (
      retryRecordRef.current === null &&
      shouldReplaceLastRetryRecord(conversationRecords, retryTargetIndexRef.current)
    ) {
      const recordIndex = conversationRecords.length - 1
      retryRecordRef.current = { ...conversationRecords.pop(), recordIndex }
    }
    retryTargetIndexRef.current = -1
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
      retryTargetIndexRef.current = retryRecord?.recordIndex ?? -1
      retryRecordRef.current = null
      updateAnswer(e, false, 'error')
      setIsReady(true)
    }
  }

  const retryFn = useMemo(() => getRetryFn(session), [session, isReady, conversationItemData, port])
  const useDedicatedDragHandle = props.draggable && !completeDraggable
  const dedicatedDragHandleWidth = isMobile() ? '44px' : '24px'
  const constrainFloatingHeight = props.draggable && !props.pageMode
  const floatingViewportMaxHeight = window.CSS?.supports?.('max-height', '100dvh')
    ? '100dvh'
    : '100vh'

  return (
    <div
      className="gpt-inner"
      style={
        constrainFloatingHeight
          ? { maxHeight: floatingViewportMaxHeight, boxSizing: 'border-box' }
          : undefined
      }
    >
      <div
        className={
          props.draggable ? `gpt-header${completeDraggable ? ' draggable' : ''}` : 'gpt-header'
        }
        style={{
          userSelect: 'none',
          ...(useDedicatedDragHandle ? { flexWrap: 'wrap' } : {}),
        }}
      >
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 0 15px 15px',
            ...(props.notClampSize
              ? {}
              : {
                  flexGrow: isSafari() ? 0 : 1,
                  ...(useDedicatedDragHandle ? { minWidth: '180px' } : {}),
                }),
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
            style={
              props.notClampSize
                ? {}
                : {
                    width: 0,
                    flexGrow: 1,
                    ...(useDedicatedDragHandle ? { minWidth: 0 } : {}),
                  }
            }
            className="normal-button"
            title={selectedApiModeLabel || currentAiName}
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
                  ? getApiModeDisplayLabel(apiMode, t, customOpenAIProviders, config)
                  : modelNameToDesc(modelName, t, config.customModelName),
                ...(runtimeGeminiContinuationInFlightRef.current && config.autoRegenAfterSwitchModel
                  ? { geminiWeb_conversationUnsafe: true }
                  : {}),
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
              const desc = getApiModeDisplayLabel(apiMode, t, customOpenAIProviders, config)
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
        {useDedicatedDragHandle && (
          <div
            className="draggable"
            style={{ flex: `0 0 ${dedicatedDragHandleWidth}`, cursor: 'move', height: '55px' }}
          />
        )}
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 15px 15px 0',
            justifyContent: 'flex-end',
            flexGrow: useDedicatedDragHandle ? 0 : 1,
            ...(useDedicatedDragHandle ? { marginLeft: 'auto' } : {}),
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
              runtimeGeminiContinuationInFlightRef.current = false
              activeGeminiRequestRef.current = false
              archiveNavigationPendingRef.current = null
              if (!useForegroundFetch) {
                replacedPortRef.current = port
                port.disconnect()
                const nextPort = Browser.runtime.connect()
                portRef.current = nextPort
                setPort(nextPort)
              }
              partialAnswerRef.current = ''
              retryRecordRef.current = null
              retryTargetIndexRef.current = -1
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
              onClick={async () => {
                if (
                  archiveInFlightRef.current ||
                  (!isReady &&
                    (activeGeminiRequestRef.current ||
                      isUsingGeminiWebModel(session) ||
                      session.geminiWeb_conversation?.c ||
                      session.bard_conversationObj?.c))
                )
                  return
                archiveInFlightRef.current = true
                const archiveGeneration = requestGenerationIdRef.current
                try {
                  const archiveSnapshot = {
                    ...session,
                    ...(runtimeGeminiContinuationInFlightRef.current
                      ? { geminiWeb_conversationUnsafe: true }
                      : {}),
                  }
                  const archiveFingerprint = (snapshot) =>
                    JSON.stringify([
                      getSessionContentRevision(snapshot),
                      snapshot.geminiWeb_conversationUnsafe === true ||
                        runtimeGeminiContinuationInFlightRef.current,
                      snapshot.geminiWeb_conversationPending === true,
                    ])
                  const fingerprint = archiveFingerprint(archiveSnapshot)
                  let pending = archiveNavigationPendingRef.current
                  if (!pending || pending.fingerprint !== fingerprint) {
                    pending = {
                      fingerprint,
                      sessionId: uuidv4(),
                      sessionName: new Date().toLocaleString(),
                      saved: false,
                    }
                    // Keep the ID even if the write commits but its response is lost.
                    archiveNavigationPendingRef.current = pending
                  }
                  if (!pending.saved) {
                    const newSession = {
                      ...archiveSnapshot,
                      sessionName: pending.sessionName,
                      autoClean: false,
                      sessionId: pending.sessionId,
                    }
                    await createSession(newSession)
                    pending.saved = true
                    if (disposedRef.current || archiveGeneration !== requestGenerationIdRef.current)
                      return
                    setSession((currentSession) =>
                      currentSession === session ? newSession : currentSession,
                    )
                  }
                  if (
                    disposedRef.current ||
                    archiveNavigationPendingRef.current !== pending ||
                    archiveFingerprint(sessionRef.current) !== fingerprint
                  )
                    return
                  const navigation = await Browser.runtime.sendMessage({
                    type: 'OPEN_URL',
                    data: {
                      url:
                        Browser.runtime.getURL('IndependentPanel.html') +
                        '?from=store&sessionId=' +
                        encodeURIComponent(pending.sessionId),
                      reportFailure: true,
                    },
                  })
                  if (navigation?.ok === false) throw new Error('Could not open conversation page')
                  if (archiveNavigationPendingRef.current === pending)
                    archiveNavigationPendingRef.current = null
                } catch (error) {
                  console.error('[ConversationCard] Failed to archive or open conversation:', error)
                  if (!disposedRef.current) {
                    const message = archiveNavigationPendingRef.current?.saved
                      ? t('Conversation saved, but the page could not be opened. Retry to open it.')
                      : t('Error')
                    window.alert(`${message}: ${error?.message || String(error)}`)
                  }
                } finally {
                  archiveInFlightRef.current = false
                }
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
            : {
                maxHeight: windowSize[1] * 0.55 + 'px',
                resize: 'vertical',
                ...(constrainFloatingHeight ? { flexShrink: 1, minHeight: 0 } : {}),
              }
        }
      >
        {conversationItemData.map((data, idx) => (
          <ConversationItem
            content={data.content}
            key={idx}
            type={data.type}
            descName={data.type === 'answer' && currentAiName}
            onRetry={idx === conversationItemData.length - 1 ? retryFn : null}
          />
        ))}
      </div>
      {props.waitForTrigger && !triggered ? (
        <p
          className="manual-btn"
          style={{ display: 'flex', justifyContent: 'center' }}
          onClick={() => {
            setConversationItemData([
              new ConversationItemData(
                'answer',
                `<p class="gpt-loading">${t(`Waiting for response...`)}</p>`,
              ),
            ])
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
            const newAnswer = new ConversationItemData(
              'answer',
              `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
            )
            partialAnswerRef.current = ''
            retryRecordRef.current = null
            retryTargetIndexRef.current = -1
            setConversationItemData([...conversationItemData, newQuestion, newAnswer])
            setIsReady(false)

            const newSession = { ...session, question, isRetry: false }
            setSession(newSession)
            try {
              await postMessage({ session: newSession })
            } catch (e) {
              if (disposedRef.current) return
              updateAnswer(e, false, 'error')
              setIsReady(true)
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
  getPersistedApiMode: PropTypes.func,
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
