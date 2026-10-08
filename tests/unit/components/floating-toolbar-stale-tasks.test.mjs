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
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

let dom
let FloatingToolbar
let RealDraggableCore
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
  state.onUpdate = null
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
  state.dragHandlers = null
  state.dragPosition = null
  state.draggableCoreStopCount = 0
  state.nextClampedPosition = null
  state.positionUpdates = []
  state.resizeObservers = []
  state.windowSize = [1000, 1000]
}

const createContainer = () => {
  const container = document.createElement('div')
  document.body.append(container)
  globalThis.__FLOATING_TOOLBAR_TEST__.container = container
  return container
}

const mountToolbar = (container, overrides = {}) => {
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
        ...overrides,
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
  const draggableModule = await import('react-draggable')
  RealDraggableCore = draggableModule.DraggableCore ?? draggableModule.default?.DraggableCore
  assert.ok(RealDraggableCore)
  globalThis.__FLOATING_TOOLBAR_TEST__ = {
    toolIcon: h('button', { type: 'button' }),
  }
  resetState()
  Object.defineProperty(dom.window, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        globalThis.__FLOATING_TOOLBAR_TEST__.resizeObservers.push(this)
      }

      observe(target) {
        this.target = target
      }

      disconnect() {
        this.disconnected = true
      }
    },
  })
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

test('a current selection-tool prompt failure is contained and the toolbar remains usable', async () => {
  const failedPrompt = deferred()
  const retryPrompt = deferred()
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  let promptCall = 0
  state.genPrompt = () => {
    promptCall += 1
    return promptCall === 1 ? failedPrompt.promise : retryPrompt.promise
  }

  const container = createContainer()
  mountToolbar(container)

  const button = container.querySelector('.chatgptbox-selection-toolbar-button')
  assert.ok(button)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  const failure = new Error('prompt generation failed')
  const errors = []
  const originalConsoleError = console.error
  console.error = (...args) => errors.push(args)

  try {
    state.observeStateUpdates = true
    failedPrompt.reject(failure)
    await failedPrompt.promise.catch(() => {})
    await nextTask()
    state.observeStateUpdates = false

    assert.deepEqual(state.observedStateUpdates, [])
    assert.equal(state.lastQuestion, null)
    assert.equal(state.conversationRenderCount, 0)
    assert.ok(container.querySelector('.chatgptbox-selection-toolbar-button'))
    assert.equal(errors.length, 1)
    assert.equal(errors[0][0], '[FloatingToolbar] Failed to generate selection tool prompt:')
    assert.equal(errors[0][1], failure)

    state.observedStateUpdates = []
    const retryButton = container.querySelector('.chatgptbox-selection-toolbar-button')
    assert.ok(retryButton)
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    assert.equal(promptCall, 2)

    state.observeStateUpdates = true
    await act(async () => {
      retryPrompt.resolve('retry prompt')
      await retryPrompt.promise
      await Promise.resolve()
    })
    state.observeStateUpdates = false

    assert.deepEqual(state.observedStateUpdates, ['retry prompt', true])
    assert.equal(state.lastQuestion, 'retry prompt')
    assert.equal(errors.length, 1)
  } finally {
    state.observeStateUpdates = false
    console.error = originalConsoleError
  }

  act(() => render(null, container))
})

