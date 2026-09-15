import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, afterEach, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'

register(
  './tests/setup/content-script-selection-toolbar-loader-hooks.mjs',
  pathToFileURL(cwd() + '/').href,
)

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

let dom
let FloatingToolbar
const originalDescriptors = new Map()
const globalNames = ['window', 'document', 'Node', 'Event', 'MouseEvent', 'HTMLElement']

const defaultConfig = () => ({
  alwaysPinWindow: false,
  themeMode: 'light',
  activeSelectionTools: ['testTool'],
  customSelectionTools: [],
})

const resetState = () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  state.onClose = null
  state.cleanupCount = 0
  state.cleanupSawConnectedContainer = false
  state.container = null
  state.conversationRenderCount = 0
  state.lastQuestion = null
  state.config = defaultConfig()
  state.genPrompt = async () => 'prompt'
  state.deferConfigLoad = false
  state.pendingConfigLoad = null
  state.observeStateUpdates = false
  state.observedStateUpdates = []
}

const createContainer = () => {
  const container = document.createElement('div')
  document.body.append(container)
  globalThis.__FLOATING_TOOLBAR_TEST__.container = container
  return container
}

const mountToolbar = (container) => {
  act(() => {
    render(
      h(FloatingToolbar, {
        session: {},
        selection: 'selected text',
        container,
        triggered: false,
        closeable: true,
        dockable: false,
        prompt: '',
      }),
      container,
    )
  })
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

  await import('react')
  globalThis.__FLOATING_TOOLBAR_TEST__ = {
    toolIcon: h('button', { type: 'button' }),
  }
  resetState()
  ;({ default: FloatingToolbar } = await import(
    '../../../src/components/FloatingToolbar/index.jsx'
  ))
})

afterEach(() => {
  document.body.replaceChildren()
  resetState()
})

after(() => {
  dom.window.close()
  delete globalThis.__FLOATING_TOOLBAR_TEST__

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('the newest async selection-tool result wins when completions arrive out of order', async () => {
  const firstPrompt = deferred()
  const secondPrompt = deferred()
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  let promptCall = 0
  state.genPrompt = () => {
    promptCall += 1
    return promptCall === 1 ? firstPrompt.promise : secondPrompt.promise
  }

  const container = createContainer()
  container.style.left = '17px'
  mountToolbar(container)

  let button = container.querySelector('.chatgptbox-selection-toolbar-button')
  assert.ok(button)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  await nextTask()
  assert.equal(container.style.left, '17px')

  button = container.querySelector('.chatgptbox-selection-toolbar-button')
  assert.ok(button)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(promptCall, 2)

  state.observeStateUpdates = true
  await act(async () => {
    secondPrompt.resolve('second prompt')
    await secondPrompt.promise
    await Promise.resolve()
  })
  state.observeStateUpdates = false

  assert.deepEqual(state.observedStateUpdates, ['second prompt', true])
  assert.equal(state.lastQuestion, 'second prompt')
  const renderCount = state.conversationRenderCount

  state.observedStateUpdates = []
  state.observeStateUpdates = true
  await act(async () => {
    firstPrompt.resolve('stale first prompt')
    await firstPrompt.promise
    await Promise.resolve()
  })
  state.observeStateUpdates = false

  assert.deepEqual(state.observedStateUpdates, [])
  assert.equal(state.lastQuestion, 'second prompt')
  assert.equal(state.conversationRenderCount, renderCount)

  act(() => render(null, container))
})

test('a pending selection-tool result is ignored after unmount', async () => {
  const pendingPrompt = deferred()
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  state.genPrompt = () => pendingPrompt.promise

  const container = createContainer()
  mountToolbar(container)

  const button = container.querySelector('.chatgptbox-selection-toolbar-button')
  assert.ok(button)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  act(() => {
    render(null, container)
  })
  const renderCount = state.conversationRenderCount

  state.observeStateUpdates = true
  await act(async () => {
    pendingPrompt.resolve('late prompt')
    await pendingPrompt.promise
    await Promise.resolve()
  })
  state.observeStateUpdates = false

  assert.deepEqual(state.observedStateUpdates, [])
  assert.equal(state.lastQuestion, null)
  assert.equal(state.conversationRenderCount, renderCount)
})

test('unmount cancels the deferred positioning task before it can touch the container', async () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  state.config = {
    ...defaultConfig(),
    activeSelectionTools: [],
  }

  const container = createContainer()
  container.style.left = '17px'
  mountToolbar(container)

  act(() => {
    render(null, container)
  })

  await nextTask()

  assert.equal(container.style.left, '17px')
})

test('late configuration initialization does nothing after unmount', () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  state.deferConfigLoad = true
  state.config = {
    ...defaultConfig(),
    activeSelectionTools: [],
  }

  const container = createContainer()
  container.style.position = 'relative'
  mountToolbar(container)

  assert.equal(typeof state.pendingConfigLoad, 'function')
  act(() => {
    render(null, container)
  })
  act(() => {
    state.pendingConfigLoad()
  })

  assert.equal(container.style.position, 'relative')
})
