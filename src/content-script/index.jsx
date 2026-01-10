import './styles.scss'
import { unmountComponentAtNode } from 'react-dom'
import { render } from 'preact'
import DecisionCard from '../components/DecisionCard'
import { config as siteConfig } from './site-adapters'
import { config as toolsConfig } from './selection-tools'
import { config as menuConfig } from './menu-tools'
import {
  chatgptWebModelKeys,
  getPreferredLanguageKey,
  getUserConfig,
  isUsingChatgptWebModel,
  setAccessToken,
  setUserConfig,
} from '../config/index.mjs'
import {
  createElementAtPosition,
  cropText,
  endsWithQuestionMark,
  getApiModesStringArrayFromConfig,
  getClientPosition,
  getPossibleElementByQuerySelector,
} from '../utils'
import FloatingToolbar from '../components/FloatingToolbar'
import Browser from 'webextension-polyfill'
import { getPreferredLanguage } from '../config/language.mjs'
import '../_locales/i18n-react'
import { changeLanguage } from 'i18next'
import { initSession } from '../services/init-session.mjs'
import { getChatGptAccessToken, registerPortListener } from '../services/wrappers.mjs'
import { generateAnswersWithChatgptWebApi } from '../services/apis/chatgpt-web.mjs'
import WebJumpBackNotification from '../components/WebJumpBackNotification'

/**
 * @param {string} siteName
 * @param {SiteConfig} siteConfig
 */
async function mountComponent(siteName, siteConfig) {
  if (siteName === 'github' && location.href.includes('/wiki')) {
    return
  }

  console.debug('[content] mountComponent called with siteConfig:', siteConfig)
  try {
    const userConfig = await getUserConfig()

    if (!userConfig.alwaysFloatingSidebar) {
      const retry = 10
      let oldUrl = location.href
      for (let i = 1; i <= retry; i++) {
        console.debug(`[content] mountComponent retry ${i}/${retry} for element detection.`)
        if (location.href !== oldUrl) {
          console.log('[content] URL changed during retry, stopping mountComponent.')
          return
        }
        const e =
          (siteConfig &&
            (getPossibleElementByQuerySelector(siteConfig.sidebarContainerQuery) ||
              getPossibleElementByQuerySelector(siteConfig.appendContainerQuery) ||
              getPossibleElementByQuerySelector(siteConfig.resultsContainerQuery))) ||
          getPossibleElementByQuerySelector([userConfig.prependQuery]) ||
          getPossibleElementByQuerySelector([userConfig.appendQuery])
        if (e) {
          console.log('[content] Element found for mounting component:', e)
          break
        } else {
          console.debug(`[content] Element not found on retry ${i}.`)
          if (i === retry) {
            console.warn('[content] Element not found after all retries for mountComponent.')
            return
          }
          await new Promise((r) => setTimeout(r, 500))
        }
      }
    }

    document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').forEach((e) => {
      try {
        unmountComponentAtNode(e)
        e.remove()
      } catch (err) {
        console.error('[content] Error removing existing chatgptbox container:', err)
      }
    })

    let question
    if (userConfig.inputQuery) {
      console.debug('[content] Getting input from userConfig.inputQuery')
      question = await getInput([userConfig.inputQuery])
    }
    if (!question && siteConfig) {
      console.debug('[content] Getting input from siteConfig.inputQuery')
      question = await getInput(siteConfig.inputQuery)
    }
    console.debug(
      '[content] Question for component:',
      question ? `{present, length=${question.length}}` : 'none',
    )

    // Ensure cleanup again in case getInput took time and new elements were added
    document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').forEach((e) => {
      try {
        unmountComponentAtNode(e)
        e.remove()
      } catch (err) {
        console.error('[content] Error removing existing chatgptbox container post getInput:', err)
      }
    })

    if (userConfig.alwaysFloatingSidebar && question) {
      console.log('[content] Rendering floating sidebar.')
      const position = {
        x: window.innerWidth - 300 - Math.floor((20 / 100) * window.innerWidth),
        y: window.innerHeight / 2 - 200,
      }
      const toolbarContainer = createElementAtPosition(position.x, position.y)
      toolbarContainer.className = 'chatgptbox-toolbar-container-not-queryable'

      let triggered = false
      if (userConfig.triggerMode === 'always') triggered = true
      else if (
        userConfig.triggerMode === 'questionMark' &&
        question &&
        endsWithQuestionMark(question.trim())
      )
        triggered = true
      console.debug('[content] Floating sidebar triggered:', triggered)

      render(
        <FloatingToolbar
          session={initSession({
            modelName: userConfig.modelName,
            apiMode: userConfig.apiMode,
            extraCustomModelName: userConfig.customModelName,
          })}
          selection=""
          container={toolbarContainer}
          triggered={triggered}
          closeable={true}
          prompt={question}
        />,
        toolbarContainer,
      )
      console.log('[content] Floating sidebar rendered.')
      return
    }

    if (!question && !userConfig.alwaysFloatingSidebar) {
      console.log('[content] No question found; rendering DecisionCard fallback.')
    }

    console.log('[content] Rendering DecisionCard.')
    const container = document.createElement('div')
    container.id = 'chatgptbox-container'
    if (siteName === 'google' || siteName === 'kagi') {
      container.style.width = '350px'
    }
    render(
      <DecisionCard
        session={initSession({
          modelName: userConfig.modelName,
          apiMode: userConfig.apiMode,
          extraCustomModelName: userConfig.customModelName,
        })}
        question={question}
        siteConfig={siteConfig}
        container={container}
      />,
      container,
    )
    console.log('[content] DecisionCard rendered.')
  } catch (error) {
    console.error('[content] Error in mountComponent:', error)
  }
}

