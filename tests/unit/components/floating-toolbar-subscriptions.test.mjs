import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, afterEach, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'

register(
  './tests/setup/floating-toolbar-subscriptions-loader-hooks.mjs',
  pathToFileURL(cwd() + '/').href,
)

let dom
let FloatingToolbar
const originalDescriptors = new Map()
const globalNames = ['window', 'document', 'Node', 'HTMLElement']
const toolbarContainers = new Set()

const getCapture = (options) => (typeof options === 'boolean' ? options : Boolean(options?.capture))

const createListenerTracker = () => {
  const registrations = []
  const matches = (registration, listener, options) =>
    registration.listener === listener && registration.capture === getCapture(options)

  return {
    add(listener, options) {
      if (registrations.some((registration) => matches(registration, listener, options))) return
      registrations.push({ listener, capture: getCapture(options) })
    },
    remove(listener, options) {
      const index = registrations.findIndex((registration) =>
        matches(registration, listener, options),
      )
      if (index !== -1) registrations.splice(index, 1)
    },
    snapshot() {
      return registrations.map((registration) => ({ ...registration }))
    },
    has(target) {
      return registrations.some(
        (registration) =>
          registration.listener === target.listener && registration.capture === target.capture,
      )
    },
    clear() {
      registrations.length = 0
    },
    get size() {
      return registrations.length
    },
  }
}

const resizeListeners = createListenerTracker()
const selectionListeners = createListenerTracker()

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 50; ++attempt) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.fail(message)
}

const sameListenerRegistration = (left, right) =>
  left.listener === right.listener && left.capture === right.capture

const getNewListener = (listeners, previousListeners, label) => {
  const addedListeners = listeners
    .snapshot()
    .filter(
      (listener) =>
        !previousListeners.some((previousListener) =>
          sameListenerRegistration(listener, previousListener),
        ),
    )
  assert.equal(addedListeners.length, 1, `expected one new ${label} listener`)
  return addedListeners[0]
}

const getNewSetEntry = (entries, previousEntries, label) => {
  const addedEntries = [...entries].filter((entry) => !previousEntries.has(entry))
  assert.equal(addedEntries.length, 1, `expected one new ${label} listener`)
  return addedEntries[0]
}

const createToolbar = async (id) => {
  const state = globalThis.__FLOATING_SUBSCRIPTION_TEST__
  const previousResizeListeners = resizeListeners.snapshot()
  const previousSelectionListeners = selectionListeners.snapshot()
  const previousStorageListeners = new Set(state.storageListeners)
  const container = document.createElement('div')
  document.body.append(container)
  toolbarContainers.add(container)

  await act(async () => {
    render(
      h(FloatingToolbar, {
        session: { id },
        selection: 'selected text',
        container,
        triggered: true,
        closeable: true,
        dockable: false,
        prompt: 'prompt',
      }),
      container,
    )
    await Promise.resolve()
    await Promise.resolve()
  })

  const getCloseCallback = () => globalThis.__FLOATING_SUBSCRIPTION_TEST__.onCloseBySession.get(id)
  await waitFor(
    () => typeof getCloseCallback() === 'function',
    `close callback was not rendered for ${id}`,
  )

  const onClose = getCloseCallback()
  return {
    container,
    listeners: {
      resize: getNewListener(resizeListeners, previousResizeListeners, 'resize'),
      selection: getNewListener(selectionListeners, previousSelectionListeners, 'selection'),
      storage: getNewSetEntry(state.storageListeners, previousStorageListeners, 'storage'),
    },
    close: () => {
      onClose()
    },
  }
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/' })

  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    })
  }

  const originalWindowAddEventListener = window.addEventListener.bind(window)
  const originalWindowRemoveEventListener = window.removeEventListener.bind(window)
  window.addEventListener = (type, listener, options) => {
    if (type === 'resize') resizeListeners.add(listener, options)
    return originalWindowAddEventListener(type, listener, options)
  }
  window.removeEventListener = (type, listener, options) => {
    if (type === 'resize') resizeListeners.remove(listener, options)
    return originalWindowRemoveEventListener(type, listener, options)
  }

  const originalDocumentAddEventListener = document.addEventListener.bind(document)
  const originalDocumentRemoveEventListener = document.removeEventListener.bind(document)
  document.addEventListener = (type, listener, options) => {
    if (type === 'selectionchange') selectionListeners.add(listener, options)
    return originalDocumentAddEventListener(type, listener, options)
  }
  document.removeEventListener = (type, listener, options) => {
    if (type === 'selectionchange') selectionListeners.remove(listener, options)
    return originalDocumentRemoveEventListener(type, listener, options)
  }

  globalThis.__FLOATING_SUBSCRIPTION_TEST__ = {
    onCloseBySession: new Map(),
    storageListeners: new Set(),
  }
  ;({ default: FloatingToolbar } = await import(
    '../../../src/components/FloatingToolbar/index.jsx'
  ))
})