test('a stale selection-tool prompt failure is contained without affecting the newest result', async () => {
  const firstPrompt = deferred()
  const secondPrompt = deferred()
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  let promptCall = 0
  state.genPrompt = () => {
    promptCall += 1
    return promptCall === 1 ? firstPrompt.promise : secondPrompt.promise
  }

  const container = createContainer()
  mountToolbar(container)

  let button = container.querySelector('.chatgptbox-selection-toolbar-button')
  assert.ok(button)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  button = container.querySelector('.chatgptbox-selection-toolbar-button')
  assert.ok(button)
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(promptCall, 2)

  const errors = []
  const originalConsoleError = console.error
  console.error = (...args) => errors.push(args)

  try {
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
    const staleFailure = new Error('stale prompt generation failed')
    state.observeStateUpdates = true
    firstPrompt.reject(staleFailure)
    await firstPrompt.promise.catch(() => {})
    await nextTask()
    state.observeStateUpdates = false

    assert.deepEqual(state.observedStateUpdates, [])
    assert.equal(state.lastQuestion, 'second prompt')
    assert.equal(state.conversationRenderCount, renderCount)
    assert.deepEqual(errors, [])
  } finally {
    state.observeStateUpdates = false
    console.error = originalConsoleError
  }

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

test('real react-draggable stops when onDrag returns false', () => {
  const container = createContainer()
  let dragCount = 0
  let stopCount = 0

  act(() => {
    render(
      h(
        RealDraggableCore,
        {
          onDrag: () => {
            dragCount += 1
            return false
          },
          onStop: () => {
            stopCount += 1
          },
        },
        h('div', { className: 'real-drag-target' }),
      ),
      container,
    )
  })

  const target = container.querySelector('.real-drag-target')
  assert.ok(target)

  act(() => {
    target.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 10,
        clientY: 10,
      }),
    )
  })
  act(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 15,
        clientY: 10,
      }),
    )
  })

  assert.equal(dragCount, 1)
  assert.equal(stopCount, 1)

  act(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 20,
        clientY: 10,
      }),
    )
  })
  assert.equal(dragCount, 1)

  act(() => {
    render(null, container)
  })
})

test('real react-draggable handleDragStop cleans up a canceled touch drag', () => {
  const container = createContainer()
  let draggableCore = null

  act(() => {
    render(
      h(
        RealDraggableCore,
        {
          ref: (instance) => {
            draggableCore = instance
          },
        },
        h('div', { className: 'real-touch-drag-target' }),
      ),
      container,
    )
  })

  const target = container.querySelector('.real-touch-drag-target')
  assert.ok(target)
  assert.ok(draggableCore)

  const touch = { identifier: 1, clientX: 10, clientY: 10 }
  const touchStart = new Event('touchstart', { bubbles: true, cancelable: true })
  Object.defineProperty(touchStart, 'targetTouches', { value: [touch] })
  Object.defineProperty(touchStart, 'changedTouches', { value: [touch] })

  act(() => {
    target.dispatchEvent(touchStart)
  })
  assert.equal(document.body.classList.contains('react-draggable-transparent-selection'), true)

  const touchCancel = new Event('touchcancel', { cancelable: true })
  Object.defineProperty(touchCancel, 'targetTouches', { value: [] })
  Object.defineProperty(touchCancel, 'changedTouches', { value: [touch] })
  Object.defineProperty(touchCancel, 'touches', { value: [] })

  act(() => {
    draggableCore.handleDragStop(touchCancel)
  })
  assert.equal(document.body.classList.contains('react-draggable-transparent-selection'), false)

  act(() => {
    render(null, container)
  })
})

test('lost drag termination recovers clamping without waiting for onStop', async () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  const container = createContainer()
  mountToolbar(container, { selection: '', triggered: true })
  await nextTask()

  const observer = state.resizeObservers.at(-1)
  assert.ok(observer)

  act(() => {
    state.dragHandlers.onStart()
  })
  act(() => {
    state.dragHandlers.onDrag(new MouseEvent('mousemove', { buttons: 1 }), {
      deltaX: 12,
      deltaY: 0,
    })
  })
  assert.deepEqual(state.dragPosition, { x: 12, y: 0 })

  act(() => {
    window.dispatchEvent(new Event('blur'))
  })
  assert.deepEqual(state.dragPosition, { x: 0, y: 0 })
  assert.equal(state.draggableCoreStopCount, 1)

  state.positionUpdates = []
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.at(-1).x, 12)

  act(() => {
    state.dragHandlers.onStart()
  })
  act(() => {
    state.dragHandlers.onDrag(new MouseEvent('mousemove', { buttons: 1 }), {
      deltaX: 7,
      deltaY: 0,
    })
  })
  assert.deepEqual(state.dragPosition, { x: 7, y: 0 })

  let result
  act(() => {
    result = state.dragHandlers.onDrag(new MouseEvent('mousemove', { buttons: 0 }), {
      deltaX: 0,
      deltaY: 0,
    })
  })
  assert.equal(result, false)
  assert.deepEqual(state.dragPosition, { x: 0, y: 0 })

  state.positionUpdates = []
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.at(-1).x, 19)

  act(() => {
    state.dragHandlers.onStop()
  })
  state.positionUpdates = []
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.at(-1).x, 19)

  act(() => {
    render(null, container)
  })
})

