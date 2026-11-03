import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, afterEach, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'

register(
  './tests/setup/conversation-card-lifecycle-loader-hooks.mjs',
  pathToFileURL(cwd() + '/').href,
)

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const createEvent = () => {
  const listeners = new Set()
  return {
    addListener(listener) {
      listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    trigger(...args) {
      for (const listener of Array.from(listeners)) listener(...args)
    },
    clear() {
      listeners.clear()
    },
    size() {
      return listeners.size
    },
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 50; ++attempt) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(message)
}

let dom
let ConversationCard
let originalScrollToDescriptor
const originalDescriptors = new Map()
const globalNames = ['window', 'document', 'Node', 'HTMLElement', 'Event', 'MouseEvent', 'Blob']
const mountedContainers = new Set()

const defaultConfig = () => ({
  lockWhenAnswer: false,
  answerScrollMargin: 0,
  activeApiModes: [],
  customApiModes: [],
  azureDeploymentName: '',
  ollamaModelName: '',
  customOpenAIProviders: [],
  customModelName: '',
  autoRegenAfterSwitchModel: false,
  disableWebModeHistory: true,
})

const baseSession = () => ({
  conversationRecords: [],
  modelName: 'test-model',
  apiMode: null,
  question: null,
})

const geminiContinuationSession = () => ({
  conversationRecords: [{ question: 'Q1', answer: 'A1' }],
  modelName: 'bardWebFree',
  apiMode: { groupName: 'bardWebModelKeys', itemName: 'bardWebFree' },
  question: null,
  geminiWeb_conversation: {
    c: 'c-old',
    r: 'r-old',
    rc: 'rc-old',
    accountPath: '',
  },
})

const createRuntimePort = () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const onMessage = createEvent()
  const onDisconnect = createEvent()
  let disconnected = false
  let disconnectCount = 0
  const postedMessages = []
  const port = {
    onMessage,
    onDisconnect,
    postedMessages,
    postMessage(message) {
      postedMessages.push(message)
    },
    disconnect() {
      disconnectCount += 1
      if (disconnected) return
      disconnected = true
    },
    emitRemoteDisconnect() {
      if (disconnected) return
      disconnected = true
      onDisconnect.trigger()
    },
    get disconnectCount() {
      return disconnectCount
    },
    get disconnected() {
      return disconnected
    },
  }
  state.ports.push(port)
  return port
}

const resetState = () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  state.foreground = false
  state.isFirefox = false
  state.isMobile = false
  state.isSafari = false
  state.windowSize = [1000, 1000]
  state.config = defaultConfig()
  state.ports = []
  state.inputBoxProps = null
  state.conversationItemProps = null
  state.deleteButtonProps = null
  state.configReadCount = 0
  state.getUserConfig = async () => {
    state.configReadCount += 1
    return { bingAccessToken: 'token', allowEscToCloseAll: false }
  }
  state.generateAnswersCount = 0
  state.generateAnswers = async () => {
    state.generateAnswersCount += 1
  }
  state.runtimeOnMessage.clear()
}

const mountCard = (container, props = {}) => {
  mountedContainers.add(container)
  act(() => {
    render(
      h(ConversationCard, {
        session: baseSession(),
        ...props,
      }),
      container,
    )
  })
}

const withDynamicViewportSupport = (supported, callback) => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'CSS')
  Object.defineProperty(window, 'CSS', {
    configurable: true,
    value: {
      supports: (property, value) => supported && property === 'max-height' && value === '100dvh',
    },
  })
  try {
    return callback()
  } finally {
    if (descriptor) Object.defineProperty(window, 'CSS', descriptor)
    else delete window.CSS
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

  originalScrollToDescriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    'scrollTo',
  )
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value() {},
  })

  globalThis.__CONVERSATION_LIFECYCLE_TEST__ = {
    runtimeOnMessage: createEvent(),
    createPort: createRuntimePort,
  }
  resetState()
  ;({ default: ConversationCard } = await import(
    '../../../src/components/ConversationCard/index.jsx'
  ))
})

