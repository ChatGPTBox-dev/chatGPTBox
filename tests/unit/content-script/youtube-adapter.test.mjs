import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, before, beforeEach, test } from 'node:test'

const hookSource = `
const stubs = new Map([
  ['../../../utils', 'test:youtube-utils'],
  ['../index.mjs', 'test:youtube-site-adapters'],
  ['../../video-summary-capability.mjs', 'test:youtube-capability'],
  ['../../video-summary-adapter-controller.mjs', 'test:youtube-controller'],
  ['./video-page-bridge.mjs', 'test:youtube-bridge'],
  ['./media-source.mjs', 'test:youtube-media-source'],
  ['webextension-polyfill', 'test:youtube-browser'],
])
const sources = {
  'test:youtube-utils': \`
    export const cropText = async (value) => value
    export const waitForSiteAdapterElement = async (selector) => {
      globalThis.__YOUTUBE_ADAPTER_TEST__.waitSelectors.push(selector)
      return globalThis.__YOUTUBE_ADAPTER_TEST__.targetElement
    }
  \`,
  'test:youtube-site-adapters': \`export const config = { youtube: {} }\`,
  'test:youtube-capability': \`
    export const isEnhancedVideoSummaryAvailable = (config) => {
      const state = globalThis.__YOUTUBE_ADAPTER_TEST__
      state.capabilityConfigs.push(config)
      return state.capabilityAvailable
    }
  \`,
  'test:youtube-controller': \`
    export const createVideoSummaryAdapterController = (options) => {
      const state = globalThis.__YOUTUBE_ADAPTER_TEST__
      state.controllerOptions.push(options)
      return {
        async start() {
          state.startCount += 1
        },
      }
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
      try {
        const url = new URL(href)
        const videoId = url.pathname === '/watch' ? url.searchParams.get('v') : null
        return { videoId, supported: Boolean(videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) }
      } catch {
        return { videoId: null, supported: false }
      }
    }
  \`,
  'test:youtube-browser': \`
    export default {
      runtime: {
        sendMessage: async (message) => {
          const state = globalThis.__YOUTUBE_ADAPTER_TEST__
          state.runtimeMessages.push(message)
          return state.runtimeResponses[message.type]
        },
      },
    }
  \`,
}
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/content-script/site-adapters/youtube/index.mjs')) {
    const url = stubs.get(specifier)
    if (url) return { url, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('test:youtube-')) {
    return { format: 'module', source: sources[url], shortCircuit: true }
  }
  return nextLoad(url, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hookSource)}`)

const originalDescriptors = new Map()
const globals = ['location', 'document', 'window']
let adapter

function setLocation(href) {
  const url = new URL(href)
  location.href = href
  location.pathname = url.pathname
  location.search = url.search
}

before(async () => {
  for (const name of globals) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  Object.defineProperties(globalThis, {
    location: {
      configurable: true,
      value: {
        href: 'https://www.youtube.com/watch?v=SYNTHVID01A',
        pathname: '/watch',
        search: '?v=SYNTHVID01A',
      },
    },
    document: {
      configurable: true,
      value: {
        documentElement: { outerHTML: '<html></html>' },
        querySelector: (selector) => {
          const state = globalThis.__YOUTUBE_ADAPTER_TEST__
          if (selector === 'ytd-watch-flexy[is-live]') return state.live ? {} : null
          if (selector.includes('#secondary')) return state.targetElement
          if (selector === 'video') return state.videoElement
          return null
        },
      },
    },
    window: { configurable: true, value: { setInterval: () => 1 } },
  })
  ;({ default: adapter } = await import(
    '../../../src/content-script/site-adapters/youtube/index.mjs'
  ))
})

beforeEach(() => {
  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A')
  delete globalThis.ytInitialPlayerResponse
  globalThis.__YOUTUBE_ADAPTER_TEST__ = {
    capabilityAvailable: true,
    capabilityConfigs: [],
    controllerOptions: [],
    startCount: 0,
    targetElement: { id: 'secondary' },
    videoElement: {},
    waitSelectors: [],
    live: false,
    bridges: [],
    runtimeMessages: [],
    runtimeResponses: {
      YOUTUBE_PAGE_PLAYER_RESPONSE: {
        ok: true,
        data: { videoDetails: { videoId: 'SYNTHVID01A' } },
      },
      YOUTUBE_PAGE_CAPTURE_CAPTION: { ok: true, data: { body: '{}' } },
    },
  }
})

