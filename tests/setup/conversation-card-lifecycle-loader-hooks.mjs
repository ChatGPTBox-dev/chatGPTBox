import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const stubs = new Map([
  ['../InputBox', 'test:conversation-input-box'],
  ['../ConversationItem', 'test:conversation-item'],
  ['../../utils', 'test:conversation-utils'],
  ['@primer/octicons-react', 'test:conversation-primer-icons'],
  ['react-bootstrap-icons', 'test:conversation-bootstrap-icons'],
  ['file-saver', 'test:conversation-file-saver'],
  ['../FloatingToolbar', 'test:conversation-floating-toolbar'],
  ['../../hooks/use-clamp-window-size', 'test:conversation-window-size'],
  ['../../config/index.mjs', 'test:conversation-config'],
  ['react-i18next', 'test:conversation-i18n'],
  ['../DeleteButton', 'test:conversation-delete-button'],
  ['../../hooks/use-config.mjs', 'test:conversation-use-config'],
  ['../../services/local-session.mjs', 'test:conversation-local-session'],
  ['uuid', 'test:conversation-uuid'],
  ['../../services/init-session.mjs', 'test:conversation-init-session'],
  ['lodash-es', 'test:conversation-lodash'],
  ['../../services/apis/bing-web.mjs', 'test:conversation-bing'],
  ['../../services/wrappers.mjs', 'test:conversation-wrappers'],
  ['../../popup/sections/api-modes-provider-utils.mjs', 'test:conversation-provider-utils'],
  ['../../utils/error-text.mjs', 'test:conversation-error-text'],
  ['webextension-polyfill', 'test:conversation-browser'],
])

const iconExports = `
  export const ArchiveIcon = () => null
  export const DesktopDownloadIcon = () => null
  export const LinkExternalIcon = () => null
  export const MoveToBottomIcon = () => null
  export const SearchIcon = () => null
`

const sources = {
  'test:conversation-input-box': `
    export default function InputBox(props) {
      globalThis.__CONVERSATION_LIFECYCLE_TEST__.inputBoxProps = props
      return null
    }
  `,
  'test:conversation-item': 'export default function ConversationItem() { return null }',
  'test:conversation-utils': `
    export const apiModeToModelName = () => 'test-model'
    export const createElementAtPosition = () => document.createElement('div')
    export const getApiModesFromConfig = () => []
    export const getUniquelySelectedApiModeIndex = () => -1
    export const isFirefox = () => false
    export const isMobile = () => false
    export const isSafari = () => false
    export const isUsingModelName = () => false
    export const modelNameToDesc = () => 'Test Model'
  `,
  'test:conversation-primer-icons': iconExports,
  'test:conversation-bootstrap-icons': `
    export const Pin = () => null
    export const WindowDesktop = () => null
    export const XLg = () => null
  `,
  'test:conversation-file-saver': 'export default { saveAs() {} }',
  'test:conversation-floating-toolbar': 'export default function FloatingToolbar() { return null }',
  'test:conversation-window-size': 'export const useClampWindowSize = () => [1000, 1000]',
  'test:conversation-config': `
    export const getUserConfig = () => globalThis.__CONVERSATION_LIFECYCLE_TEST__.getUserConfig()
    export const isUsingBingWebModel = () => globalThis.__CONVERSATION_LIFECYCLE_TEST__.foreground
    export const Models = { customModel: { desc: 'Custom Model' } }
  `,
  'test:conversation-i18n': 'export const useTranslation = () => ({ t: (value) => value })',
  'test:conversation-delete-button': `
    export default function DeleteButton(props) {
      globalThis.__CONVERSATION_LIFECYCLE_TEST__.deleteButtonProps = props
      return null
    }
  `,
  'test:conversation-use-config': `
    export const useConfig = () => globalThis.__CONVERSATION_LIFECYCLE_TEST__.config
  `,
  'test:conversation-local-session': 'export const createSession = async () => {}',
  'test:conversation-uuid': "export const v4 = () => 'test-session-id'",
  'test:conversation-init-session': `
    export const initSession = (session) => ({ conversationRecords: [], ...session })
  `,
  'test:conversation-lodash': `
    export const findLastIndex = (array, predicate) => {
      for (let index = array.length - 1; index >= 0; --index) {
        if (predicate(array[index])) return index
      }
      return -1
    }
  `,
  'test:conversation-bing': `
    export const generateAnswersWithBingWebApi = (...args) =>
      globalThis.__CONVERSATION_LIFECYCLE_TEST__.generateAnswers(...args)
  `,
  'test:conversation-wrappers': 'export const handlePortError = () => {}',
  'test:conversation-provider-utils': `
    export const getApiModeDisplayLabel = () => ''
    export const getConversationAiName = () => 'Test AI'
  `,
  'test:conversation-error-text': 'export const getDisplayErrorText = (value) => String(value)',
  'test:conversation-browser': `
    const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
    export default {
      runtime: {
        connect: () => state.createPort(),
        getURL: (path) => 'chrome-extension://test/' + path,
        sendMessage: async () => {},
        onMessage: state.runtimeOnMessage,
      },
    }
  `,
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/components/ConversationCard/index.jsx')) {
    const stubUrl = stubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:conversation-')) {
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