afterEach(() => {
  act(() => {
    for (const container of mountedContainers) render(null, container)
  })
  for (const container of mountedContainers) container.remove()
  mountedContainers.clear()
  document.body.replaceChildren()
  resetState()
})

after(() => {
  if (originalScrollToDescriptor) {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', originalScrollToDescriptor)
  } else {
    delete dom.window.HTMLElement.prototype.scrollTo
  }
  dom.window.close()
  delete globalThis.__CONVERSATION_LIFECYCLE_TEST__

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('floating conversation caps its height and lets the body shrink in a short viewport', () => {
  withDynamicViewportSupport(false, () => {
    const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
    const container = document.createElement('div')
    container.style.width = '300px'
    document.body.append(container)
    state.isFirefox = true
    state.windowSize = [600, 350]

    mountCard(container, { draggable: true, closeable: true })

    const inner = container.querySelector('.gpt-inner')
    const header = container.querySelector('.gpt-header')
    const body = container.querySelector('.markdown-body')
    const dragHandle = container.querySelector('.draggable')
    assert.ok(inner)
    assert.ok(header)
    assert.ok(body)
    assert.ok(dragHandle)

    assert.equal(inner.style.maxHeight, '100vh')
    assert.equal(inner.style.boxSizing, 'border-box')
    assert.equal(header.style.flexWrap, 'wrap')
    assert.equal(dragHandle.style.flex, '0 0 24px')
    assert.equal(Number.parseFloat(body.style.maxHeight), state.windowSize[1] * 0.55)
    assert.equal(Number.parseFloat(body.style.minHeight), 0)
    assert.equal(body.style.flexShrink, '1')
  })
})

test('floating mobile conversation prefers the dynamic viewport height when supported', () => {
  withDynamicViewportSupport(true, () => {
    const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
    const container = document.createElement('div')
    document.body.append(container)
    state.isMobile = true

    mountCard(container, { draggable: true, closeable: true })

    const inner = container.querySelector('.gpt-inner')
    const dragHandle = container.querySelector('.draggable')
    assert.ok(inner)
    assert.ok(dragHandle)

    assert.equal(inner.style.maxHeight, '100dvh')
    assert.equal(inner.style.boxSizing, 'border-box')
    assert.equal(dragHandle.style.flex, '0 0 44px')
  })
})

test('independent conversation page keeps its existing unconstrained height behavior', () => {
  const container = document.createElement('div')
  document.body.append(container)

  mountCard(container, { draggable: true, notClampSize: true, pageMode: true })

  const inner = container.querySelector('.gpt-inner')
  const body = container.querySelector('.markdown-body')
  assert.ok(inner)
  assert.ok(body)

  assert.equal(inner.style.maxHeight, '')
  assert.equal(inner.style.boxSizing, '')
  assert.equal(body.style.maxHeight, '')
  assert.equal(body.style.flexGrow, '1')
  assert.equal(Number.parseFloat(body.style.minHeight), 0)
})

test('unmount disconnects the owned runtime Port without reconnecting', () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)

  mountCard(container)
  assert.equal(state.ports.length, 1)
  const port = state.ports[0]
  assert.equal(port.onDisconnect.size(), 1)

  act(() => render(null, container))

  assert.equal(port.disconnectCount, 1)
  assert.equal(port.disconnected, true)
  assert.equal(port.onDisconnect.size(), 0)
  assert.equal(state.ports.length, 1)
})

