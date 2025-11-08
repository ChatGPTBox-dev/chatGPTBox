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

  const userConfig = await getUserConfig()

  if (!userConfig.alwaysFloatingSidebar) {
    const retry = 10
    let oldUrl = location.href
    for (let i = 1; i <= retry; i++) {
      if (location.href !== oldUrl) {
        console.log(`SiteAdapters Retry ${i}/${retry}: stop`)
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
        console.log(`SiteAdapters Retry ${i}/${retry}: found`)
        console.log(e)
        break
      } else {
        console.log(`SiteAdapters Retry ${i}/${retry}: not found`)
        if (i === retry) return
        else await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
  document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').forEach((e) => {
    unmountComponentAtNode(e)
    e.remove()
  })

  let question
  if (userConfig.inputQuery) question = await getInput([userConfig.inputQuery])
  if (!question && siteConfig) question = await getInput(siteConfig.inputQuery)

  document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').forEach((e) => {
    unmountComponentAtNode(e)
    e.remove()
  })

  if (userConfig.alwaysFloatingSidebar && question) {
    const position = {
      x: window.innerWidth - 300 - Math.floor((20 / 100) * window.innerWidth),
      y: window.innerHeight / 2 - 200,
    }
    const toolbarContainer = createElementAtPosition(position.x, position.y)
    toolbarContainer.className = 'chatgptbox-toolbar-container-not-queryable'

    let triggered = false
    if (userConfig.triggerMode === 'always') triggered = true
    else if (userConfig.triggerMode === 'questionMark' && endsWithQuestionMark(question.trim()))
      triggered = true

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
    return
  }

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
}

/**
 * @param {string[]|function} inputQuery
 * @returns {Promise<string>}
 */
async function getInput(inputQuery) {
  let input
  if (typeof inputQuery === 'function') {
    input = await inputQuery()
    const replyPromptBelow = `Reply in ${await getPreferredLanguage()}. Regardless of the language of content I provide below. !!This is very important!!`
    const replyPromptAbove = `Reply in ${await getPreferredLanguage()}. Regardless of the language of content I provide above. !!This is very important!!`
    if (input) return `${replyPromptBelow}\n\n` + input + `\n\n${replyPromptAbove}`
    return input
  }
  const searchInput = getPossibleElementByQuerySelector(inputQuery)
  if (searchInput) {
    if (searchInput.value) input = searchInput.value
    else if (searchInput.textContent) input = searchInput.textContent
    if (input) {
      const preferredLanguage = await getPreferredLanguage()
      return `## Role
<role>
You are a knowledgeable research assistant helping users understand search queries and providing relevant information.
</role>

## Task
<task>
Interpret the user's search query and provide comprehensive, useful information related to their search intent.
</task>

## Instructions
<instructions>
1. **Interpret search intent**:
   - Informational (learning about a topic)
   - Navigational (finding a specific site/resource)
   - Transactional (looking to perform an action)
   - Investigational (comparing options)

2. **Provide relevant information**:
   - Direct answer to the query (if applicable)
   - Background context and explanations
   - Related concepts or topics
   - Practical examples or use cases
   - Common solutions (for problem-based queries)

3. **Structure response** using markdown for readability:
   - Use headers for main sections
   - Use bullet points for lists
   - Use code blocks for technical content
   - Use tables for comparisons

4. **Response language**: Reply in ${preferredLanguage}
</instructions>

## Output Format
<output_format>
# [Restate or clarify the search query]

## Quick Answer
[Direct, concise answer if query has a definitive answer]

## Detailed Explanation
[Comprehensive information addressing the query]

## Key Points
- [Important point 1]
- [Important point 2]
- [Important point 3]

## Related Topics
- [Related topic 1]: [Brief description]
- [Related topic 2]: [Brief description]

## Practical Examples
[Real-world examples or use cases if applicable]

## Additional Resources
[Suggestions for further reading or exploration]
</output_format>

## Input Data
<input_data>
Search Query: ${input}
Preferred Language: ${preferredLanguage}
</input_data>

## Constraints
<constraints>
- Provide accurate, up-to-date information to the best of your knowledge
- If uncertain, acknowledge limitations
- Avoid speculation beyond available knowledge
- Use clear, accessible language appropriate for general audiences
- Prioritize usefulness and actionability
</constraints>`
    }
  }
}

let toolbarContainer
const deleteToolbar = () => {
  if (toolbarContainer && toolbarContainer.className === 'chatgptbox-toolbar-container')
    toolbarContainer.remove()
}

