import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const contentScriptStubs = new Map([
  ['./styles.scss', 'test:styles'],
  ['../components/DecisionCard', 'test:decision-card'],
  ['./site-adapters', 'test:site-adapters'],
  ['./selection-tools', 'test:selection-tools'],
  ['./menu-tools', 'test:menu-tools'],
  ['../config/index.mjs', 'test:config'],
  ['../utils', 'test:utils'],
  ['../components/FloatingToolbar', 'test:floating-toolbar'],
  ['webextension-polyfill', 'test:browser'],
  ['../config/language.mjs', 'test:language'],
  ['../_locales/i18n-react', 'test:i18n-react'],
  ['i18next', 'test:i18next'],
  ['../services/init-session.mjs', 'test:init-session'],
  ['../services/wrappers.mjs', 'test:wrappers'],
  ['../services/apis/chatgpt-web.mjs', 'test:chatgpt-api'],
  ['../components/WebJumpBackNotification', 'test:jump-back'],
  ['./port-error.mjs', 'test:port-error'],
])

const floatingToolbarStubs = new Map([
  ['react', 'test:floating-react'],
  ['../ConversationCard', 'test:floating-conversation-card'],
  ['../../content-script/selection-tools', 'test:floating-selection-tools'],
  ['../../utils', 'test:floating-utils'],
  ['react-draggable', 'test:floating-draggable'],
  ['../../hooks/use-clamp-window-size', 'test:floating-window-size'],
  ['react-i18next', 'test:floating-i18n'],
  ['../../hooks/use-config.mjs', 'test:floating-config'],
])

const sources = {
  'test:styles': '',
  'test:decision-card': 'export default function DecisionCard() { return null }',
  'test:site-adapters': 'export const config = {}',
  'test:selection-tools': 'export const config = {}',
  'test:menu-tools': 'export const config = {}',
  'test:config': `
    export const chatgptWebModelKeys = []
    export const getPreferredLanguageKey = async () => 'en'
    export const getUserConfig = () => globalThis.__SELECTION_TOOLBAR_TEST__.getUserConfig()
    export const isUsingChatgptWebModel = () => false
    export const setAccessToken = async () => {}
    export const setUserConfig = async () => {}
  `,
  'test:utils': `
    export const createElementAtPosition = () => {
      const element = document.createElement('div')
      document.documentElement.append(element)
      globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.push(element)
      return element
    }
    export const cropText = async (text) => text
    export const endsWithQuestionMark = () => false
    export const getApiModesStringArrayFromConfig = () => []
    export const getClientPosition = () => ({ x: 0, y: 0 })
    export const getPossibleElementByQuerySelector = () => null
  `,
  'test:floating-toolbar': `
    export default function FloatingToolbar() {
      globalThis.__SELECTION_TOOLBAR_TEST__.renderCount += 1
      return null
    }
  `,
  'test:browser': `
    const event = { addListener() {}, removeListener() {} }
    export default {
      runtime: { onMessage: event, sendMessage: async () => {} },
      storage: { onChanged: event },
    }
  `,
  'test:language': `export const getPreferredLanguage = async () => 'English'`,
  'test:i18n-react': '',
  'test:i18next': 'export const changeLanguage = async () => {}',
  'test:init-session': 'export const initSession = () => ({})',
  'test:wrappers': `
    export const getChatGptAccessToken = async () => null
    export const registerPortListener = () => {}
  `,
  'test:chatgpt-api': 'export const generateAnswersWithChatgptWebApi = async () => {}',
  'test:jump-back': 'export default function WebJumpBackNotification() { return null }',
  'test:port-error': `
    export const getPortErrorMessage = (error) => String(error)
    export const shouldDelegatePortError = () => false
  `,
  'test:floating-react': `
    import * as React from 'react'
    export const cloneElement = React.cloneElement
    export const useCallback = React.useCallback
    export const useEffect = React.useEffect
    export const useLayoutEffect = React.useLayoutEffect
    export const useRef = React.useRef
    export const useState = (initialValue) => {
      const [value, setValue] = React.useState(initialValue)
      return [
        value,
        (nextValue) => {
          const state = globalThis.__FLOATING_TOOLBAR_TEST__
          if (state.observeStateUpdates) state.observedStateUpdates.push(nextValue)
          return setValue(nextValue)
        },
      ]
    }
  `,
  'test:floating-conversation-card': `
    import { useLayoutEffect } from 'preact/hooks'
    export default function ConversationCard(props) {
      const state = globalThis.__FLOATING_TOOLBAR_TEST__
      state.onClose = props.onClose
      state.conversationRenderCount = (state.conversationRenderCount ?? 0) + 1
      state.lastQuestion = props.question
      useLayoutEffect(() => () => {
        state.cleanupCount += 1
        state.cleanupSawConnectedContainer = state.container.isConnected
      }, [])
      return null
    }
  `,
  'test:floating-selection-tools': `
    export const config = {
      testTool: {
        icon: globalThis.__FLOATING_TOOLBAR_TEST__?.toolIcon,
        label: 'Test Tool',
        genPrompt: (selection) => globalThis.__FLOATING_TOOLBAR_TEST__.genPrompt(selection),
      },
    }
  `,
  'test:floating-utils': `
    export const getClientPosition = () => ({ x: 0, y: 0 })
    export const isMobile = () => false
    export const setElementPositionInViewport = (_container, x, y) => ({ x, y })
  `,
  'test:floating-draggable': `
    export default function Draggable(props) {
      return props.children
    }
  `,
  'test:floating-window-size': 'export const useClampWindowSize = () => [1000, 1000]',
  'test:floating-i18n': 'export const useTranslation = () => ({ t: (value) => value })',
  'test:floating-config': `
    import { useLayoutEffect } from 'preact/hooks'
    const defaultConfig = {
      alwaysPinWindow: false,
      themeMode: 'light',
      activeSelectionTools: [],
      customSelectionTools: [],
    }
    export const useConfig = (onLoad) => {
      const state = globalThis.__FLOATING_TOOLBAR_TEST__
      useLayoutEffect(() => {
        if (state?.deferConfigLoad) {
          state.pendingConfigLoad = onLoad
          return
        }
        onLoad()
      }, [])
      return state?.config ?? defaultConfig
    }
  `,
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith('test:') && specifier === 'preact/hooks') {
    return nextResolve(specifier, { ...context, parentURL: import.meta.url })
  }

  if (context.parentURL === 'test:floating-react' && specifier === 'react') {
    return nextResolve(specifier, { ...context, parentURL: import.meta.url })
  }

  if (context.parentURL?.endsWith('/src/content-script/index.jsx')) {
    const stubUrl = contentScriptStubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  if (context.parentURL?.endsWith('/src/components/FloatingToolbar/index.jsx')) {
    const stubUrl = floatingToolbarStubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:')) {
    return {
      shortCircuit: true,
      format: 'module',
      source: sources[url],
    }
  }

  if (url.startsWith('file://') && url.endsWith('.jsx') && !url.includes('node_modules')) {
    const source = await readFile(fileURLToPath(url), 'utf8')
    const esbuild = await import('esbuild')
    const result = await esbuild.transform(source, {
      loader: 'jsx',
      jsx: 'automatic',
      jsxImportSource: 'preact',
    })
    return { shortCircuit: true, format: 'module', source: result.code }
  }

  return nextLoad(url, context)
}
