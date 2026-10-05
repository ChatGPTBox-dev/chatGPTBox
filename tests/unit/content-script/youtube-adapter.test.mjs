import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, before, beforeEach, test } from 'node:test'

const hookSource = `
const stubs = new Map([
  ['../../../utils', 'test:youtube-utils'],
  ['../index.mjs', 'test:youtube-site-adapters'],
  ['../../../video-summary/capabilities.mjs', 'test:youtube-capabilities'],
  ['../../video-summary-host.mjs', 'test:youtube-host'],
  ['./video-page-bridge.mjs', 'test:youtube-bridge'],
  ['./media-source.mjs', 'test:youtube-media-source'],
  ['webextension-polyfill', 'test:youtube-browser'],
])
const sources = {
  'test:youtube-utils': \`
    export const cropText = async (value) => value
    export const waitForSiteAdapterElement = async () => {
      const state = globalThis.__YOUTUBE_ADAPTER_TEST__
      return state.targetPromise ? state.targetPromise : state.targetElement
    }
  \`,
  'test:youtube-site-adapters': \`export const config = { youtube: {} }\`,
  'test:youtube-capabilities': \`
    export const isVideoSummaryEnabled = (config) =>
      globalThis.__YOUTUBE_ADAPTER_TEST__.buildSupported &&
      config?.videoTranscriptionEnabled === true
    export const isVideoSummaryRuntimeSupported = (runtime) =>
      runtime.manifestVersion === 3 &&
      runtime.hasOffscreenApi === true &&
      Number.parseInt(runtime.minChromeVersion, 10) >= 116 &&
      (runtime.userAgent.includes('Chrome') || runtime.userAgent.includes('Edg/'))
  \`,
  'test:youtube-host': \`
    export const mountVideoSummaryHost = (options) => {
      const mount = { options, disposed: false }
      globalThis.__YOUTUBE_ADAPTER_TEST__.mounts.push(mount)
      return { dispose() { mount.disposed = true } }
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
      return { videoId, supported: Boolean(videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) }
    }
  \`,
  'test:youtube-browser': \`
    export default {
      runtime: {
        getManifest: () => globalThis.__YOUTUBE_ADAPTER_TEST__.manifest,
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
const globals = ['location', 'document', 'window', 'navigator', 'chrome']
let adapter
let intervals

function setLocation(href) {
  const url = new URL(href)
  globalThis.location.href = href
  globalThis.location.pathname = url.pathname
  globalThis.location.search = url.search
}

function tick() {
  for (const listener of intervals) listener()
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
        querySelector: (selector) => {
          const state = globalThis.__YOUTUBE_ADAPTER_TEST__
          if (selector === 'ytd-watch-flexy[is-live]') return state.live ? {} : null
          if (selector.includes('#secondary')) return state.targetElement
          if (selector === 'video') return state.videoElement
          return null
        },
      },
    },
    window: {
      configurable: true,
      value: {
        setInterval: (listener) => {
          intervals.push(listener)
          return intervals.length
        },
      },
    },
    navigator: {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' },
    },
    chrome: {
      configurable: true,
      value: { offscreen: {} },
    },
  })
  ;({ default: adapter } = await import(
    '../../../src/content-script/site-adapters/youtube/index.mjs'
  ))
})

beforeEach(() => {
  intervals = []
  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A')
  globalThis.__YOUTUBE_ADAPTER_TEST__ = {
    buildSupported: true,
    manifest: {
      manifest_version: 3,
      minimum_chrome_version: '116',
      permissions: ['offscreen'],
    },
    targetElement: { id: 'secondary-a' },
    videoElement: {},
    live: false,
    bridges: [],
    mounts: [],
    runtimeMessages: [],
    pagePlayerResponse: { videoDetails: { videoId: 'SYNTHVID01A' } },
    runtimeResponses: {
      YOUTUBE_PAGE_PLAYER_RESPONSE: {
        ok: true,
        data: { videoDetails: { videoId: 'SYNTHVID01A' } },
      },
      YOUTUBE_PAGE_CAPTURE_CAPTION: { ok: true, data: { body: '{}' } },
    },
  }
  globalThis.navigator.userAgent = 'Mozilla/5.0 Chrome/130.0.0.0'
  globalThis.chrome.offscreen = {}
})

after(() => {
  delete globalThis.__YOUTUBE_ADAPTER_TEST__
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('enhanced mode mounts the shared host in the visible secondary column', async () => {
  let legacyMountCount = 0
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__

  const result = await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true, activeSiteAdapters: ['youtube'] },
    () => {},
    () => {
      legacyMountCount += 1
    },
  )

  assert.equal(result, false)
  assert.equal(legacyMountCount, 0)
  assert.equal(state.mounts.length, 1)
  assert.deepEqual(state.mounts[0].options, {
    platform: 'youtube',
    bridge: state.bridges[0],
    targetElement: state.targetElement,
  })
  assert.equal(state.bridges[0].options.getLocationHref(), location.href)
  assert.equal(state.bridges[0].options.getVideoElement(), state.videoElement)
  assert.deepEqual(
    await state.bridges[0].options.getPlayerResponse('SYNTHVID01A'),
    state.pagePlayerResponse,
  )
  assert.deepEqual(state.runtimeMessages, [
    {
      type: 'YOUTUBE_PAGE_PLAYER_RESPONSE',
      data: { expectedVideoId: 'SYNTHVID01A' },
    },
  ])
})

test('unwraps successful page-data envelopes and throws sanitized failures', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true, activeSiteAdapters: ['youtube'] },
    () => {},
    () => {},
  )
  const options = state.bridges[0].options

  assert.deepEqual(await options.getPlayerResponse('SYNTHVID01A'), state.pagePlayerResponse)
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

test('enhanced mode does not require the background-only Offscreen API in content scripts', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  globalThis.chrome.offscreen = undefined

  const result = await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true, activeSiteAdapters: ['youtube'] },
    () => {},
    () => {},
  )

  assert.equal(result, false)
  assert.equal(state.mounts.length, 1)
})

test('video identity changes dispose and remount while unrelated query changes do not', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )

  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A&t=30&list=sample')
  tick()
  assert.equal(state.mounts.length, 1)
  assert.equal(state.mounts[0].disposed, false)

  setLocation('https://www.youtube.com/watch?v=SYNTHVID01B&t=30')
  tick()
  assert.equal(state.mounts[0].disposed, true)
  assert.equal(state.mounts.length, 2)
  assert.equal(state.mounts[1].options.bridge, state.bridges[1])
})

test('leaving watch disposes the enhanced host without waiting for another target', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )
  state.targetElement = null
  state.targetPromise = new Promise(() => {})
  setLocation('https://www.youtube.com/')

  tick()

  assert.equal(state.mounts[0].disposed, true)
  assert.equal(state.mounts.length, 1)
})

test('coalesces repeated host creation ticks while a replacement target is loading', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )
  let resolveTarget
  state.targetElement = null
  state.targetPromise = new Promise((resolve) => (resolveTarget = resolve))
  tick()
  tick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  resolveTarget({ id: 'secondary-delayed' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(state.mounts.length, 2)
  assert.equal(state.bridges.length, 2)
})

test('replacing the visible secondary target disposes and remounts the host', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  await adapter.init(
    'www.youtube.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )

  state.targetElement = { id: 'secondary-b' }
  tick()

  assert.equal(state.mounts[0].disposed, true)
  assert.equal(state.mounts.length, 2)
  assert.equal(state.mounts[1].options.targetElement, state.targetElement)
})

test('unsupported pages and live watch pages retain the legacy path', async () => {
  const state = globalThis.__YOUTUBE_ADAPTER_TEST__
  setLocation('https://www.youtube.com/shorts/SYNTHVID01A')
  assert.equal(
    await adapter.init(
      'www.youtube.com',
      { videoTranscriptionEnabled: true },
      () => {},
      () => {},
    ),
    true,
  )

  setLocation('https://www.youtube.com/watch?v=SYNTHVID01A')
  state.live = true
  assert.equal(
    await adapter.init(
      'www.youtube.com',
      { videoTranscriptionEnabled: true },
      () => {},
      () => {},
    ),
    true,
  )
  assert.equal(state.mounts.length, 0)
})

test('all capability failures and a disabled adapter retain the legacy path', async (t) => {
  const cases = [
    ['setting disabled', () => ({ videoTranscriptionEnabled: false })],
    ['site adapter disabled', () => ({ videoTranscriptionEnabled: true, activeSiteAdapters: [] })],
    [
      'MV2',
      () => {
        globalThis.__YOUTUBE_ADAPTER_TEST__.manifest.manifest_version = 2
        return { videoTranscriptionEnabled: true }
      },
    ],
    [
      'minimal build',
      () => {
        globalThis.__YOUTUBE_ADAPTER_TEST__.buildSupported = false
        return { videoTranscriptionEnabled: true }
      },
    ],
    [
      'unsupported browser',
      () => {
        globalThis.navigator.userAgent = 'Firefox/130.0'
        return { videoTranscriptionEnabled: true }
      },
    ],
    [
      'unsupported browser version',
      () => {
        globalThis.__YOUTUBE_ADAPTER_TEST__.manifest.minimum_chrome_version = '115'
        return { videoTranscriptionEnabled: true }
      },
    ],
  ]

  for (const [name, prepare] of cases) {
    await t.test(name, async () => {
      const result = await adapter.init(
        'www.youtube.com',
        prepare(),
        () => {},
        () => {},
      )
      assert.equal(result, true)
    })
  }
  assert.equal(globalThis.__YOUTUBE_ADAPTER_TEST__.mounts.length, 0)
})

test('legacy inputQuery remains callable outside the capability gate and suppresses raw errors', async () => {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  let logCount = 0
  globalThis.fetch = async () => {
    throw new Error('sensitive caption URL')
  }
  console.log = () => {
    logCount += 1
  }

  try {
    assert.equal(await adapter.inputQuery(), undefined)
    assert.equal(logCount, 0)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
  }
})