test('touchcancel only finalizes the active touch drag', async () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  const container = createContainer()
  mountToolbar(container, { selection: '', triggered: true })
  await nextTask()

  const observer = state.resizeObservers.at(-1)
  assert.ok(observer)

  const dragTouch = { identifier: 1, clientX: 10, clientY: 10 }
  const touchStart = new Event('touchstart', { bubbles: true, cancelable: true })
  Object.defineProperty(touchStart, 'targetTouches', { value: [dragTouch] })
  Object.defineProperty(touchStart, 'changedTouches', { value: [dragTouch] })

  act(() => {
    state.dragHandlers.onStart(touchStart)
  })
  act(() => {
    state.dragHandlers.onDrag(touchStart, { deltaX: 9, deltaY: 0 })
  })
  assert.deepEqual(state.dragPosition, { x: 9, y: 0 })

  act(() => {
    const otherTouch = { identifier: 2, clientX: 20, clientY: 20 }
    const otherTouchCancel = new Event('touchcancel', { bubbles: true })
    Object.defineProperty(otherTouchCancel, 'targetTouches', { value: [dragTouch] })
    Object.defineProperty(otherTouchCancel, 'changedTouches', { value: [otherTouch] })
    Object.defineProperty(otherTouchCancel, 'touches', { value: [dragTouch] })
    container.ownerDocument.dispatchEvent(otherTouchCancel)
  })

  assert.deepEqual(state.dragPosition, { x: 9, y: 0 })
  assert.equal(state.draggableCoreStopCount, 0)

  state.positionUpdates = []
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.length, 0)

  act(() => {
    const touchCancel = new Event('touchcancel', { bubbles: true })
    Object.defineProperty(touchCancel, 'targetTouches', { value: [] })
    Object.defineProperty(touchCancel, 'changedTouches', { value: [dragTouch] })
    Object.defineProperty(touchCancel, 'touches', { value: [] })
    container.ownerDocument.dispatchEvent(touchCancel)
  })

  assert.deepEqual(state.dragPosition, { x: 0, y: 0 })
  assert.equal(state.draggableCoreStopCount, 1)

  state.positionUpdates = []
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.at(-1).x, 9)

  act(() => {
    state.dragHandlers.onStop()
  })
  state.positionUpdates = []
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.at(-1).x, 9)

  act(() => {
    render(null, container)
  })
})

test('viewport resize re-clamps even when the clamped window size is unchanged', async () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  const container = createContainer()
  mountToolbar(container, { selection: '', triggered: true })
  await nextTask()

  state.positionUpdates = []
  state.nextClampedPosition = { x: 0, y: 80 }
  act(() => {
    state.windowSize = [1000, 1000]
    window.dispatchEvent(new Event('resize'))
  })

  assert.ok(state.positionUpdates.length >= 1)
  assert.equal(container.style.top, '80px')

  act(() => {
    render(null, container)
  })
})

test('conversation resize re-clamps the window without fighting active dragging', async () => {
  const state = globalThis.__FLOATING_TOOLBAR_TEST__
  const container = createContainer()
  mountToolbar(container, { selection: '', triggered: true })
  await nextTask()

  const observer = state.resizeObservers.at(-1)
  assert.ok(observer)
  assert.equal(observer.target, container)

  state.positionUpdates = []
  state.nextClampedPosition = { x: 0, y: 120 }
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.ok(state.positionUpdates.length >= 1)
  assert.equal(container.style.top, '120px')

  state.positionUpdates = []
  act(() => {
    state.dragHandlers.onStart()
  })
  act(() => {
    state.onUpdate()
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.length, 0)

  act(() => {
    state.dragHandlers.onDrag(null, { deltaX: 0, deltaY: 10 })
  })
  act(() => {
    state.dragHandlers.onDrag(null, { deltaX: 0, deltaY: -10 })
  })
  assert.deepEqual(state.dragPosition, { x: 0, y: 0 })
  act(() => {
    observer.callback([{ target: container }])
  })
  assert.equal(state.positionUpdates.length, 0)

  act(() => {
    state.dragHandlers.onStop()
  })
  state.positionUpdates = []
  act(() => {
    state.onUpdate()
    observer.callback([{ target: container }])
  })
  assert.ok(state.positionUpdates.length >= 1)

  act(() => {
    render(null, container)
  })
  assert.equal(observer.disconnected, true)
})
