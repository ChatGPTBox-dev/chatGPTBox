import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, before, beforeEach, test } from 'node:test'

const hookSource = `
const stubs = new Map([
  ['../../../utils', 'test:youtube-utils'],
  ['../index.mjs', 'test:youtube-site-adapters'],
  ['../../video-summary-capability.mjs', 'test:youtube-capability'],
  ['../../video-summary-adapter-controller.mjs', 'test:youtube-controller'],
  ['../../video-summary-page-mode.mjs', 'test:youtube-page-mode'],
  ['../../video-summary-host.mjs', 'test:youtube-host'],
  ['./video-page-bridge.mjs', 'test:youtube-bridge'],
  ['./media-source.mjs', 'test:youtube-media-source'],
  ['webextension-polyfill', 'test:youtube-browser'],
])
const sources = {
  'test:youtube-utils': \`
    export const cropText = async (value) => value
    export const waitForSiteAdapterElement = async () => globalThis.__YOUTUBE_ADAPTER_TEST__.targetElement
  \`,
  'test:youtube-site-adapters': \`export const config = { youtube: {} }\`,
  'test:youtube-capability': \`
    export const isEnhancedVideoSummaryAvailable = (config) => {
      globalThis.__YOUTUBE_ADAPTER_TEST__.capabilityConfigs.push(config)
      return globalThis.__YOUTUBE_ADAPTER_TEST__.capabilityAvailable
    }
  \`,
  'test:youtube-controller': \`
    export const createVideoSummaryAdapterController = (options) => {
      globalThis.__YOUTUBE_ADAPTER_TEST__.controllerOptions.push(options)
      return { async start() { globalThis.__YOUTUBE_ADAPTER_TEST__.startCount += 1 } }
    }
  \`,
  'test:youtube-page-mode': \`
    export const resolvePageMode = (options) => {
      globalThis.__YOUTUBE_ADAPTER_TEST__.modeInputs.push(options)
      if (options.pageIdentity && options.pageState.enhancedSupported && options.capabilities.enhanced) return 'enhanced'
      return options.pageState.legacySupported ? 'legacy' : 'none'
    }
  \`,
  'test:youtube-host': \`
    export const mountVideoSummaryHost = (options) => {
      let connected = true
      return { ...options, dispose() { connected = false }, isConnected: () => connected }
    }
  \`,
  'test:youtube-bridge': \`
    export const createYouTubeVideoPageBridge = (options) => {
      const bridge = { options }
      globalThis.__YOUTUBE_ADAPTER_TEST__.bridges.push(bridge)
      return bridge
    }
  \`,
  'test:youtube-media-source': \`
    export const getYouTubeWatchIdentity = (href) => {
      const url = new URL(href)
      const videoId = url.pathname === '/watch' ? url.searchParams.get('v') : null
      const supported = Boolean(videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId))
      return { videoId, supported, pageIdentity: supported ? { platform: 'youtube', videoId, mediaId: videoId } : null }
    }
  \`,
  'test:youtube-browser': \`export default { runtime: { sendMessage: async () => ({ ok: true, data: {} }) } }\`,
}
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/content-script/site-adapters/youtube/index.mjs')) {
    const url = stubs.get(specifier)
    if (url) return { url, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('test:youtube-')) return { format: 'module', source: sources[url], shortCircuit: true }
  return nextLoad(url, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hookSource)}`)

const originals = new Map()
const names = ['location', 'document', 'window']
let adapter

function setLocation(href) {
  const url = new URL(href)
  location.href = href
  location.pathname = url.pathname
  location.search = url.search
}

before(async () => {
  for (const name of names) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperties(globalThis, {
    location: {
      configurable: true,
      value: { href: '', pathname: '', search: '' },
    },
    document: {
      configurable: true,
      value: {
        documentElement: { outerHTML: '<html></html>' },
        querySelector(selector) {
          const state = globalThis.__YOUTUBE_ADAPTER_TEST__
          if (selector === 'ytd-watch-flexy[is-live]') return state.live ? {} : null
          if (selector.includes('#secondary')) return state.targetElement
          if (selector === 'video') return state.videoElement
          return null
        },
        querySelectorAll: () => [{ remove() {} }],
      },
    },
    window: {
      configurable: true,
      value: { setInterval: () => 1, clearInterval() {} },
    },
  })
  ;({ default: adapter } = await import(
    '../../../src/content-script/site-adapters/youtube/index.mjs'
  ))
})

beforeEach(() => {
  setLocation('https://www.youtube.com/')
  globalThis.__YOUTUBE_ADAPTER_TEST__ = {
    capabilityAvailable: true,
    capabilityConfigs: [],
    controllerOptions: [],
    modeInputs: [],
    startCount: 0,
    targetElement: { id: 'secondary' },
    videoElement: {},
    live: false,
    bridges: [],
  }
})

after(() => {
  delete globalThis.__YOUTUBE_ADAPTER_TEST__
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('starts one page-mode controller from YouTube home and resolves every SPA page mode', async () => {
  const mounts = []
  const result = await adapter.init(
    'www.youtube.com',
    { activeSiteAdapters: ['youtube'] },
    () => {},
    (...args) => {
      mounts.push(args)
    },
  )
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  assert.equal(result, false)
  assert.equal(state.startCount, 1)
  const options = state.controllerOptions[0]

  assert.equal(options.getPageIdentity(), null)
  assert.equal(await options.resolveMode({ pageIdentity: null }), 'none')

  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A')
  const watchIdentity = options.getPageIdentity()
  assert.deepEqual(watchIdentity, {
    platform: 'youtube',
    videoId: 'SYNTHVID01A',
    mediaId: 'SYNTHVID01A',
  })
  assert.equal(await options.resolveMode({ pageIdentity: watchIdentity }), 'enhanced')

  state.live = true
  assert.equal(await options.resolveMode({ pageIdentity: watchIdentity }), 'legacy')
  state.live = false
  setLocation('https://www.youtube.com/shorts/SYNTHVID01A')
  assert.equal(await options.resolveMode({ pageIdentity: options.getPageIdentity() }), 'legacy')
  setLocation('https://www.youtube.com/live/SYNTHVID01A')
  assert.equal(await options.resolveMode({ pageIdentity: options.getPageIdentity() }), 'legacy')
  setLocation('https://www.youtube.com/feed/subscriptions')
  assert.equal(await options.resolveMode({ pageIdentity: options.getPageIdentity() }), 'none')
  assert.equal(mounts.length, 0)
})

test('enhanced and legacy mounts return disposable connected handles', async () => {
  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A')
  const mountCalls = []
  await adapter.init(
    'www.youtube.com',
    {},
    () => {},
    async (...args) => mountCalls.push(args),
  )
  const options = globalThis.__YOUTUBE_ADAPTER_TEST__.controllerOptions[0]
  const pageIdentity = options.getPageIdentity()
  const enhanced = await options.mountEnhanced({
    pageIdentity,
    pageGeneration: 4,
    targetElement: {},
  })
  assert.equal(enhanced.isConnected(), true)
  enhanced.dispose()
  assert.equal(enhanced.isConnected(), false)

  const legacy = await options.mountLegacy({ pageIdentity, pageGeneration: 5, targetElement: {} })
  assert.equal(mountCalls.length, 1)
  assert.equal(typeof legacy.dispose, 'function')
  assert.equal(typeof legacy.isConnected, 'function')
})