async function getInput(inputQuery) {
  console.debug('[content] getInput called with query:', inputQuery)
  try {
    let input
    if (typeof inputQuery === 'function') {
      console.debug('[content] Input query is a function.')
      input = await inputQuery()
      if (input) {
        const preferredLanguage = await getPreferredLanguage()
        const replyPromptBelow = `Reply in ${preferredLanguage}. Regardless of the language of content I provide below. !!This is very important!!`
        const replyPromptAbove = `Reply in ${preferredLanguage}. Regardless of the language of content I provide above. !!This is very important!!`
        const result = `${replyPromptBelow}\n\n${input}\n\n${replyPromptAbove}`
        console.debug('[content] getInput from function generated prompt.', {
          inputLength: input.length,
          promptLength: result.length,
        })
        return result
      }
      console.debug('[content] getInput from function returned no input.')
      return input
    }
    console.debug('[content] Input query is a selector.')
    const searchInput = getPossibleElementByQuerySelector(inputQuery)
    if (searchInput) {
      console.debug('[content] Found search input element:', searchInput)
      if (searchInput.value) input = searchInput.value
      else if (searchInput.textContent) input = searchInput.textContent
      if (input) {
        const preferredLanguage = await getPreferredLanguage()
        const result =
          `Reply in ${preferredLanguage}.\nThe following is a search input in a search engine, ` +
          `giving useful content or solutions and as much information as you can related to it, ` +
          `use markdown syntax to make your answer more readable, such as code blocks, bold, list:\n` +
          input
        console.debug('[content] getInput from selector generated prompt.', {
          inputLength: input.length,
          promptLength: result.length,
        })
        return result
      }
    }
    console.debug('[content] No input found from selector or element empty.')
    return undefined
  } catch (error) {
    console.error('[content] Error in getInput:', error)
    return undefined
  }
}

let toolbarContainer
const deleteToolbar = () => {
  try {
    if (toolbarContainer && toolbarContainer.className === 'chatgptbox-toolbar-container') {
      console.debug('[content] Deleting toolbar:', toolbarContainer)
      toolbarContainer.remove()
      toolbarContainer = null
    }
  } catch (error) {
    console.error('[content] Error in deleteToolbar:', error)
  }
}

const createSelectionTools = async (toolbarContainerElement, selection) => {
  console.debug(
    '[content] createSelectionTools called with selection:',
    selection,
    'and container:',
    toolbarContainerElement,
  )
  try {
    toolbarContainerElement.className = 'chatgptbox-toolbar-container'
    const userConfig = await getUserConfig()
    render(
      <FloatingToolbar
        session={initSession({
          modelName: userConfig.modelName,
          apiMode: userConfig.apiMode,
          extraCustomModelName: userConfig.customModelName,
        })}
        selection={selection}
        container={toolbarContainerElement}
        dockable={true}
      />,
      toolbarContainerElement,
    )
    console.log('[content] Selection tools rendered.')
  } catch (error) {
    console.error('[content] Error in createSelectionTools:', error)
  }
}

