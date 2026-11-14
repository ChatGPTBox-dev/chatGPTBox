import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { useLayoutEffect } from 'preact/hooks'

register(
  './tests/setup/content-script-selection-toolbar-loader-hooks.mjs',
  pathToFileURL(cwd() + '/').href,
)

const baseConfig = {
  alwaysFloatingSidebar: false,
  inputQuery: '',
  prependQuery: '',
  appendQuery: '',
  selectionToolsNextToInputBox: false,
  useSiteRegexOnly: true,
  siteRegex: '',
  siteAdapters: [],
  activeSiteAdapters: [],
  activeApiModes: [],
  customApiModes: [],
  modelName: 'test-model',
  apiMode: 'test-mode',
  customModelName: '',
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 50; ++attempt) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(message)
}

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const dispatchTouchEvent = (type, pageX = 20, pageY = 20) => {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'changedTouches', {
    value: [{ pageX, pageY }],
  })
  document.body.dispatchEvent(event)
}

const mountCleanupProbe = (container) => {
  const cleanup = {
    count: 0,
    sawConnectedContainer: false,
  }

  function CleanupProbe() {
    useLayoutEffect(
      () => () => {
        cleanup.count += 1
        cleanup.sawConnectedContainer = container.isConnected
      },
      [],
    )
    return null
  }

  render(h(CleanupProbe), container)
  return cleanup
}

let dom
let FloatingToolbar
let selectionText = 'selected text'
const globalDescriptors = new Map()
const globalNames = ['window', 'document', 'location', 'Node', 'Event', 'MouseEvent', 'HTMLElement']

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/' })

  for (const name of globalNames) {
    globalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    })
  }

  globalThis.__SELECTION_TOOLBAR_TEST__ = {
    createdContainers: [],
    renderCount: 0,
    getUserConfig: async () => baseConfig,
  }
  globalThis.__FLOATING_TOOLBAR_TEST__ = {
    onClose: null,
    cleanupCount: 0,
    cleanupSawConnectedContainer: false,
    container: null,
  }

  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => ({
      rangeCount: 0,
      toString: () => selectionText,
    }),
  })

  await import('../../../src/content-script/index.jsx')
  ;({ default: FloatingToolbar } = await import(
    '../../../src/components/FloatingToolbar/index.jsx'
  ))
  await nextTask()
  await nextTask()
})