after(() => {
  delete globalThis.__YOUTUBE_ADAPTER_TEST__
  delete globalThis.ytInitialPlayerResponse
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('enhanced mode configures and starts the shared YouTube controller', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  const userConfig = { videoTranscriptionEnabled: true, activeSiteAdapters: ['youtube'] }

  const result = await adapter.init(
    'www.youtube.com',
    userConfig,
    () => {},
    () => {},
  )

  assert.equal(result, false)
  assert.deepEqual(state.capabilityConfigs, [userConfig])
  assert.equal(state.controllerOptions.length, 1)
  assert.equal(state.startCount, 1)
  const options = state.controllerOptions[0]
  assert.equal(options.platform, 'youtube')
  assert.equal(options.findTargetElement(), state.targetElement)
  assert.equal(await options.waitForTargetElement(), state.targetElement)
  assert.equal(state.waitSelectors.length, 1)
  assert.match(state.waitSelectors[0], /^#secondary/)
  assert.equal(await options.isPageSupported(), true)
  const bridge = options.createBridge()
  assert.equal(bridge, state.bridges[0])
  assert.equal(bridge.options.getLocationHref(), location.href)
  assert.equal(bridge.options.getVideoElement(), state.videoElement)
})

test('YouTube bridge preserves page-data RPC envelopes and sanitizes failures', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )
  const options = state.controllerOptions[0].createBridge().options

  assert.deepEqual(await options.getPlayerResponse('SYNTHVID01A'), {
    videoDetails: { videoId: 'SYNTHVID01A' },
  })
  assert.deepEqual(
    await options.captureCaption({
      expectedVideoId: 'SYNTHVID01A',
      language: 'en',
      sourceKind: 'author',
      vssId: '.en',
      mode: 'nativeOnly',
    }),
    { body: '{}' },
  )
  assert.deepEqual(state.runtimeMessages, [
    {
      type: 'YOUTUBE_PAGE_PLAYER_RESPONSE',
      data: { expectedVideoId: 'SYNTHVID01A' },
    },
    {
      type: 'YOUTUBE_PAGE_CAPTURE_CAPTION',
      data: {
        expectedVideoId: 'SYNTHVID01A',
        language: 'en',
        sourceKind: 'author',
        vssId: '.en',
        mode: 'nativeOnly',
      },
    },
  ])

  state.runtimeResponses.YOUTUBE_PAGE_PLAYER_RESPONSE = {
    ok: false,
    errorCode: 'YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED',
    causeCode: 'ReferenceError',
    stage: 'player-response',
    message: 'token=secret',
  }
  await assert.rejects(
    () => options.getPlayerResponse('SYNTHVID01A'),
    (error) => {
      assert.equal(error.message, 'YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED')
      assert.equal(error.causeCode, 'ReferenceError')
      assert.equal(error.stage, 'player-response')
      assert.equal(String(error.stack).includes('secret'), false)
      return true
    },
  )
})

test('malformed watch, Shorts, and live pages preserve the legacy path', async (t) => {
  const cases = [
    ['malformed watch', 'https://www.youtube.com/watch?v=bad', false],
    ['Shorts', 'https://www.youtube.com/shorts/SYNTHVID01A', false],
    ['live watch', 'https://www.youtube.com/watch?v=SYNTHVID01A', true],
  ]

  for (const [name, href, live] of cases) {
    await t.test(name, async () => {
      const state = globalThis.__YOUTUBE_ADAPTER_TEST__
      setLocation(href)
      state.live = live
      assert.equal(
        await adapter.init(
          'www.youtube.com',
          { videoTranscriptionEnabled: true },
          () => {},
          () => {},
        ),
        true,
      )
    })
  }
})

test('unavailable enhanced mode and a disabled adapter preserve the legacy path', async (t) => {
  const cases = [
    ['capability unavailable', { videoTranscriptionEnabled: true }, false],
    ['site adapter disabled', { videoTranscriptionEnabled: true, activeSiteAdapters: [] }, true],
  ]

  for (const [name, config, capabilityAvailable] of cases) {
    await t.test(name, async () => {
      const state = globalThis.__YOUTUBE_ADAPTER_TEST__
      state.capabilityAvailable = capabilityAvailable
      assert.equal(
        await adapter.init(
          'www.youtube.com',
          config,
          () => {},
          () => {},
        ),
        true,
      )
      assert.equal(state.controllerOptions.length, 0)
    })
  }
})

test('controller eligibility follows navigation to unsupported and live pages', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )
  const { isPageSupported } = state.controllerOptions[0]

  setLocation('https://www.youtube.com/shorts/SYNTHVID01A')
  assert.equal(await isPageSupported(), false)
  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A')
  state.live = true
  assert.equal(await isPageSupported(), false)
})
