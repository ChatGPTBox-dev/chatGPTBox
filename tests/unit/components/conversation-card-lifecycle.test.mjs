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

const createRuntimePort = () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const onMessage = createEvent()
  const onDisconnect = createEvent()
  let disconnected = false
  let disconnectCount = 0
  const port = {
    onMessage,
    onDisconnect,
    postMessage() {},
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
  state.config = defaultConfig()
  state.ports = []
  state.inputBoxProps = null
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

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/' })

  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    })
  }

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
  dom.window.close()
  delete globalThis.__CONVERSATION_LIFECYCLE_TEST__

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
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

test('close button disposes before onClose and parent unmount stays idempotent', () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let closeCount = 0
  let disconnectedBeforeClose = false

  mountCard(container, {
    closeable: true,
    onClose: () => {
      closeCount += 1
      disconnectedBeforeClose = state.ports[0].disconnected
    },
  })

  const closeButton = Array.from(container.querySelectorAll('.gpt-util-icon')).find(
    (element) => element.title === 'Close the Window',
  )
  assert.ok(closeButton)

  act(() => {
    closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  const port = state.ports[0]
  assert.equal(disconnectedBeforeClose, true)
  assert.equal(closeCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)

  act(() => render(null, container))

  assert.equal(closeCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)
})

test('CLOSE_CHATS disposes before onClose and parent unmount stays idempotent', () => {
  const state = globalThis.__CONVERSATION_LIFECYCLE_TEST__
  const container = document.createElement('div')
  document.body.append(container)
  let closeCount = 0
  let disconnectedBeforeClose = false

  mountCard(container, {
    closeable: true,
    onClose: () => {
      closeCount += 1
      disconnectedBeforeClose = state.ports[0].disconnected
    },
  })

  act(() => state.runtimeOnMessage.trigger({ type: 'CLOSE_CHATS' }))

  const port = state.ports[0]
  assert.equal(disconnectedBeforeClose, true)
  assert.equal(closeCount, 1)
  assert.equal(port.disconnectCount, 1)
  assert.equal(state.ports.length, 1)

  act(() => render(null, container))

  assert.equal(closeCount, 1)
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

test('foreground provider failure disconnects its fake Port and removes stale listeners', async () => {
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