let selectionToolsInitialized = false

async function prepareForSelectionTools() {
  if (selectionToolsInitialized) {
    console.debug('[content] Selection tools already initialized, skipping.')
    return
  }
  selectionToolsInitialized = true
  console.log('[content] Initializing selection tools.')
  document.addEventListener('mouseup', (e) => {
    try {
      if (toolbarContainer?.contains(e.target)) {
        console.debug('[content] Mouseup inside toolbar, ignoring.')
        return
      }
      const selectionElement =
        window.getSelection()?.rangeCount > 0 &&
        window.getSelection()?.getRangeAt(0).endContainer.parentElement
      if (selectionElement && toolbarContainer?.contains(selectionElement)) {
        console.debug('[content] Mouseup selection is inside toolbar, ignoring.')
        return
      }

      deleteToolbar()
      setTimeout(async () => {
        try {
          const selection = window
            .getSelection()
            ?.toString()
            .trim()
            .replace(/^-+|-+$/g, '')
          if (selection) {
            console.debug('[content] Text selected. Length:', selection.length)
            let position

            const config = await getUserConfig()
            if (!config.selectionToolsNextToInputBox) {
              position = { x: e.pageX + 20, y: e.pageY + 20 }
            } else {
              const activeElement = document.activeElement
              const inputElement =
                selectionElement?.querySelector('input, textarea') ||
                (activeElement?.matches('input, textarea') ? activeElement : null)

              if (inputElement) {
                console.debug(
                  '[content] Input element found for positioning toolbar:',
                  inputElement,
                )
                const clientRect = getClientPosition(inputElement)
                position = {
                  x: clientRect.x + window.scrollX + inputElement.offsetWidth + 50,
                  y: e.pageY + 30,
                }
              } else {
                position = { x: e.pageX + 20, y: e.pageY + 20 }
              }
            }
            console.debug('[content] Toolbar position:', position)
            toolbarContainer = createElementAtPosition(position.x, position.y)
            await createSelectionTools(toolbarContainer, selection)
          } else {
            console.debug('[content] No text selected on mouseup.')
          }
        } catch (err) {
          console.error('[content] Error in mouseup setTimeout callback for selection tools:', err)
        }
      }, 0)
    } catch (error) {
      console.error('[content] Error in mouseup listener for selection tools:', error)
    }
  })

  document.addEventListener('mousedown', (e) => {
    try {
      if (toolbarContainer?.contains(e.target)) {
        console.debug('[content] Mousedown inside toolbar, ignoring.')
        return
      }
      console.debug('[content] Mousedown outside toolbar, removing existing toolbars.')
      document.querySelectorAll('.chatgptbox-toolbar-container').forEach((el) => el.remove())
      toolbarContainer = null
    } catch (error) {
      console.error('[content] Error in mousedown listener for selection tools:', error)
    }
  })

  document.addEventListener('keydown', (e) => {
    try {
      if (
        toolbarContainer &&
        !toolbarContainer.contains(e.target) &&
        (e.target.nodeName === 'INPUT' || e.target.nodeName === 'TEXTAREA')
      ) {
        console.debug('[content] Keydown in input/textarea outside toolbar.')
        setTimeout(() => {
          try {
            if (!window.getSelection()?.toString().trim()) {
              console.debug('[content] No selection after keydown, deleting toolbar.')
              deleteToolbar()
            }
          } catch (err_inner) {
            console.error('[content] Error in keydown setTimeout callback:', err_inner)
          }
        }, 0)
      }
    } catch (error) {
      console.error('[content] Error in keydown listener for selection tools:', error)
    }
  })
}

let selectionToolsTouchInitialized = false

