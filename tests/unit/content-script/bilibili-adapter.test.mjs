import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, before, beforeEach, test } from 'node:test'

const hookSource = `
const stubs = new Map([
  ['../../../utils', 'test:bilibili-utils'],
  ['../index.mjs', 'test:bilibili-site-adapters'],
  ['../../../video-summary/capabilities.mjs', 'test:bilibili-capabilities'],
  ['./video-page-bridge.mjs', 'test:bilibili-bridge'],
  ['./video-summary-host.mjs', 'test:bilibili-legacy-host'],
  ['../../video-summary-host.mjs', 'test:bilibili-shared-host'],
])
const sources = {
  'test:bilibili-utils': \`
    export const cropText = async (value) => value
    export const waitForElementToExistAndSelect = async () => true
  \`,
  'test:bilibili-site-adapters': \`export const config = { bilibili: {} }\`,
  'test:bilibili-capabilities': \`
    export const isVideoSummaryEnabled = (config) =>
      globalThis.__BILIBILI_ADAPTER_TEST__.capabilitySupported &&
      config?.videoTranscriptionEnabled === true
    export const isBilibiliVideoTranscriptionEnabled = isVideoSummaryEnabled
  \`,
  'test:bilibili-bridge': \`
    export const createBilibiliVideoPageBridge = (options) => {
      const bridge = { options }
      globalThis.__BILIBILI_ADAPTER_TEST__.bridges.push(bridge)
      return bridge
    }
  \`,
  'test:bilibili-legacy-host': \`
    export const mountBilibiliVideoSummaryHost = (options) => {
      globalThis.__BILIBILI_ADAPTER_TEST__.legacyMounts.push(options)
      return { dispose() {} }
    }
  \`,
  'test:bilibili-shared-host': \`
    export const mountVideoSummaryHost = (options) => {
      globalThis.__BILIBILI_ADAPTER_TEST__.sharedMounts.push(options)
      return { dispose() {} }
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
let targetElement

before(async () => {
  for (const name of globals) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }

  targetElement = {}
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
        body: { contains: () => true },
        querySelector: (selector) => (selector === '#danmukuBox' ? targetElement : {}),
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
  globalThis.__BILIBILI_ADAPTER_TEST__ = {
    capabilitySupported: true,
    bridges: [],
    sharedMounts: [],
    legacyMounts: [],
  }
})

after(() => {
  delete globalThis.__BILIBILI_ADAPTER_TEST__
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('enhanced mode mounts the shared Bilibili host and bypasses the legacy path', async () => {
  let legacyMountCount = 0

  const result = await adapter.init(
    'www.bilibili.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {
      legacyMountCount += 1
    },
  )

  assert.equal(result, false)
  assert.equal(globalThis.__BILIBILI_ADAPTER_TEST__.sharedMounts.length, 1)
  assert.equal(globalThis.__BILIBILI_ADAPTER_TEST__.legacyMounts.length, 0)
  assert.equal(legacyMountCount, 0)
  assert.deepEqual(globalThis.__BILIBILI_ADAPTER_TEST__.sharedMounts[0], {
    platform: 'bilibili',
    bridge: globalThis.__BILIBILI_ADAPTER_TEST__.bridges[0],
    targetElement,
  })
})

test('disabled mode preserves the legacy adapter path', async () => {
  const result = await adapter.init(
    'www.bilibili.com',
    { videoTranscriptionEnabled: false },
    () => {},
    () => {},
  )

  assert.equal(result, true)
  assert.equal(globalThis.__BILIBILI_ADAPTER_TEST__.sharedMounts.length, 0)
})

test('unsupported mode preserves the legacy adapter path', async () => {
  globalThis.__BILIBILI_ADAPTER_TEST__.capabilitySupported = false

  const result = await adapter.init(
    'www.bilibili.com',
    { videoTranscriptionEnabled: true },
    () => {},
    () => {},
  )

  assert.equal(result, true)
  assert.equal(globalThis.__BILIBILI_ADAPTER_TEST__.sharedMounts.length, 0)
})