after(() => {
  dom.window.close()
  delete globalThis.__SELECTION_TOOLBAR_TEST__
  delete globalThis.__FLOATING_TOOLBAR_TEST__

  for (const [name, descriptor] of globalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('outside interaction unmounts a toolbar before removing its container', () => {
  const container = document.createElement('div')
  container.className = 'chatgptbox-toolbar-container'
  document.documentElement.append(container)
  const cleanup = mountCleanupProbe(container)

  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

  assert.equal(cleanup.count, 1)
  assert.equal(cleanup.sawConnectedContainer, true)
  assert.equal(container.isConnected, false)
})

test('tracked toolbar deletion unmounts before removing its container', async () => {
  const createdBefore = globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.length
  const renderedBefore = globalThis.__SELECTION_TOOLBAR_TEST__.renderCount

  selectionText = 'selected text'
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await waitFor(
    () =>
      globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.length === createdBefore + 1 &&
      globalThis.__SELECTION_TOOLBAR_TEST__.renderCount === renderedBefore + 1,
    'tracked selection toolbar was not rendered',
  )

  const container = globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.at(-1)
  const cleanup = mountCleanupProbe(container)

  selectionText = ''
  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

  assert.equal(cleanup.count, 1)
  assert.equal(cleanup.sawConnectedContainer, true)
  assert.equal(container.isConnected, false)

  await nextTask()
  selectionText = 'selected text'
})

test('toolbar close unmounts its component tree before removing the container', async () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  const container = document.createElement('div')
  container.className = 'chatgptbox-toolbar-container'
  document.documentElement.append(container)

  state.onClose = null
  state.cleanupCount = 0
  state.cleanupSawConnectedContainer = false
  state.container = container

  render(
    h(FloatingToolbar, {
      session: {},
      selection: 'selected text',
      container,
      triggered: true,
      closeable: true,
      dockable: false,
      prompt: 'prompt',
    }),
    container,
  )

  await waitFor(
    () => typeof state.onClose === 'function',
    'toolbar close callback was not rendered',
  )
  state.onClose()

  assert.equal(state.cleanupCount, 1)
  assert.equal(state.cleanupSawConnectedContainer, true)
  assert.equal(container.isConnected, false)
})

test('cancelling while the first mouse config read is pending prevents container creation', async () => {
  const pendingConfig = deferred()
  const createdBefore = globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.length
  const renderedBefore = globalThis.__SELECTION_TOOLBAR_TEST__.renderCount

  globalThis.__SELECTION_TOOLBAR_TEST__.getUserConfig = () => pendingConfig.promise

  document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await nextTask()
  await nextTask()

  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  pendingConfig.resolve(baseConfig)
  await nextTask()
  await nextTask()

  assert.equal(globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.length, createdBefore)
  assert.equal(globalThis.__SELECTION_TOOLBAR_TEST__.renderCount, renderedBefore)
  globalThis.__SELECTION_TOOLBAR_TEST__.getUserConfig = async () => baseConfig
})

test('mouse positioning and rendering share one fresh settings snapshot', async (t) => {
  const state = globalThis.__SELECTION_TOOLBAR_TEST__
  const renderedBefore = state.renderCount
  const originalGet = state.getUserConfig
  const originalSelection = window.getSelection
  const input = document.createElement('input')
  document.body.append(input)
  Object.defineProperty(input, 'offsetWidth', { value: 123 })
  input.focus()
  window.getSelection = () => ({
    rangeCount: 1,
    toString: () => 'selected text',
    getRangeAt: () => ({ endContainer: { parentElement: document.body } }),
  })
  const reads = []
  state.getUserConfig = async (options) => {
    reads.push(options)
    return options?.fresh ? { ...baseConfig, selectionToolsNextToInputBox: true } : baseConfig
  }
  t.after(() => {
    state.getUserConfig = originalGet
    window.getSelection = originalSelection
    input.remove()
  })

  document.body.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 34 }),
  )
  await waitFor(
    () => state.renderCount === renderedBefore + 1,
    'selection toolbar was not rendered',
  )

  const container = state.createdContainers.at(-1)
  assert.equal(container.style.left, '173px')
  assert.equal(container.style.top, '64px')
  assert.deepEqual(reads, [{ fresh: true }])
})

test('touchstart unmounts a toolbar before removing its container', () => {
  const container = document.createElement('div')
  container.className = 'chatgptbox-toolbar-container'
  document.documentElement.append(container)
  const cleanup = mountCleanupProbe(container)

  dispatchTouchEvent('touchstart')

  assert.equal(cleanup.count, 1)
  assert.equal(cleanup.sawConnectedContainer, true)
  assert.equal(container.isConnected, false)
})

test('touchstart cancels touch toolbar rendering while config is pending', async () => {
  const pendingConfig = deferred()
  const createdBefore = globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.length
  const renderedBefore = globalThis.__SELECTION_TOOLBAR_TEST__.renderCount

  globalThis.__SELECTION_TOOLBAR_TEST__.getUserConfig = () => pendingConfig.promise

  dispatchTouchEvent('touchend')
  await waitFor(
    () => globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.length === createdBefore + 1,
    'touch selection toolbar container was not created',
  )

  const container = globalThis.__SELECTION_TOOLBAR_TEST__.createdContainers.at(-1)
  assert.equal(container.isConnected, true)

  dispatchTouchEvent('touchstart')
  assert.equal(container.isConnected, false)

  pendingConfig.resolve(baseConfig)
  await nextTask()
  await nextTask()

  assert.equal(globalThis.__SELECTION_TOOLBAR_TEST__.renderCount, renderedBefore)
  globalThis.__SELECTION_TOOLBAR_TEST__.getUserConfig = async () => baseConfig
})