async function prepareForSelectionToolsTouch() {
  if (selectionToolsTouchInitialized) {
    console.debug('[content] Touch selection tools already initialized, skipping.')
    return
  }
  selectionToolsTouchInitialized = true
  console.log('[content] Initializing touch selection tools.')
  document.addEventListener('touchend', (e) => {
    try {
      if (toolbarContainer?.contains(e.target)) {
        console.debug('[content] Touchend inside toolbar, ignoring.')
        return
      }
      if (
        window.getSelection()?.rangeCount > 0 &&
        toolbarContainer?.contains(window.getSelection()?.getRangeAt(0).endContainer.parentElement)
      ) {
        console.debug('[content] Touchend selection is inside toolbar, ignoring.')
        return
      }

      deleteToolbar()
      setTimeout(async () => {
        try {
          const selection = window
            .getSelection()
            ?.toString()
            .trim()
            .replace(/^-+|-+$/g, '')
          if (selection) {
            console.debug('[content] Text selected via touch:', selection)
            const touch = e.changedTouches[0]
            toolbarContainer = createElementAtPosition(touch.pageX + 20, touch.pageY + 20)
            await createSelectionTools(toolbarContainer, selection)
          } else {
            console.debug('[content] No text selected on touchend.')
          }
        } catch (err) {
          console.error(
            '[content] Error in touchend setTimeout callback for touch selection tools:',
            err,
          )
        }
      }, 0)
    } catch (error) {
      console.error('[content] Error in touchend listener for touch selection tools:', error)
    }
  })

  document.addEventListener('touchstart', (e) => {
    try {
      if (toolbarContainer?.contains(e.target)) {
        console.debug('[content] Touchstart inside toolbar, ignoring.')
        return
      }
      console.debug('[content] Touchstart outside toolbar, removing existing toolbars.')
      document.querySelectorAll('.chatgptbox-toolbar-container').forEach((el) => el.remove())
      toolbarContainer = null
    } catch (error) {
      console.error('[content] Error in touchstart listener for touch selection tools:', error)
    }
  })
}

let menuX, menuY
let rightClickMenuInitialized = false

async function prepareForRightClickMenu() {
  if (rightClickMenuInitialized) {
    console.debug('[content] Right-click menu already initialized, skipping.')
    return
  }
  rightClickMenuInitialized = true
  console.log('[content] Initializing right-click menu handler.')
  document.addEventListener('contextmenu', (e) => {
    menuX = e.clientX
    menuY = e.clientY
    console.debug(`[content] Context menu opened at X: ${menuX}, Y: ${menuY}`)
  })

  Browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'CREATE_CHAT') {
      console.log('[content] Received CREATE_CHAT message:', message)
      try {
        const data = message.data
        let prompt = ''
        if (data.itemId in toolsConfig) {
          console.debug('[content] Generating prompt from toolsConfig for item:', data.itemId)
          prompt = await toolsConfig[data.itemId].genPrompt(data.selectionText)
        } else if (data.itemId in menuConfig) {
          console.debug('[content] Generating prompt from menuConfig for item:', data.itemId)
          const menuItem = menuConfig[data.itemId]
          if (!menuItem.genPrompt) {
            console.warn('[content] No genPrompt for menu item:', data.itemId)
            return
          }
          prompt = await menuItem.genPrompt()
          if (prompt) {
            const preferredLanguage = await getPreferredLanguage()
            prompt = await cropText(`Reply in ${preferredLanguage}.\n` + prompt)
          }
        } else {
          console.warn('[content] Unknown itemId for CREATE_CHAT:', data.itemId)
          return
        }
        console.debug('[content] Generated prompt:', prompt)

        const useMenuPosition =
          data.useMenuPosition && Number.isFinite(menuX) && Number.isFinite(menuY)
        const position = useMenuPosition
          ? { x: menuX, y: menuY }
          : { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 - 200 }
        console.debug('[content] Toolbar position for CREATE_CHAT:', position)
        const container = createElementAtPosition(position.x, position.y)
        container.className = 'chatgptbox-toolbar-container-not-queryable'
        const userConfig = await getUserConfig()
        render(
          <FloatingToolbar
            session={initSession({
              modelName: userConfig.modelName,
              apiMode: userConfig.apiMode,
              extraCustomModelName: userConfig.customModelName,
            })}
            selection={data.selectionText}
            container={container}
            triggered={true}
            closeable={true}
            prompt={prompt}
          />,
          container,
        )
        console.log('[content] CREATE_CHAT toolbar rendered.')
      } catch (error) {
        console.error('[content] Error processing CREATE_CHAT message:', error, message)
      }
    }
  })
}