test('unmount after a submitted Gemini continuation persists unsafe state', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let persistedSession

  mountCard(container, {
    session: geminiContinuationSession(),
    onUpdate: (_port, session) => {
      if (session.geminiWeb_conversationUnsafe === true) persistedSession = session
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('Q2')
  await nextTask()
  act(() => {
    state.ports[0].onMessage.trigger({ geminiWebContinuationSubmitted: true })
  })
  act(() => render(null, container))
  await submit

  assert.equal(persistedSession?.geminiWeb_conversationUnsafe, true)
  assert.equal(persistedSession?.geminiWeb_conversation?.c, 'c-old')
})

test('unmount after switching providers preserves submitted Gemini uncertainty', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let latestSession
  let persistedSession

  mountCard(container, {
    session: geminiContinuationSession(),
    onUpdate: (_port, session) => {
      latestSession = session
      if (session.geminiWeb_conversationUnsafe === true) persistedSession = session
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('Q2')
  await nextTask()
  act(() => {
    state.ports[0].onMessage.trigger({ geminiWebContinuationSubmitted: true })
  })

  const selector = container.querySelector('select')
  assert.ok(selector)
  act(() => {
    selector.value = '-1'
    selector.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await waitFor(
    () => latestSession?.modelName === 'customModel',
    'provider switch did not update the session',
  )

  act(() => render(null, container))
  await submit

  assert.equal(persistedSession?.modelName, 'customModel')
  assert.equal(persistedSession?.geminiWeb_conversationUnsafe, true)
  assert.equal(persistedSession?.geminiWeb_conversation?.c, 'c-old')
})

test('auto-regeneration after a provider switch preserves Gemini uncertainty', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let latestSession

  state.config.autoRegenAfterSwitchModel = true
  mountCard(container, {
    session: geminiContinuationSession(),
    onUpdate: (_port, currentSession) => {
      latestSession = currentSession
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('Q2')
  await nextTask()
  act(() => {
    state.ports[0].onMessage.trigger({ geminiWebContinuationSubmitted: true })
  })
  const selector = container.querySelector('select')
  act(() => {
    selector.value = '-1'
    selector.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await waitFor(
    () => latestSession?.modelName === 'customModel',
    'provider switch did not update the session',
  )
  assert.equal(latestSession?.geminiWeb_conversationUnsafe, true)
  await submit
})

test('unmount during a submitted Gemini retry preserves the original answer', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let persistedSession
  const session = geminiContinuationSession()
  session.conversationRecords.push({ question: 'Q2', answer: 'A2' })
  session.geminiWeb_previousConversation = { accountPath: '' }
  session.geminiWeb_lastRecordIndex = 1

  mountCard(container, {
    session,
    onUpdate: (_port, nextSession) => {
      if (nextSession.geminiWeb_conversationUnsafe === true) {
        persistedSession = nextSession
      }
    },
  })
  await waitFor(
    () => typeof state.conversationItemProps?.onRetry === 'function',
    'Retry handler did not render',
  )

  let retry
  act(() => {
    retry = state.conversationItemProps.onRetry()
  })
  await retry
  act(() => {
    state.ports[0].onMessage.trigger({ geminiWebContinuationSubmitted: true })
    render(null, container)
  })

  assert.equal(persistedSession?.geminiWeb_conversationUnsafe, true)
  assert.deepEqual(persistedSession?.conversationRecords, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ])
  assert.equal(Object.hasOwn(persistedSession, 'geminiWeb_retryConversation'), false)
})

test('delayed Gemini unsafe notice does not overwrite a finalized retry', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let latestSession
  const session = geminiContinuationSession()
  session.conversationRecords.push({ question: 'Q2', answer: 'A2' })
  session.geminiWeb_previousConversation = { accountPath: '' }
  session.geminiWeb_lastRecordIndex = 1

  mountCard(container, {
    session,
    onUpdate: (_port, nextSession) => {
      latestSession = nextSession
    },
  })
  await waitFor(
    () => typeof state.conversationItemProps?.onRetry === 'function',
    'Retry handler did not render',
  )

  let retry
  act(() => {
    retry = state.conversationItemProps.onRetry()
  })
  await retry
  act(() => {
    state.ports[0].onMessage.trigger({ geminiWebContinuationSubmitted: true })
    state.ports[0].onMessage.trigger({ done: true })
  })
  await waitFor(
    () => latestSession?.geminiWeb_conversationUnsafe === true,
    'stopped retry did not retain Gemini uncertainty',
  )
  act(() => {
    state.ports[0].onMessage.trigger({ geminiWebConversationUnsafe: true })
  })

  assert.deepEqual(latestSession?.conversationRecords, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ])
  assert.equal(Object.hasOwn(latestSession, 'geminiWeb_retryConversation'), false)
  assert.equal(latestSession?.geminiWeb_conversationUnsafe, true)
})

test('saved continuation is durably marked pending before the request is forwarded', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let finishPersist
  const persisted = new Promise((resolve) => {
    finishPersist = resolve
  })
  let snapshot

  mountCard(container, {
    session: geminiContinuationSession(),
    onBeforeGeminiContinuationSubmit: async (session) => {
      snapshot = session
      await persisted
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submission = state.inputBoxProps.onSubmit('Q2')
  await waitFor(() => snapshot !== undefined, 'pending snapshot was not persisted')
  assert.equal(snapshot.geminiWeb_conversationPending, true)
  assert.equal(state.ports[0].postedMessages.length, 0)

  finishPersist()
  await submission
  assert.equal(state.ports[0].postedMessages.length, 1)
  assert.equal(state.ports[0].postedMessages[0].session.question, 'Q2')
})

test('Stop cancels a continuation waiting for its pending snapshot write', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let finishPersist
  const persisted = new Promise((resolve) => {
    finishPersist = resolve
  })
  let snapshot
  let cancelled

  mountCard(container, {
    session: geminiContinuationSession(),
    onBeforeGeminiContinuationSubmit: async (session) => {
      snapshot = session
      await persisted
    },
    onCancelGeminiContinuationSubmit: async (sessionId, requestId) => {
      cancelled = { sessionId, requestId }
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submission = state.inputBoxProps.onSubmit('Q2')
  await waitFor(() => snapshot !== undefined, 'pending write did not start')
  await state.inputBoxProps.postMessage({ stop: true })
  finishPersist()
  await submission

  assert.equal(snapshot.geminiWeb_conversationPending, true)
  assert.equal(cancelled?.requestId, snapshot.geminiWeb_pendingRequestId)
  assert.equal(state.ports[0].postedMessages.some((message) => message.session), false)
})

test('background session echoes retain the pending Gemini continuation marker', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let latestSession

  mountCard(container, {
    session: geminiContinuationSession(),
    onBeforeGeminiContinuationSubmit: async () => {},
    onUpdate: (_port, session) => {
      latestSession = session
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  await state.inputBoxProps.onSubmit('Q2')
  const sentSession = state.ports[0].postedMessages[0].session
  act(() => {
    state.ports[0].onMessage.trigger({ session: sentSession })
  })
  await waitFor(
    () => latestSession?.geminiWeb_conversationPending === true,
    'background session echo cleared the pending marker',
  )
  assert.equal(typeof latestSession.geminiWeb_pendingRequestId, 'string')
})

test('failed pending persistence restores the InputBox ready state', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)

  mountCard(container, {
    session: geminiContinuationSession(),
    onBeforeGeminiContinuationSubmit: async () => {
      throw new Error('Storage unavailable')
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  await state.inputBoxProps.onSubmit('Q2')
  await waitFor(() => state.inputBoxProps?.enabled === true, 'InputBox stayed disabled')
  assert.equal(state.ports[0].postedMessages.some((message) => message.session), false)
})

test('saving a pending completed-answer retry retains the original answer', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let snapshot
  const session = geminiContinuationSession()
  session.conversationRecords.push({ question: 'Q2', answer: 'A2' })
  session.geminiWeb_previousConversation = { c: 'c-old', r: 'r-old', rc: 'rc-old' }
  session.geminiWeb_lastRecordIndex = 1

  mountCard(container, {
    session,
    onBeforeGeminiContinuationSubmit: async (saved) => {
      snapshot = saved
    },
  })
  await waitFor(
    () => typeof state.conversationItemProps?.onRetry === 'function',
    'Retry handler did not render',
  )
  let retry
  act(() => {
    retry = state.conversationItemProps.onRetry()
  })
  await retry

  assert.equal(snapshot.geminiWeb_conversationPending, true)
  assert.deepEqual(snapshot.conversationRecords, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ])
  assert.equal(Object.hasOwn(snapshot, 'geminiWeb_retryConversation'), false)
})

test('unmount before Gemini prompt submission keeps continuation retry-safe', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let unsafeUpdateCount = 0

  mountCard(container, {
    session: geminiContinuationSession(),
    onUpdate: (_port, session) => {
      if (session.geminiWeb_conversationUnsafe === true) unsafeUpdateCount += 1
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('Q2')
  await nextTask()
  act(() => render(null, container))
  await submit

  assert.equal(unsafeUpdateCount, 0)
})

test('stop acknowledgement after a submitted Gemini continuation marks it unsafe', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let latestSession

  mountCard(container, {
    session: geminiContinuationSession(),
    onUpdate: (_port, session) => {
      latestSession = session
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('Q2')
  await nextTask()
  const port = state.ports[0]
  act(() => {
    port.onMessage.trigger({ geminiWebContinuationSubmitted: true })
    port.onMessage.trigger({ done: true })
  })
  await waitFor(
    () => latestSession?.geminiWeb_conversationUnsafe === true,
    'submitted continuation was not marked unsafe after stop acknowledgement',
  )
  assert.equal(latestSession.geminiWeb_conversation.c, 'c-old')
  await submit
})

test('remote runtime disconnect marks an in-flight Gemini continuation unsafe in foreground state', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let latestSession
  const geminiSession = geminiContinuationSession()

  mountCard(container, {
    session: geminiSession,
    onUpdate: (_port, session) => {
      latestSession = session
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('Q2')
  await nextTask()
  const initialPort = state.ports[0]

  act(() => {
    initialPort.onMessage.trigger({ geminiWebContinuationSubmitted: true })
  })
  act(() => initialPort.emitRemoteDisconnect())
  await waitFor(
    () => latestSession?.geminiWeb_conversationUnsafe === true,
    'Gemini continuation was not marked unsafe after runtime disconnect',
  )

  assert.equal(state.ports.length, 2)
  assert.equal(latestSession.geminiWeb_conversation.c, 'c-old')
  await submit

  act(() => render(null, container))
})

test('remote runtime Port disconnect reconnects and unmount cleans the replacement', () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)

  mountCard(container)
  const initialPort = state.ports[0]

  act(() => initialPort.emitRemoteDisconnect())

  assert.equal(initialPort.disconnectCount, 0)
  assert.equal(initialPort.disconnected, true)
  assert.equal(state.ports.length, 2)
  const replacementPort = state.ports[1]
  assert.equal(replacementPort.disconnected, false)

  act(() => render(null, container))

  assert.equal(replacementPort.disconnectCount, 1)
  assert.equal(replacementPort.disconnected, true)
  assert.equal(state.ports.length, 2)
})

test('close button disposes foreground transport before onClose', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let closeCount = 0
  let disconnectedBeforeClose = false
  let foregroundDisconnectCount = 0
  state.foreground = true
  state.generateAnswers = (fakePort) => {
    state.generateAnswersCount += 1
    return new Promise((resolve) => {
      fakePort.onDisconnect.addListener(() => {
        foregroundDisconnectCount += 1
        resolve()
      })
    })
  }

  mountCard(container, {
    closeable: true,
    onClose: () => {
      closeCount += 1
      disconnectedBeforeClose = state.ports[0].disconnected && foregroundDisconnectCount === 1
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('question')
  await waitFor(() => state.generateAnswersCount === 1, 'foreground provider did not start')

  const closeButton = Array.from(container.querySelectorAll('.gpt-util-icon')).find(
    (element) => element.title === 'Close the Window',
  )
  assert.ok(closeButton)

  act(() => {
    closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitFor(() => foregroundDisconnectCount === 1, 'foreground Port was not disconnected')
  await submit

  const port = state.ports[0]
  assert.equal(disconnectedBeforeClose, true)
  assert.equal(closeCount, 1)
  assert.equal(foregroundDisconnectCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)

  act(() => render(null, container))

  assert.equal(closeCount, 1)
  assert.equal(foregroundDisconnectCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)
})

test('CLOSE_CHATS disposes foreground transport before onClose', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let closeCount = 0
  let disconnectedBeforeClose = false
  let foregroundDisconnectCount = 0
  state.foreground = true
  state.generateAnswers = (fakePort) => {
    state.generateAnswersCount += 1
    return new Promise((resolve) => {
      fakePort.onDisconnect.addListener(() => {
        foregroundDisconnectCount += 1
        resolve()
      })
    })
  }

  mountCard(container, {
    closeable: true,
    onClose: () => {
      closeCount += 1
      disconnectedBeforeClose = state.ports[0].disconnected && foregroundDisconnectCount === 1
    },
  })
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('question')
  await waitFor(() => state.generateAnswersCount === 1, 'foreground provider did not start')

  act(() => state.runtimeOnMessage.trigger({ type: 'CLOSE_CHATS' }))
  await waitFor(() => foregroundDisconnectCount === 1, 'foreground Port was not disconnected')
  await submit

  const port = state.ports[0]
  assert.equal(disconnectedBeforeClose, true)
  assert.equal(closeCount, 1)
  assert.equal(foregroundDisconnectCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)

  act(() => render(null, container))

  assert.equal(closeCount, 1)
  assert.equal(foregroundDisconnectCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)
})

test('Escape config continuation does not close after unmount', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const pendingConfig = deferred()
  const container = document.createElement('div')
  document.body.append(container)
  let closeCount = 0

  state.getUserConfig = () => {
    state.configReadCount += 1
    return pendingConfig.promise
  }

  mountCard(container, {
    closeable: true,
    onClose: () => {
      closeCount += 1
    },
  })

  act(() => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
  })
  await waitFor(() => state.configReadCount === 1, 'Escape configuration read did not start')

  act(() => render(null, container))
  const port = state.ports[0]
  assert.equal(port.disconnectCount, 1)

  pendingConfig.resolve({ allowEscToCloseAll: true })
  await pendingConfig.promise
  await nextTask()

  assert.equal(closeCount, 0)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)
})

test('successful clear replacement Port is disposed on unmount', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)

  mountCard(container)
  await waitFor(
    () => typeof state.deleteButtonProps?.onConfirm === 'function',
    'DeleteButton did not render',
  )

  const initialPort = state.ports[0]
  await act(async () => {
    await state.deleteButtonProps.onConfirm()
    await Promise.resolve()
  })

  assert.equal(state.ports.length, 2)
  const replacementPort = state.ports[1]
  assert.equal(initialPort.disconnectCount, 1)
  assert.equal(initialPort.disconnected, true)
  assert.equal(replacementPort.disconnectCount, 0)
  assert.equal(replacementPort.disconnected, false)

  act(() => render(null, container))

  assert.equal(replacementPort.disconnectCount, 1)
  assert.equal(replacementPort.disconnected, true)
  assert.equal(state.ports.length, 2)
})

test('clear continuation does not reconnect after unmount', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)

  mountCard(container)
  await waitFor(
    () => typeof state.deleteButtonProps?.onConfirm === 'function',
    'DeleteButton did not render',
  )

  const clear = state.deleteButtonProps.onConfirm()
  act(() => render(null, container))
  await clear

  assert.equal(state.ports.length, 1)
  assert.equal(state.ports[0].disconnectCount, 1)
})

test('Stop cancels a foreground request waiting for configuration', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const pendingConfig = deferred()
  state.foreground = true
  state.getUserConfig = () => {
    state.configReadCount += 1
    return pendingConfig.promise
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container)
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  const submit = state.inputBoxProps.onSubmit('question')
  await waitFor(() => state.configReadCount === 1, 'foreground configuration read did not start')
  await waitFor(
    () => state.inputBoxProps?.enabled === false,
    'input did not enter generating state',
  )

  await act(async () => {
    await state.inputBoxProps.postMessage({ stop: true })
    await Promise.resolve()
  })
  await waitFor(() => state.inputBoxProps?.enabled === true, 'Stop did not restore input readiness')
  assert.equal(state.generateAnswersCount, 0)

  pendingConfig.resolve({ bingAccessToken: 'token' })
  await submit
  await nextTask()

  assert.equal(state.generateAnswersCount, 0)
  assert.equal(state.inputBoxProps.enabled, true)
  assert.equal(state.ports.length, 1)
})

test('clear supersedes a foreground request waiting for configuration', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const pendingConfig = deferred()
  state.foreground = true
  state.getUserConfig = () => {
    state.configReadCount += 1
    return pendingConfig.promise
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container)
  await waitFor(
    () => typeof state.inputBoxProps?.postMessage === 'function',
    'InputBox did not render',
  )
  await waitFor(
    () => typeof state.deleteButtonProps?.onConfirm === 'function',
    'DeleteButton did not render',
  )

  const pendingRequest = state.inputBoxProps.postMessage({
    session: { ...baseSession(), question: 'stale question' },
  })
  await waitFor(() => state.configReadCount === 1, 'foreground configuration read did not start')

  await act(async () => {
    await state.deleteButtonProps.onConfirm()
    await Promise.resolve()
  })
  assert.equal(state.generateAnswersCount, 0)

  pendingConfig.resolve({ bingAccessToken: 'token' })
  await pendingRequest
  await nextTask()

  assert.equal(state.generateAnswersCount, 0)
  assert.equal(state.ports.length, 1)
})

test('unmount while foreground config is pending prevents provider startup', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const pendingConfig = deferred()
  state.foreground = true
  state.getUserConfig = () => {
    state.configReadCount += 1
    return pendingConfig.promise
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container, { question: 'question' })

  await waitFor(() => state.configReadCount === 1, 'foreground configuration read did not start')
  act(() => render(null, container))

  pendingConfig.resolve({ bingAccessToken: 'token' })
  await pendingConfig.promise
  await nextTask()
  await nextTask()

  assert.equal(state.generateAnswersCount, 0)
  assert.equal(state.ports.length, 1)
  assert.equal(state.ports[0].disconnectCount, 1)
})

test('unmount emits foreground disconnect so an active request can abort', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  state.foreground = true
  let disconnectCount = 0
  state.generateAnswers = (fakePort) => {
    state.generateAnswersCount += 1
    return new Promise((resolve) => {
      fakePort.onDisconnect.addListener(() => {
        disconnectCount += 1
        resolve()
      })
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container, { question: 'question' })
  await waitFor(() => state.generateAnswersCount === 1, 'foreground provider did not start')

  assert.equal(state.generateAnswersCount, 1)
  act(() => render(null, container))
  await nextTask()

  assert.equal(disconnectCount, 1)
  assert.equal(state.ports.length, 1)
  assert.equal(state.ports[0].disconnectCount, 1)
})

test('foreground disconnect cleanup survives a throwing listener', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  state.foreground = true
  let survivingDisconnectCount = 0
  state.generateAnswers = (fakePort) => {
    state.generateAnswersCount += 1
    return new Promise((resolve) => {
      fakePort.onDisconnect.addListener(() => {
        throw new Error('disconnect listener failed')
      })
      fakePort.onDisconnect.addListener(() => {
        survivingDisconnectCount += 1
        resolve()
      })
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container, { question: 'question' })
  await waitFor(() => state.generateAnswersCount === 1, 'foreground provider did not start')

  const runtimePort = state.ports[0]
  act(() => render(null, container))

  await waitFor(() => survivingDisconnectCount === 1, 'later disconnect listener did not run')
  assert.equal(runtimePort.disconnectCount, 1)
  assert.equal(runtimePort.disconnected, true)
})

test('foreground stop reaches listeners that remove themselves during dispatch', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  state.foreground = true
  const stoppedRequests = []
  state.generateAnswers = (fakePort) => {
    state.generateAnswersCount += 1
    const requestNumber = state.generateAnswersCount
    return new Promise((resolve) => {
      const stopListener = (message) => {
        if (!message.stop) return
        fakePort.onMessage.removeListener(stopListener)
        stoppedRequests.push(requestNumber)
        resolve()
      }
      fakePort.onMessage.addListener(stopListener)
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container)
  await waitFor(
    () => typeof state.inputBoxProps?.postMessage === 'function',
    'InputBox did not render',
  )

  let firstSettled = false
  let secondSettled = false
  state.inputBoxProps
    .postMessage({ session: { ...baseSession(), question: 'first' } })
    .finally(() => {
      firstSettled = true
    })
  await waitFor(() => state.generateAnswersCount === 1, 'first foreground request did not start')

  state.inputBoxProps
    .postMessage({ session: { ...baseSession(), question: 'second' } })
    .finally(() => {
      secondSettled = true
    })
  await waitFor(() => state.generateAnswersCount === 2, 'second foreground request did not start')

  await state.inputBoxProps.postMessage({ stop: true, stopGenerationId: 1 })
  await waitFor(() => stoppedRequests.length === 2, 'stop did not reach every foreground request')
  await waitFor(
    () => firstSettled && secondSettled,
    'foreground requests did not settle after stop',
  )

  assert.deepEqual(stoppedRequests, [1, 2])
})

test('foreground submit can settle safely after unmount', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  state.foreground = true
  let disconnectCount = 0
  state.generateAnswers = (fakePort) => {
    state.generateAnswersCount += 1
    return new Promise((resolve) => {
      fakePort.onDisconnect.addListener(() => {
        disconnectCount += 1
        resolve()
      })
    })
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container)
  await waitFor(
    () => typeof state.inputBoxProps?.onSubmit === 'function',
    'InputBox did not render',
  )

  let submitSettled = false
  let submitError
  const submit = state.inputBoxProps.onSubmit('question')
  submit.then(
    () => {
      submitSettled = true
    },
    (error) => {
      submitError = error
      submitSettled = true
    },
  )
  await waitFor(() => state.generateAnswersCount === 1, 'foreground provider did not start')
  act(() => render(null, container))
  await waitFor(() => submitSettled, 'foreground submit did not settle after unmount')
  if (submitError) throw submitError

  assert.equal(disconnectCount, 1)
  assert.equal(state.generateAnswersCount, 1)
  assert.equal(state.ports[0].disconnectCount, 1)
})

test('provider failure disconnects fake Port and removes stale listeners', async () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  state.foreground = true
  let disconnectCount = 0
  let staleMessageCount = 0
  state.generateAnswers = async (fakePort) => {
    state.generateAnswersCount += 1
    fakePort.onMessage.addListener(() => {
      staleMessageCount += 1
    })
    fakePort.onDisconnect.addListener(() => {
      disconnectCount += 1
    })
    throw new Error('provider failed before cleanup')
  }

  const container = document.createElement('div')
  document.body.append(container)
  mountCard(container, { question: 'question' })

  await waitFor(() => state.generateAnswersCount === 1, 'foreground provider did not start')
  await waitFor(() => disconnectCount === 1, 'foreground fake Port was not disconnected')
  await waitFor(
    () => typeof state.inputBoxProps?.postMessage === 'function',
    'InputBox did not render',
  )

  await state.inputBoxProps.postMessage({ stop: true, stopGenerationId: 1 })

  assert.equal(staleMessageCount, 0)
  assert.equal(disconnectCount, 1)

  act(() => render(null, container))
})