const createSelectionTools = async (toolbarContainer, selection) => {
  toolbarContainer.className = 'chatgptbox-toolbar-container'
  const userConfig = await getUserConfig()
  render(
    <FloatingToolbar
      session={initSession({
        modelName: userConfig.modelName,
        apiMode: userConfig.apiMode,
        extraCustomModelName: userConfig.customModelName,
      })}
      selection={selection}
      container={toolbarContainer}
      dockable={true}
    />,
    toolbarContainer,
  )
}

async function prepareForSelectionTools() {
  document.addEventListener('mouseup', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return
    const selectionElement =
      window.getSelection()?.rangeCount > 0 &&
      window.getSelection()?.getRangeAt(0).endContainer.parentElement
    if (toolbarContainer && selectionElement && toolbarContainer.contains(selectionElement)) return

    deleteToolbar()
    setTimeout(async () => {
      const selection = window
        .getSelection()
        ?.toString()
        .trim()
        .replace(/^-+|-+$/g, '')
      if (selection) {
        let position

        const config = await getUserConfig()
        if (!config.selectionToolsNextToInputBox) position = { x: e.pageX + 20, y: e.pageY + 20 }
        else {
          const inputElement = selectionElement.querySelector('input, textarea')
          if (inputElement) {
            position = getClientPosition(inputElement)
            position = {
              x: position.x + window.scrollX + inputElement.offsetWidth + 50,
              y: e.pageY + 30,
            }
          } else {
            position = { x: e.pageX + 20, y: e.pageY + 20 }
          }
        }
        toolbarContainer = createElementAtPosition(position.x, position.y)
        await createSelectionTools(toolbarContainer, selection)
      }
    })
  })
  document.addEventListener('mousedown', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return

    document.querySelectorAll('.chatgptbox-toolbar-container').forEach((e) => e.remove())
  })
  document.addEventListener('keydown', (e) => {
    if (
      toolbarContainer &&
      !toolbarContainer.contains(e.target) &&
      (e.target.nodeName === 'INPUT' || e.target.nodeName === 'TEXTAREA')
    ) {
      setTimeout(() => {
        if (!window.getSelection()?.toString().trim()) deleteToolbar()
      })
    }
  })
}

async function prepareForSelectionToolsTouch() {
  document.addEventListener('touchend', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return
    if (
      toolbarContainer &&
      window.getSelection()?.rangeCount > 0 &&
      toolbarContainer.contains(window.getSelection()?.getRangeAt(0).endContainer.parentElement)
    )
      return

    deleteToolbar()
    setTimeout(() => {
      const selection = window
        .getSelection()
        ?.toString()
        .trim()
        .replace(/^-+|-+$/g, '')
      if (selection) {
        toolbarContainer = createElementAtPosition(
          e.changedTouches[0].pageX + 20,
          e.changedTouches[0].pageY + 20,
        )
        createSelectionTools(toolbarContainer, selection)
      }
    })
  })
  document.addEventListener('touchstart', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return

    document.querySelectorAll('.chatgptbox-toolbar-container').forEach((e) => e.remove())
  })
}

let menuX, menuY

async function prepareForRightClickMenu() {
  document.addEventListener('contextmenu', (e) => {
    menuX = e.clientX
    menuY = e.clientY
  })

  Browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'CREATE_CHAT') {
      const data = message.data
      let prompt = ''
      if (data.itemId in toolsConfig) {
        prompt = await toolsConfig[data.itemId].genPrompt(data.selectionText)
      } else if (data.itemId in menuConfig) {
        const menuItem = menuConfig[data.itemId]
        if (!menuItem.genPrompt) return
        else prompt = await menuItem.genPrompt()
        if (prompt) prompt = await cropText(`Reply in ${await getPreferredLanguage()}.\n` + prompt)
      }

      const position = data.useMenuPosition
        ? { x: menuX, y: menuY }
        : { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 - 200 }
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
    }
  })
}