async function prepareForStaticCard() {
  console.log('[content] Initializing static card.')
  try {
    const userConfig = await getUserConfig()
    let siteRegexPattern
    if (userConfig.useSiteRegexOnly) {
      siteRegexPattern = userConfig.siteRegex
    } else {
      siteRegexPattern =
        (userConfig.siteRegex ? userConfig.siteRegex + '|' : '') + Object.keys(siteConfig).join('|')
    }

    if (!siteRegexPattern) {
      console.debug('[content] No site regex pattern defined for static card.')
      return
    }
    const siteRegex = new RegExp(siteRegexPattern)
    console.debug('[content] Static card site regex:', siteRegex)

    const matches = location.hostname.match(siteRegex)
    if (matches) {
      const siteName = matches[0]
      console.log(`[content] Static card matched site: ${siteName}`)

      if (
        userConfig.siteAdapters.includes(siteName) &&
        !userConfig.activeSiteAdapters.includes(siteName)
      ) {
        console.log(
          `[content] Site adapter for ${siteName} is installed but not active. Skipping static card.`,
        )
        return
      }

      let initSuccess = true
      if (siteName in siteConfig) {
        const siteAdapterAction = siteConfig[siteName].action
        if (siteAdapterAction?.init) {
          console.debug(`[content] Initializing site adapter action for ${siteName}.`)
          initSuccess = await siteAdapterAction.init(
            location.hostname,
            userConfig,
            getInput,
            mountComponent,
          )
          console.debug(`[content] Site adapter init success for ${siteName}: ${initSuccess}`)
        }
      }

      if (initSuccess) {
        console.log(`[content] Mounting static card for site: ${siteName}`)
        await mountComponent(siteName, siteConfig[siteName])
      } else {
        console.warn(`[content] Static card init failed for site: ${siteName}`)
      }
    } else {
      console.debug('[content] No static card match for current site:', location.hostname)
    }
  } catch (error) {
    console.error('[content] Error in prepareForStaticCard:', error)
  }
}

async function overwriteAccessToken() {
  console.debug('[content] overwriteAccessToken called for hostname:', location.hostname)
  try {
    const isKimiHost =
      location.hostname === 'kimi.moonshot.cn' ||
      location.hostname === 'kimi.com' ||
      location.hostname === 'www.kimi.com'
    if (isKimiHost) {
      console.log(`[content] On ${location.hostname}, attempting to save refresh token.`)
      const refreshToken = window.localStorage.refresh_token
      if (refreshToken) {
        await setUserConfig({ kimiMoonShotRefreshToken: refreshToken })
        console.log('[content] Kimi Moonshot refresh token saved.')
      } else {
        const config = await getUserConfig()
        if (config.kimiMoonShotRefreshToken) {
          await setUserConfig({ kimiMoonShotRefreshToken: '' })
          console.log('[content] Kimi Moonshot refresh token cleared.')
        }
        console.warn('[content] Kimi Moonshot refresh token not found in localStorage.')
      }
      return
    }

    if (location.hostname !== 'chatgpt.com') {
      console.debug('[content] Not on chatgpt.com, skipping access token overwrite.')
      return
    }

    console.log('[content] On chatgpt.com, attempting to overwrite access token.')
    let data
    if (location.pathname === '/api/auth/session') {
      console.debug('[content] On /api/auth/session page.')
      const preElement = document.querySelector('pre')
      if (preElement?.textContent) {
        const response = preElement.textContent
        try {
          data = JSON.parse(response)
          console.debug('[content] Parsed access token data from <pre> tag.')
        } catch (error) {
          console.error('[content] Failed to parse JSON from <pre> tag for access token:', error)
        }
      } else {
        console.warn(
          '[content] <pre> tag not found or empty for access token on /api/auth/session.',
        )
      }
    } else {
      console.debug('[content] Not on /api/auth/session page, fetching token from API endpoint.')
      try {
        const resp = await fetch('https://chatgpt.com/api/auth/session')
        if (resp.ok) {
          data = await resp.json()
          console.debug('[content] Fetched access token data from API endpoint.')
        } else {
          console.warn(
            `[content] Failed to fetch access token, status: ${resp.status} ${resp.statusText}`,
          )
        }
      } catch (error) {
        console.error('[content] Error fetching access token from API:', error)
      }
    }

    if (data?.accessToken) {
      await setAccessToken(data.accessToken)
      console.log('[content] ChatGPT Access token has been set successfully from page data.')
    } else {
      console.warn('[content] No access token found in page data or fetch response.')
    }
  } catch (error) {
    console.error('[content] Error in overwriteAccessToken:', error)
  }
}

