import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

register('./tests/setup/video-summary-host-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

let dom
let mountVideoSummaryHost
const originals = new Map()
const names = ['window', 'document', 'Node', 'Event', 'MouseEvent', 'HTMLElement', 'Blob']

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/' })
  for (const name of names) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = {
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
  }
  ;({ mountVideoSummaryHost } = await import('../../../src/content-script/video-summary-host.mjs'))
})

after(() => {
  dom.window.close()
  for (const name of names) {
    const descriptor = originals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  delete globalThis.ResizeObserver
  delete globalThis.__VIDEO_SUMMARY_HOST_TEST__
})

function createPort() {
  const messages = []
  const messageListeners = new Set()
  const disconnectListeners = new Set()
  return {
    messages,
    onMessage: {
      addListener: (fn) => messageListeners.add(fn),
      removeListener: (fn) => messageListeners.delete(fn),
    },
    onDisconnect: {
      addListener: (fn) => disconnectListeners.add(fn),
      removeListener: (fn) => disconnectListeners.delete(fn),
    },
    postMessage: (message) => messages.push(message),
    disconnect() {},
  }
}

test('host constructs the Content client from canonical page identity', async () => {
  const identity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
  const port = createPort()
  const target = document.createElement('div')
  document.body.append(target)
  const host = mountVideoSummaryHost({
    platform: 'youtube',
    bridge: {
      getCurrentPageIdentity: () => identity,
      getSnapshot: async () => ({
        pageIdentity: identity,
        nativeSubtitleTracks: [],
        mediaCandidates: [],
      }),
      refreshSnapshot: async () => ({
        pageIdentity: identity,
        nativeSubtitleTracks: [],
        mediaCandidates: [],
      }),
      seekTo() {},
    },
    targetElement: target,
    connect: () => port,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(target.querySelector('.video-summary-host') !== null, true)
  host.dispose()
  assert.equal(target.querySelector('.video-summary-host'), null)
})