async function prepareForStaticCard() {
  const userConfig = await getUserConfig()
  let siteRegex
  if (userConfig.useSiteRegexOnly) siteRegex = userConfig.siteRegex
  else
    siteRegex = new RegExp(
      (userConfig.siteRegex && userConfig.siteRegex + '|') + Object.keys(siteConfig).join('|'),
    )

  const matches = location.hostname.match(siteRegex)
  if (matches) {
    const siteName = matches[0]

    if (
      userConfig.siteAdapters.includes(siteName) &&
      !userConfig.activeSiteAdapters.includes(siteName)
    )
      return

    let initSuccess = true
    if (siteName in siteConfig) {
      const siteAction = siteConfig[siteName].action
      if (siteAction && siteAction.init) {
        initSuccess = await siteAction.init(location.hostname, userConfig, getInput, mountComponent)
      }
    }

    if (initSuccess) mountComponent(siteName, siteConfig[siteName])
  }
}

async function overwriteAccessToken() {
  if (location.hostname !== 'chatgpt.com') {
    if (location.hostname === 'kimi.moonshot.cn' || location.hostname.includes('kimi.com')) {
      setUserConfig({
        kimiMoonShotRefreshToken: window.localStorage.refresh_token,
      })
    }
    return
  }

  let data
  if (location.pathname === '/api/auth/session') {
    const response = document.querySelector('pre').textContent
    try {
      data = JSON.parse(response)
    } catch (error) {
      console.error('json error', error)
    }
  } else {
    const resp = await fetch('https://chatgpt.com/api/auth/session')
    data = await resp.json().catch(() => ({}))
  }
  if (data && data.accessToken) {
    await setAccessToken(data.accessToken)
    console.log(data.accessToken)
  }
}

async function prepareForForegroundRequests() {
  if (location.hostname !== 'chatgpt.com' || location.pathname === '/auth/login') return

  const userConfig = await getUserConfig()

  if (
    !chatgptWebModelKeys.some((model) =>
      getApiModesStringArrayFromConfig(userConfig, true).includes(model),
    )
  )
    return

  // if (location.pathname === '/') {
  //   const input = document.querySelector('#prompt-textarea')
  //   if (input) {
  //     input.textContent = ' '
  //     input.dispatchEvent(new Event('input', { bubbles: true }))
  //     setTimeout(() => {
  //       input.textContent = ''
  //       input.dispatchEvent(new Event('input', { bubbles: true }))
  //     }, 300)
  //   }
  // }

  await Browser.runtime.sendMessage({
    type: 'SET_CHATGPT_TAB',
    data: {},
  })

  registerPortListener(async (session, port) => {
    if (isUsingChatgptWebModel(session)) {
      const accessToken = await getChatGptAccessToken()
      await generateAnswersWithChatgptWebApi(port, session.question, session, accessToken)
    }
  })
}

async function getClaudeSessionKey() {
  return Browser.runtime.sendMessage({
    type: 'GET_COOKIE',
    data: { url: 'https://claude.ai/', name: 'sessionKey' },
  })
}

async function prepareForJumpBackNotification() {
  if (
    location.hostname === 'chatgpt.com' &&
    document.querySelector('button[data-testid=login-button]')
  ) {
    console.log('chatgpt not logged in')
    return
  }

  const url = new URL(window.location.href)
  if (url.searchParams.has('chatgptbox_notification')) {
    if (location.hostname === 'claude.ai' && !(await getClaudeSessionKey())) {
      console.log('claude not logged in')

      await new Promise((resolve) => {
        const timer = setInterval(async () => {
          const token = await getClaudeSessionKey()
          if (token) {
            clearInterval(timer)
            resolve()
          }
        }, 500)
      })
    }

    if (
      (location.hostname === 'kimi.moonshot.cn' || location.hostname.includes('kimi.com')) &&
      !window.localStorage.refresh_token
    ) {
      console.log('kimi not logged in')
      setTimeout(() => {
        document.querySelector('.user-info-container').click()
      }, 1000)

      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const token = window.localStorage.refresh_token
          if (token) {
            setUserConfig({
              kimiMoonShotRefreshToken: token,
            })
            clearInterval(timer)
            resolve()
          }
        }, 500)
      })
    }

    const div = document.createElement('div')
    document.body.append(div)
    render(
      <WebJumpBackNotification container={div} chatgptMode={location.hostname === 'chatgpt.com'} />,
      div,
    )
  }
}

async function run() {
  await getPreferredLanguageKey().then((lang) => {
    changeLanguage(lang)
  })
  Browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'CHANGE_LANG') {
      const data = message.data
      changeLanguage(data.lang)
    }
  })

  await overwriteAccessToken()
  await prepareForForegroundRequests()

  prepareForSelectionTools()
  prepareForSelectionToolsTouch()
  prepareForStaticCard()
  prepareForRightClickMenu()
  prepareForJumpBackNotification()
}

run()