async function getClaudeSessionKey() {
  console.debug('[content] getClaudeSessionKey called.')
  try {
    const sessionKey = await Browser.runtime.sendMessage({
      type: 'GET_COOKIE',
      data: { url: 'https://claude.ai/', name: 'sessionKey' },
    })
    console.debug(
      '[content] Claude session key from background:',
      sessionKey ? 'found' : 'not found',
    )
    return sessionKey
  } catch (error) {
    console.error('[content] Error in getClaudeSessionKey sending message:', error)
    return null
  }
}

async function prepareForJumpBackNotification() {
  console.log('[content] Initializing jump back notification.')
  try {
    if (
      location.hostname === 'chatgpt.com' &&
      document.querySelector('button[data-testid=login-button]')
    ) {
      console.log('[content] ChatGPT login button found, user not logged in. Skipping jump back.')
      return
    }

    const url = new URL(window.location.href)
    if (url.searchParams.has('chatgptbox_notification')) {
      console.log('[content] chatgptbox_notification param found in URL.')

      if (location.hostname === 'claude.ai') {
        console.debug('[content] On claude.ai, checking login status.')
        let claudeSession = await getClaudeSessionKey()
        if (!claudeSession) {
          console.log('[content] Claude session key not found, waiting for it...')
          let promiseSettled = false
          let timerId = null
          let timeoutId = null
          const cleanup = () => {
            if (timerId) clearTimeout(timerId)
            if (timeoutId) clearTimeout(timeoutId)
          }

          try {
            await new Promise((resolve, reject) => {
              const poll = async () => {
                if (promiseSettled) return
                try {
                  claudeSession = await getClaudeSessionKey()
                  if (claudeSession && !promiseSettled) {
                    promiseSettled = true
                    cleanup()
                    console.log('[content] Claude session key found after waiting.')
                    resolve()
                    return
                  }
                } catch (err) {
                  console.error('[content] Error polling for Claude session key:', err)
                  const rawMessage =
                    typeof err?.message === 'string' ? err.message : String(err ?? '')
                  const errMsg = rawMessage.toLowerCase()
                  const isNetworkError = /\bnetwork\b/.test(errMsg)
                  const isPermissionError = /\bpermission\b/.test(errMsg)
                  if ((isNetworkError || isPermissionError) && !promiseSettled) {
                    promiseSettled = true
                    cleanup()
                    reject(new Error(`Failed to get Claude session key due to: ${rawMessage}`))
                    return
                  }
                }
                if (!promiseSettled) {
                  timerId = setTimeout(poll, 500)
                }
              }

              poll()

              timeoutId = setTimeout(() => {
                if (!promiseSettled) {
                  promiseSettled = true
                  cleanup()
                  console.warn('[content] Timed out waiting for Claude session key.')
                  reject(new Error('Timed out waiting for Claude session key.'))
                }
              }, 30000)
            })
          } catch (err) {
            console.error(
              '[content] Failed to get Claude session key for jump back notification:',
              err,
            )
            return
          }
        } else {
          console.log('[content] Claude session key found immediately.')
        }
      }

      const isKimiHost =
        location.hostname === 'kimi.moonshot.cn' ||
        location.hostname === 'kimi.com' ||
        location.hostname === 'www.kimi.com'
      if (isKimiHost) {
        console.debug('[content] On Kimi host, checking login status.')
        if (!window.localStorage.refresh_token) {
          console.log('[content] Kimi refresh token not found, attempting to trigger login.')
          setTimeout(() => {
            try {
              const loginContainer = document.querySelector('.user-info-container')
              if (!loginContainer) {
                console.warn('[content] Kimi login container not found, skipping auto-click.')
                return
              }
              console.log('[content] Clicking Kimi login container.')
              loginContainer.click()
            } catch (err_click) {
              console.error('[content] Error clicking Kimi login container:', err_click)
            }
          }, 1000)

          let promiseSettled = false
          let timerId = null
          let timeoutId = null
          const cleanup = () => {
            if (timerId) clearTimeout(timerId)
            if (timeoutId) clearTimeout(timeoutId)
          }

          try {
            await new Promise((resolve, reject) => {
              const poll = async () => {
                if (promiseSettled) return
                try {
                  const token = window.localStorage.refresh_token
                  if (token) {
                    promiseSettled = true
                    cleanup()
                    console.log('[content] Kimi refresh token found after waiting.')
                    await setUserConfig({ kimiMoonShotRefreshToken: token })
                    console.log('[content] Kimi refresh token saved to config.')
                    resolve()
                    return
                  }
                } catch (err_set) {
                  console.error('[content] Error setting Kimi refresh token from polling:', err_set)
                  // Do not reject on polling error, let timeout handle failure.
                }
                if (!promiseSettled) {
                  timerId = setTimeout(poll, 500)
                }
              }

              poll()

              timeoutId = setTimeout(() => {
                if (!promiseSettled) {
                  promiseSettled = true
                  cleanup()
                  console.warn('[content] Timed out waiting for Kimi refresh token.')
                  reject(new Error('Timed out waiting for Kimi refresh token.'))
                }
              }, 30000)
            })
          } catch (err) {
            console.error(
              '[content] Failed to get Kimi refresh token for jump back notification:',
              err,
            )
            return
          }
        } else {
          console.log('[content] Kimi refresh token found in localStorage.')
          await setUserConfig({ kimiMoonShotRefreshToken: window.localStorage.refresh_token })
        }
      }

      console.log('[content] Rendering WebJumpBackNotification.')
      const div = document.createElement('div')
      document.body.append(div)
      render(
        <WebJumpBackNotification
          container={div}
          chatgptMode={location.hostname === 'chatgpt.com'}
        />,
        div,
      )
      console.log('[content] WebJumpBackNotification rendered.')
    } else {
      console.debug('[content] No chatgptbox_notification param in URL.')
    }
  } catch (error) {
    console.error('[content] Error in prepareForJumpBackNotification:', error)
  }
}

