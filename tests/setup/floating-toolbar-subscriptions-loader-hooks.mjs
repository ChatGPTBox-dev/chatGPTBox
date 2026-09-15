import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const floatingToolbarStubs = new Map([
  ['../ConversationCard', 'test:subscription-conversation-card'],
  ['../../content-script/selection-tools', 'test:subscription-selection-tools'],
  ['../../utils', 'test:subscription-utils'],
  ['react-draggable', 'test:subscription-draggable'],
  ['react-i18next', 'test:subscription-i18n'],
])

const useConfigStubs = new Map([
  ['../config/index.mjs', 'test:subscription-config'],
  ['webextension-polyfill', 'test:subscription-browser'],
  ['./config-storage-listener.mjs', 'test:subscription-config-listener'],
])

const sources = {
  'test:subscription-conversation-card': `
    export default function ConversationCard(props) {
      globalThis.__FLOATING_SUBSCRIPTION_TEST__.onCloseBySession.set(props.session.id, props.onClose)
      return null
    }
  `,
  'test:subscription-selection-tools': 'export const config = {}',
  'test:subscription-utils': `
    export const getClientPosition = () => ({ x: 0, y: 0 })
    export const isMobile = () => true
    export const setElementPositionInViewport = (_container, x, y) => ({ x, y })
  `,
  'test:subscription-draggable': `
    export default function Draggable(props) {
      return props.children
    }
  `,
  'test:subscription-i18n': 'export const useTranslation = () => ({ t: (value) => value })',
  'test:subscription-config': `
    export const defaultConfig = {
      alwaysPinWindow: false,
      themeMode: 'light',
      activeSelectionTools: [],
      customSelectionTools: [],
    }
    export const getUserConfig = async () => defaultConfig
  `,
  'test:subscription-browser': `
    const state = globalThis.__FLOATING_SUBSCRIPTION_TEST__
    export default {
      storage: {
        local: {
          onChanged: {
            addListener(listener) {
              state.storageListeners.add(listener)
            },
            removeListener(listener) {
              state.storageListeners.delete(listener)
            },
          },
        },
      },
    }
  `,
  'test:subscription-config-listener': `
    export const createConfigStorageListener = () => () => {}
  `,
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/components/FloatingToolbar/index.jsx')) {
    if (specifier === '../../hooks/use-clamp-window-size') {
      return nextResolve('../../hooks/use-clamp-window-size.mjs', context)
    }

    const stubUrl = floatingToolbarStubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  if (context.parentURL?.endsWith('/src/hooks/use-config.mjs')) {
    const stubUrl = useConfigStubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:subscription-')) {
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
