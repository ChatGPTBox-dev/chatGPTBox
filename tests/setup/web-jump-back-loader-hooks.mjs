import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const stubs = new Map([
  ['react-i18next', 'test:jump-back-i18n'],
  ['react-toastify', 'test:jump-back-toast'],
  ['react-toastify/dist/ReactToastify.css', 'test:jump-back-styles'],
  ['../../hooks/use-theme.mjs', 'test:jump-back-theme'],
])

const sources = {
  'test:jump-back-i18n': 'export const useTranslation = () => ({ t: (value) => value })',
  'test:jump-back-toast': `
    export const toast = (content) => {
      globalThis.__JUMP_BACK_TEST__.content = content
    }
    export const ToastContainer = () => null
  `,
  'test:jump-back-styles': '',
  'test:jump-back-theme': `
    export const useTheme = () => ['light', { themeMode: 'light', preferredLanguage: 'en' }]
  `,
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/components/WebJumpBackNotification/index.jsx')) {
    const stubUrl = stubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:jump-back-')) {
    return { shortCircuit: true, format: 'module', source: sources[url] }
  }
  if (url.endsWith('/src/components/WebJumpBackNotification/index.jsx')) {
    const { transform } = await import('esbuild')
    const { code } = await transform(await readFile(fileURLToPath(url), 'utf8'), {
      loader: 'jsx',
      jsx: 'automatic',
      jsxImportSource: 'preact',
    })
    return { shortCircuit: true, format: 'module', source: code }
  }
  return nextLoad(url, context)
}