let manageChatGptTabStatePromise = null
let chatGPTBoxPortListenerRegistered = false
let chatGptPromptTextareaPoked = false

function ensureChatGptPortListenerRegistered() {
  if (chatGPTBoxPortListenerRegistered) {
    console.log('[content] Port listener already registered, skipping.')
    return
  }

  if (location.hostname !== 'chatgpt.com' || location.pathname === '/auth/login') {
    console.debug(
      '[content] Not on chatgpt.com or on login page, skipping port listener registration.',
    )
    return
  }

  try {
    console.log('[content] Attempting to register port listener for chatgpt.com.')
    registerPortListener(async (session, port) => {
      console.debug(
        `[content] Port listener callback triggered. Session model: ${session?.modelName}, Port: ${port.name}`,
      )
      try {
        if (isUsingChatgptWebModel(session)) {
          console.log(
            '[content] Session is for ChatGPT Web Model, processing request for question:',
            session.question,
          )
          const accessToken = await getChatGptAccessToken()
          if (!accessToken) {
            console.warn('[content] No ChatGPT access token available for web API call.')
            port.postMessage({ error: 'Missing ChatGPT access token.' })
            return
          }
          await generateAnswersWithChatgptWebApi(port, session.question, session, accessToken)
          console.log('[content] generateAnswersWithChatgptWebApi call completed.')
        } else {
          console.debug(
            '[content] Session is not for ChatGPT Web Model, skipping processing in this listener.',
          )
        }
      } catch (e) {
        console.error('[content] Error in port listener callback:', e, 'Session:', session)
        try {
          port.postMessage({
            error: e.message || 'An unexpected error occurred in content script port listener.',
          })
        } catch (postError) {
          console.error('[content] Error sending error message back via port:', postError)
        }
      }
    })
    console.log('[content] Generic port listener registered successfully for chatgpt.com pages.')
    chatGPTBoxPortListenerRegistered = true
  } catch (error) {
    console.error('[content] Error registering global port listener:', error)
  }
}