afterEach(() => {
  act(() => {
    for (const container of toolbarContainers) render(null, container)
  })
  for (const container of toolbarContainers) container.remove()
  toolbarContainers.clear()
  document.body.replaceChildren()
  resizeListeners.clear()
  selectionListeners.clear()
  globalThis.__FLOATING_SUBSCRIPTION_TEST__.onCloseBySession.clear()
  globalThis.__FLOATING_SUBSCRIPTION_TEST__.storageListeners.clear()
})

after(() => {
  dom.window.close()
  delete globalThis.__FLOATING_SUBSCRIPTION_TEST__

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('listener tracking keeps registrations when capture does not match', () => {
  const listener = () => {}
  window.addEventListener('resize', listener, { capture: true })
  try {
    window.removeEventListener('resize', listener, { capture: false })
    assert.equal(resizeListeners.size, 1)
  } finally {
    window.removeEventListener('resize', listener, { capture: true })
  }

  assert.equal(resizeListeners.size, 0)
})

test('closing a floating toolbar removes its real hook subscriptions', async () => {
  const state = globalThis.__FLOATING_SUBSCRIPTION_TEST__
  const toolbar = await createToolbar('one')

  assert.equal(resizeListeners.size, 1)
  assert.equal(selectionListeners.size, 1)
  assert.equal(state.storageListeners.size, 1)
  assert.equal(toolbar.listeners.resize.capture, false)
  assert.equal(toolbar.listeners.selection.capture, false)

  act(() => toolbar.close())

  assert.equal(toolbar.container.isConnected, false)
  assert.equal(resizeListeners.size, 0)
  assert.equal(selectionListeners.size, 0)
  assert.equal(state.storageListeners.size, 0)
})

test('closing one toolbar leaves another toolbar subscriptions active', async () => {
  const state = globalThis.__FLOATING_SUBSCRIPTION_TEST__
  const first = await createToolbar('first')
  const second = await createToolbar('second')

  assert.equal(resizeListeners.size, 2)
  assert.equal(selectionListeners.size, 2)
  assert.equal(state.storageListeners.size, 2)

  act(() => first.close())

  assert.equal(first.container.isConnected, false)
  assert.equal(second.container.isConnected, true)
  assert.equal(resizeListeners.has(first.listeners.resize), false)
  assert.equal(selectionListeners.has(first.listeners.selection), false)
  assert.equal(state.storageListeners.has(first.listeners.storage), false)
  assert.equal(resizeListeners.has(second.listeners.resize), true)
  assert.equal(selectionListeners.has(second.listeners.selection), true)
  assert.equal(state.storageListeners.has(second.listeners.storage), true)

  act(() => second.close())

  assert.equal(resizeListeners.size, 0)
  assert.equal(selectionListeners.size, 0)
  assert.equal(state.storageListeners.size, 0)
})
