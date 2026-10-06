import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, before, beforeEach, test } from 'node:test'

const hookSource = `
const stubs = new Map([
  ['../../../utils', 'test:bilibili-utils'],
  ['../index.mjs', 'test:bilibili-site-adapters'],
  ['../../video-summary-capability.mjs', 'test:bilibili-capability'],
  ['../../video-summary-adapter-controller.mjs', 'test:bilibili-controller'],
  ['./video-page-bridge.mjs', 'test:bilibili-bridge'],
])
const sources = {
  'test:bilibili-utils': \`
    export const cropText = async (value) => value
    export const waitForElementToExistAndSelect = async (selector) => {
      globalThis.__BILIBILI_ADAPTER_TEST__.waitSelectors.push(selector)
      return globalThis.__BILIBILI_ADAPTER_TEST__.targetElement
    }
  \`,
  'test:bilibili-site-adapters': \`export const config = { bilibili: {} }\`,
  'test:bilibili-capability': \`
    export const isEnhancedVideoSummaryAvailable = (config) => {
      const state = globalThis.__BILIBILI_ADAPTER_TEST__
      state.capabilityConfigs.push(config)
      return state.capabilityAvailable
    }
  \`,
  'test:bilibili-controller': \`
    export const createVideoSummaryAdapterController = (options) => {
      const state = globalThis.__BILIBILI_ADAPTER_TEST__
      state.controllerOptions.push(options)
      return {
        async start() {
          state.startCount += 1
        },
      }
    }
  \`,
  'test:bilibili-bridge': \`
    export const createBilibiliVideoPageBridge = (options) => {
      const bridge = { options }
      globalThis.__BILIBILI_ADAPTER_TEST__.bridges.push(bridge)
      return bridge
    }
  \`,
}
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/content-script/site-adapters/bilibili/index.mjs')) {
    const url = stubs.get(specifier)
    if (url) return { url, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('test:bilibili-')) {
    return { format: 'module', source: sources[url], shortCircuit: true }
  }
  return nextLoad(url, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hookSource)}`)

const originalDescriptors = new Map()
const globals = ['location', 'document', 'window']
let adapter

before(async () => {
  for (const name of globals) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }

  Object.defineProperties(globalThis, {
    location: {
      configurable: true,
      value: {
        href: 'https://www.bilibili.com/video/BV1test?p=1',
        pathname: '/video/BV1test',
        search: '?p=1',
      },
    },
    document: {
      configurable: true,
      value: {
        querySelector: (selector) => {
          const state = globalThis.__BILIBILI_ADAPTER_TEST__
          if (selector === '#danmukuBox') return state.targetElement
          if (selector === 'video') return state.videoElement
          return null
        },
      },
    },
    window: {
      configurable: true,
      value: { setInterval: () => 1 },
    },
  })
  ;({ default: adapter } = await import(
    '../../../src/content-script/site-adapters/bilibili/index.mjs'
  ))
})

beforeEach(() => {
  location.href = 'https://www.bilibili.com/video/BV1test?p=1'
  location.pathname = '/video/BV1test'
  location.search = '?p=1'
  globalThis.__BILIBILI_ADAPTER_TEST__ = {
    capabilityAvailable: true,
    capabilityConfigs: [],
    controllerOptions: [],
    startCount: 0,
    bridges: [],
    waitSelectors: [],
    targetElement: { id: 'danmuku' },
    videoElement: {},
  }
})

after(() => {
  delete globalThis.__BILIBILI_ADAPTER_TEST__
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('enhanced mode configures and starts the shared Bilibili controller', async () => {
  const state = globalThis.__BILIBILI_ADAPTER_TEST__
  const userConfig = { videoTranscriptionEnabled: true }

  const result = await adapter.init(
    'www.bilibili.com',
    userConfig,
    () => {},
    () => {},
  )

  assert.equal(result, false)
  assert.deepEqual(state.capabilityConfigs, [userConfig])
  assert.equal(state.controllerOptions.length, 1)
  assert.equal(state.startCount, 1)
  const options = state.controllerOptions[0]
  assert.equal(options.platform, 'bilibili')
  assert.equal(options.findTargetElement(), state.targetElement)
  assert.equal(await options.waitForTargetElement(), state.targetElement)
  assert.deepEqual(state.waitSelectors, ['img.bili-avatar-img', '#danmukuBox'])
  assert.equal(await options.isPageSupported(), true)
  const bridge = options.createBridge()
  assert.equal(bridge, state.bridges[0])
  assert.equal(bridge.options.getLocationHref(), location.href)
  assert.equal(bridge.options.getVideoElement(), state.videoElement)
})

test('unavailable enhanced mode preserves the legacy adapter path', async () => {
  const state = globalThis.__BILIBILI_ADAPTER_TEST__
  state.capabilityAvailable = false

  const result = await adapter.init(
    'www.bilibili.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )

  assert.equal(result, true)
  assert.equal(state.controllerOptions.length, 0)
  assert.equal(state.startCount, 0)
})

test('bangumi pages remain excluded before capability or controller setup', async () => {
  const state = globalThis.__BILIBILI_ADAPTER_TEST__
  location.pathname = '/bangumi/play/ep1'

  const result = await adapter.init(
    'www.bilibili.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )

  assert.equal(result, false)
  assert.equal(state.capabilityConfigs.length, 0)
  assert.equal(state.controllerOptions.length, 0)
})