async function run() {
  console.log('[content] Script run started.')
  try {
    ensureChatGptPortListenerRegistered()

    await getPreferredLanguageKey()
      .then((lang) => {
        console.log(`[content] Setting language to: ${lang}`)
        changeLanguage(lang)
      })
      .catch((err) => console.error('[content] Error setting preferred language:', err))

    Browser.runtime.onMessage.addListener(async (message) => {
      console.debug('[content] Received runtime message:', message)
      try {
        if (message.type === 'CHANGE_LANG') {
          console.log('[content] Processing CHANGE_LANG message:', message.data)
          changeLanguage(message.data.lang)
        }
      } catch (error) {
        console.error('[content] Error in global runtime.onMessage listener:', error, message)
      }
    })

    await overwriteAccessToken()
    const isChatGptHost = location.hostname === 'chatgpt.com'
    if (isChatGptHost) {
      await manageChatGptTabState()

      Browser.storage.onChanged.addListener(async (changes, areaName) => {
        console.debug('[content] Storage changed:', changes, 'in area:', areaName)
        try {
          const chatGptTabKeys = new Set([
            'activeApiModes',
            'customApiModes',
            'modelName',
            'apiMode',
            'customChatGptWebApiUrl',
            'azureDeploymentName',
            'ollamaModelName',
          ])
          if (areaName === 'local' && Object.keys(changes).some((key) => chatGptTabKeys.has(key))) {
            console.log(
              '[content] User config changed in storage, re-evaluating ChatGPT tab state.',
            )
            await manageChatGptTabState()
          }
        } catch (error) {
          console.error('[content] Error in storage.onChanged listener:', error)
        }
      })
    }

    await prepareForSelectionTools()
    await prepareForSelectionToolsTouch()
    await prepareForStaticCard()
    await prepareForRightClickMenu()
    prepareForJumpBackNotification().catch((error) => {
      console.error('[content] Error in prepareForJumpBackNotification (unhandled):', error)
    })

    console.log('[content] Script run completed successfully.')
  } catch (error) {
    console.error('[content] Error in run function:', error)
  }
}

async function manageChatGptTabState() {
  if (manageChatGptTabStatePromise) {
    console.debug('[content] manageChatGptTabState already running, waiting for in-flight call.')
    return manageChatGptTabStatePromise
  }

  manageChatGptTabStatePromise = (async () => {
    console.debug('[content] manageChatGptTabState called. Current location:', location.href)
    try {
      if (location.hostname !== 'chatgpt.com' || location.pathname === '/auth/login') {
        console.debug(
          '[content] Not on main chatgpt.com page, skipping manageChatGptTabState logic.',
        )
        return
      }

      const userConfig = await getUserConfig()
      const isThisTabDesignatedForChatGptWeb = chatgptWebModelKeys.some((model) =>
        getApiModesStringArrayFromConfig(userConfig, true).includes(model),
      )
      console.debug(
        '[content] Is this tab designated for ChatGPT Web:',
        isThisTabDesignatedForChatGptWeb,
      )

      if (isThisTabDesignatedForChatGptWeb) {
        if (location.pathname === '/') {
          console.debug('[content] On chatgpt.com root path.')
          const input = document.querySelector('#prompt-textarea')
          if (!chatGptPromptTextareaPoked && input && input.value === '') {
            console.log('[content] Manipulating #prompt-textarea for focus.')
            if (document.activeElement === input) {
              console.debug('[content] #prompt-textarea already focused; skipping injection.')
            } else {
              const injectedValue = ' '
              chatGptPromptTextareaPoked = true
              input.value = injectedValue
              input.dispatchEvent(new Event('input', { bubbles: true }))
              setTimeout(() => {
                const currentInput = document.querySelector('#prompt-textarea')
                if (!currentInput?.isConnected) {
                  console.warn(
                    '[content] #prompt-textarea no longer available in setTimeout callback.',
                  )
                  return
                }
                if (document.activeElement === currentInput) {
                  console.debug('[content] #prompt-textarea focused; skipping injection cleanup.')
                  return
                }
                if (currentInput.value === injectedValue) {
                  currentInput.value = ''
                  currentInput.dispatchEvent(new Event('input', { bubbles: true }))
                  console.debug('[content] #prompt-textarea manipulation complete.')
                } else if (currentInput.value.startsWith(injectedValue)) {
                  currentInput.value = currentInput.value.slice(injectedValue.length)
                  currentInput.dispatchEvent(new Event('input', { bubbles: true }))
                  console.debug('[content] Removed injected leading space from #prompt-textarea.')
                }
              }, 300)
            }
          } else {
            console.debug(
              '[content] #prompt-textarea not found, not empty (value: "' +
                input?.value +
                '"), or not on root path for manipulation.',
            )
          }
        }

        console.log('[content] Sending SET_CHATGPT_TAB message.')
        await Browser.runtime.sendMessage({
          type: 'SET_CHATGPT_TAB',
          data: {},
        })
        console.log('[content] SET_CHATGPT_TAB message sent successfully.')
      } else {
        console.log('[content] This tab is NOT configured for ChatGPT Web model processing.')
      }
    } catch (error) {
      console.error('[content] Error in manageChatGptTabState:', error)
    }
  })()

  try {
    await manageChatGptTabStatePromise
  } finally {
    manageChatGptTabStatePromise = null
  }
}

run()
