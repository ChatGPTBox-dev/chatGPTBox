import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'
import InputBox from '../InputBox'
import ConversationItem from '../ConversationItem'
import {
  apiModeToModelName,
  createElementAtPosition,
  getApiModesFromConfig,
  isApiModeSelected,
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

const logo = Browser.runtime.getURL('logo.png')

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
  const [completeDraggable, setCompleteDraggable] = useState(false)
  const useForegroundFetch = isUsingBingWebModel(session)
  const [apiModes, setApiModes] = useState([])

  /**
   * @type {[ConversationItemData[], (conversationItemData: ConversationItemData[]) => void]}
   */
  const [conversationItemData, setConversationItemData] = useState([])
  const config = useConfig()

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
    setCompleteDraggable(!isSafari() && !isFirefox() && !isMobile())
  }, [])

  useEffect(() => {
    if (props.onUpdate) props.onUpdate(port, session, conversationItemData)
  }, [session, conversationItemData])

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
    if (msg.answer) {
      updateAnswer(msg.answer, false, 'answer')
    }
    if (msg.session) {
      if (msg.done) msg.session = { ...msg.session, isRetry: false }
      setSession(msg.session)
    }
    if (msg.done) {
      updateAnswer('', true, 'answer', true)
      setIsReady(true)
    }
    if (msg.error) {
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

          let lastItem
          if (conversationItemData.length > 0)
            lastItem = conversationItemData[conversationItemData.length - 1]
          if (lastItem && (lastItem.content.includes('gpt-loading') || lastItem.type === 'error'))
            updateAnswer(t(formattedError), false, 'error')
          else
            setConversationItemData([
              ...conversationItemData,
              new ConversationItemData('error', t(formattedError)),
            ])
          break
        }
      }
      setIsReady(true)
    }
  }

  const foregroundMessageListeners = useRef([])

  /**
   * @param {Session|undefined} session
   * @param {boolean|undefined} stop
   */
  const postMessage = async ({ session, stop }) => {
    if (useForegroundFetch) {
      foregroundMessageListeners.current.forEach((listener) => listener({ session, stop }))
      if (session) {
        const fakePort = {
          postMessage: (msg) => {
            portMessageListener(msg)
          },
          onMessage: {
            addListener: (listener) => {
              foregroundMessageListeners.current.push(listener)
            },
            removeListener: (listener) => {
              foregroundMessageListeners.current.splice(
                foregroundMessageListeners.current.indexOf(listener),
                1,
              )
            },
          },
          onDisconnect: {
            addListener: () => {},
            removeListener: () => {},
          },
        }
        try {
          const bingToken = (await getUserConfig()).bingAccessToken
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
          handlePortError(session, fakePort, err)
        }
      }
    } else {
      port.postMessage({ session, stop })
    }
  }

  useEffect(() => {
    const portListener = () => {
      setPort(Browser.runtime.connect())
      setIsReady(true)
    }

    const closeChatsMessageListener = (message) => {
      if (message.type === 'CLOSE_CHATS') {
        port.disconnect()
        Browser.runtime.onMessage.removeListener(closeChatsMessageListener)
        window.removeEventListener('keydown', closeChatsEscListener)
        if (props.onClose) props.onClose()
      }
    }
    const closeChatsEscListener = async (e) => {
      if (e.key === 'Escape' && (await getUserConfig()).allowEscToCloseAll) {
        closeChatsMessageListener({ type: 'CLOSE_CHATS' })
      }
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
  }, [conversationItemData])

  const getRetryFn = (session) => async () => {
    updateAnswer(`<p class="gpt-loading">${t('Waiting for response...')}</p>`, false, 'answer')
    setIsReady(false)

    if (session.conversationRecords.length > 0) {
      const lastRecord = session.conversationRecords[session.conversationRecords.length - 1]
      if (
        conversationItemData[conversationItemData.length - 1].done &&
        conversationItemData.length > 1 &&
        lastRecord.question === conversationItemData[conversationItemData.length - 2].content
      ) {
        session.conversationRecords.pop()
      }
    }
    const newSession = { ...session, isRetry: true }
    setSession(newSession)
    try {
      await postMessage({ stop: true })
      await postMessage({ session: newSession })
    } catch (e) {
      updateAnswer(e, false, 'error')
    }
  }

  const retryFn = useMemo(() => getRetryFn(session), [session])

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
            ...(props.pageMode
              ? { flexGrow: 1, minWidth: 0 }
              : props.notClampSize
              ? {}
              : { flexGrow: isSafari() ? 0 : 1 }),
            ...(isSafari() ? { maxWidth: '200px' } : {}),
          }}
        >
          {props.closeable ? (
            <span
              className="gpt-util-icon"
              title={t('Close the Window')}
              onClick={() => {
                port.disconnect()
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
          ) : props.onToggleSidebar ? (
            <button
              type="button"
              className="gpt-util-icon gpt-menu-toggle"
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
              aria-expanded={Boolean(props.sidebarOpen)}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                props.onToggleSidebar()
              }}
            >
              ☰
            </button>
          ) : (
            <img src={logo} style="user-select:none;width:20px;height:20px;" />
          )}
          <select
            style={
              props.pageMode || !props.notClampSize ? { width: 0, flexGrow: 1, minWidth: 0 } : {}
            }
            className="normal-button"
            required
            onChange={(e) => {
              let apiMode = null
              let modelName = 'customModel'
              if (e.target.value !== '-1') {
                apiMode = apiModes[e.target.value]
                modelName = apiModeToModelName(apiMode)
              }
              const newSession = {
                ...session,
                modelName,
                apiMode,
                aiName: modelNameToDesc(
                  apiMode ? apiModeToModelName(apiMode) : modelName,
                  t,
                  config.customModelName,
                ),
              }
              if (config.autoRegenAfterSwitchModel && conversationItemData.length > 0)
                getRetryFn(newSession)()
              else setSession(newSession)
            }}
          >
            {apiModes.map((apiMode, index) => {
              const modelName = apiModeToModelName(apiMode)
              const desc = modelNameToDesc(modelName, t, config.customModelName)
              if (desc) {
                return (
                  <option value={index} key={index} selected={isApiModeSelected(apiMode, session)}>
                    {desc}
                  </option>
                )
              }
            })}
            <option value={-1} selected={!session.apiMode && session.modelName === 'customModel'}>
              {t(Models.customModel.desc)}
            </option>
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
            flexGrow: props.pageMode ? 0 : props.draggable && !completeDraggable ? 0 : 1,
            flexShrink: 0,
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
              await postMessage({ stop: true })
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
            ? { flexGrow: 1 }
            : { maxHeight: windowSize[1] * 0.55 + 'px', resize: 'vertical' }
        }
      >
        {conversationItemData.map((data, idx) => (
          <ConversationItem
            content={data.content}
            key={idx}
            type={data.type}
            descName={data.type === 'answer' && session.aiName}
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
            setConversationItemData([...conversationItemData, newQuestion, newAnswer])
            setIsReady(false)

            const newSession = { ...session, question, isRetry: false }
            setSession(newSession)
            try {
              await postMessage({ session: newSession })
            } catch (e) {
              updateAnswer(e, false, 'error')
            }
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
  onToggleSidebar: PropTypes.func,
  sidebarOpen: PropTypes.bool,
}

export default memo(ConversationCard)
