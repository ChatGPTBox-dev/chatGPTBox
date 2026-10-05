import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const hostStubs = new Map([
  ['webextension-polyfill', 'test:video-summary-browser'],
  ['file-saver', 'test:video-summary-file-saver'],
  ['../components/FloatingToolbar', 'test:video-summary-floating-toolbar'],
  ['../components/VideoSummaryView/index.jsx', 'test:video-summary-view'],
  ['../components/VideoSummaryView/styles.scss', 'test:video-summary-styles'],
  ['../video-summary/markdown-export.mjs', 'test:video-summary-markdown'],
  ['../video-summary/settings.mjs', 'test:video-summary-settings'],
  ['../services/local-session.mjs', 'test:video-summary-session'],
  ['../config/index.mjs', 'test:video-summary-config'],
  ['../utils', 'test:video-summary-utils'],
])

const sources = {
  'test:video-summary-browser': `
    export default { runtime: { connect: (...args) => globalThis.__VIDEO_SUMMARY_HOST_TEST__.connect(...args) } }
  `,
  'test:video-summary-file-saver': `
    export default { saveAs: (...args) => globalThis.__VIDEO_SUMMARY_HOST_TEST__.savedFiles.push(args) }
  `,
  'test:video-summary-floating-toolbar': `
    export default function FloatingToolbar(props) {
      globalThis.__VIDEO_SUMMARY_HOST_TEST__.toolbarProps.push(props)
      return null
    }
  `,
  'test:video-summary-view': `
    export default function VideoSummaryView(props) {
      globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.set(props.platform, props)
      return null
    }
  `,
  'test:video-summary-styles': '',
  'test:video-summary-markdown': `
    export const buildVideoSummaryMarkdown = (input) => {
      globalThis.__VIDEO_SUMMARY_HOST_TEST__.markdownInputs.push(input)
      return '# Synthetic markdown'
    }
  `,
  'test:video-summary-settings': `
    export const createVideoSummarySettingsSnapshot = (input) => ({ settings: input })
  `,
  'test:video-summary-session': `
    export const initDefaultSession = async () => ({ conversationRecords: [] })
    export const createSession = async (session) => globalThis.__VIDEO_SUMMARY_HOST_TEST__.sessions.push(session)
  `,
  'test:video-summary-config': `
    export const getPreferredLanguageKey = async () => 'en-US'
    export const getUserConfig = async () => ({ modelName: 'test-model', apiMode: 'test-mode' })
  `,
  'test:video-summary-utils': `
    export const createElementAtPosition = () => {
      const element = document.createElement('div')
      document.body.append(element)
      globalThis.__VIDEO_SUMMARY_HOST_TEST__.toolbarContainers.push(element)
      return element
    }
  `,
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/content-script/video-summary-host.mjs')) {
    const stubUrl = hostStubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:')) {
    return { shortCircuit: true, format: 'module', source: sources[url] }
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
