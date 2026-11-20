import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, before, beforeEach, test } from 'node:test'

const hookSource = `
const stubs = new Map([
  ['../../../utils', 'test:bilibili-utils'],
  ['../index.mjs', 'test:bilibili-site-adapters'],
  ['../../video-summary-capability.mjs', 'test:bilibili-capability'],
  ['../../video-summary-adapter-controller.mjs', 'test:bilibili-controller'],
  ['../../video-summary-page-mode.mjs', 'test:bilibili-page-mode'],
  ['../../video-summary-host.mjs', 'test:bilibili-host'],
  ['./video-page-bridge.mjs', 'test:bilibili-bridge'],
])
const sources = {
  'test:bilibili-utils': \`
    export const cropText = async (value) => value
    export const waitForElementToExistAndSelect = async () => globalThis.__BILIBILI_ADAPTER_TEST__.target
  \`,
  'test:bilibili-site-adapters': \`export const config = { bilibili: {} }\`,
  'test:bilibili-capability': \`
    export const isEnhancedVideoSummaryAvailable = () => globalThis.__BILIBILI_ADAPTER_TEST__.enhanced
  \`,
  'test:bilibili-controller': \`
    export const createVideoSummaryAdapterController = (options) => {
      globalThis.__BILIBILI_ADAPTER_TEST__.options = options
      return { async start() { globalThis.__BILIBILI_ADAPTER_TEST__.starts += 1 } }
    }
  \`,
  'test:bilibili-page-mode': \`
    export const resolvePageMode = ({ pageIdentity, pageState, capabilities }) =>
      pageIdentity && pageState.enhancedSupported && capabilities.enhanced
        ? 'enhanced'
        : pageState.legacySupported ? 'legacy' : 'none'
  \`,
  'test:bilibili-host': \`
    export const mountVideoSummaryHost = (options) => {
      let connected = true
      return { ...options, dispose() { connected = false }, isConnected: () => connected }
    }
  \`,
  'test:bilibili-bridge': \`
    export const createBilibiliVideoPageBridge = (options) => {
      const state = globalThis.__BILIBILI_ADAPTER_TEST__
      const bridge = {
        options,
        resolveCurrentPageIdentity: async () => state.identity,
        subscribeToVideoChanges: () => () => {},
      }
      state.bridges.push(bridge)
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
  if (url.startsWith('test:bilibili-')) return { format: 'module', source: sources[url], shortCircuit: true }
  return nextLoad(url, context)
}
`
register(`data:text/javascript,${encodeURIComponent(hookSource)}`)

const originals = new Map()
let adapter

before(async () => {
  for (const name of ['location', 'document', 'window']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  Object.defineProperties(globalThis, {
    location: {
      configurable: true,
      value: { href: 'https://www.bilibili.com/video/BV1test?p=1', pathname: '/video/BV1test' },
    },
    document: {
      configurable: true,
      value: {
        documentElement: {},
        querySelector: (selector) =>
          selector === '#danmukuBox' ? globalThis.__BILIBILI_ADAPTER_TEST__.target : null,
        querySelectorAll: () => [{ remove() {} }],
      },
    },
    window: { configurable: true, value: { setInterval: () => 1, clearInterval() {} } },
  })
  ;({ default: adapter } = await import(
    '../../../src/content-script/site-adapters/bilibili/index.mjs'
  ))
})

beforeEach(() => {
  location.pathname = '/video/BV1test'
  globalThis.__BILIBILI_ADAPTER_TEST__ = {
    enhanced: true,
    identity: { platform: 'bilibili', videoId: 'BV1test', mediaId: '100' },
    target: {},
    starts: 0,
    options: null,
    bridges: [],
  }
})

after(() => {
  delete globalThis.__BILIBILI_ADAPTER_TEST__
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('Bilibili uses one controller whose identity includes BVID and CID', async () => {
  assert.equal(
    await adapter.init(
      'www.bilibili.com',
      {},
      () => {},
      async () => {},
    ),
    false,
  )
  const state = globalThis.__BILIBILI_ADAPTER_TEST__
  assert.equal(state.starts, 1)
  assert.deepEqual(await state.options.getPageIdentity(), state.identity)
  assert.equal(await state.options.resolveMode({ pageIdentity: state.identity }), 'enhanced')

  state.identity = { platform: 'bilibili', videoId: 'BV1test', mediaId: '200' }
  assert.deepEqual(await state.options.getPageIdentity(), state.identity)
  location.pathname = '/bangumi/play/ep1'
  assert.equal(await state.options.resolveMode({ pageIdentity: null }), 'none')
})

test('legacy mode preserves the existing prompt mount', async () => {
  const mounts = []
  globalThis.__BILIBILI_ADAPTER_TEST__.enhanced = false
  await adapter.init(
    'www.bilibili.com',
    {},
    () => {},
    async (...args) => mounts.push(args),
  )
  const options = globalThis.__BILIBILI_ADAPTER_TEST__.options
  const pageIdentity = await options.getPageIdentity()
  assert.equal(await options.resolveMode({ pageIdentity }), 'legacy')
  const handle = await options.mountLegacy({ pageIdentity, pageGeneration: 2, targetElement: {} })
  assert.deepEqual(mounts, [['bilibili', {}]])
  assert.equal(handle.isConnected(), true)
  handle.dispose()
  assert.equal(handle.isConnected(), false)
})
