import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, afterEach, before, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { getUserConfig } from '../../../src/config/index.mjs'

register(new URL('../../setup/web-jump-back-loader-hooks.mjs', import.meta.url))

const { setUserConfig: setWriterConfig } = await import(
  '../../../src/config/index.mjs?jump-back-writer'
)
const shim = globalThis.__TEST_BROWSER_SHIM__
const originalDescriptors = new Map()
const globalNames = ['window', 'document', 'Node', 'HTMLElement']
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(message)
}

let dom
let WebJumpBackNotification
let container
let toastContainer

const mountNotification = async () => {
  container = document.createElement('div')
  toastContainer = document.createElement('div')
  document.body.append(container, toastContainer)
  act(() => render(h(WebJumpBackNotification, { chatgptMode: false }), container))
  await waitFor(() => globalThis.__JUMP_BACK_TEST__.content, 'notification did not render')
  act(() => render(globalThis.__JUMP_BACK_TEST__.content, toastContainer))
  const button = toastContainer.querySelector('button')
  assert.equal(button?.textContent, 'Go Back')
  return button
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/' })
  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  globalThis.__JUMP_BACK_TEST__ = {}
  ;({ default: WebJumpBackNotification } = await import(
    '../../../src/components/WebJumpBackNotification/index.jsx'
  ))
})

afterEach(() => {
  act(() => {
    if (container) render(null, container)
    if (toastContainer) render(null, toastContainer)
  })
  document.body.replaceChildren()
  delete globalThis.__JUMP_BACK_TEST__.content
  container = null
  toastContainer = null
})

after(() => {
  dom.window.close()
  delete globalThis.__JUMP_BACK_TEST__
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('Go Back observes updated target tabs before their storage events', async (t) => {
  shim.replaceStorage({ notificationJumpBackTabId: 101 })
  for (let attempt = 0; attempt < 3; attempt++) await getUserConfig()
  const button = await mountNotification()
  const messages = []
  t.mock.method(globalThis.chrome.runtime, 'sendMessage', (message, callback) => {
    messages.push(message)
    callback?.()
  })

  shim.deferStorageEvents()
  t.after(() => shim.flushStorageEvents())
  for (const tabId of [202, 303]) {
    await setWriterConfig({ notificationJumpBackTabId: tabId })
    assert.ok(shim.pendingStorageEvents() > 0)
    const count = messages.length
    act(() => button.click())
    await waitFor(() => messages.length > count, 'Go Back did not send its message')
    assert.deepEqual(messages.at(-1), { type: 'ACTIVATE_URL', data: { tabId } })
  }
})

test('Go Back handles read and activation failures and allows retry', async (t) => {
  shim.replaceStorage({ notificationJumpBackTabId: 202 })
  for (let attempt = 0; attempt < 3; attempt++) await getUserConfig()
  const button = await mountNotification()
  const warning = t.mock.method(console, 'warn', () => {})
  const messages = []
  const send = t.mock.method(globalThis.chrome.runtime, 'sendMessage', (message, callback) => {
    messages.push(message)
    callback?.()
  })
  const get = t.mock.method(globalThis.chrome.storage.local, 'get', (_keys, callback) => {
    globalThis.chrome.runtime.lastError = { message: 'storage unavailable' }
    try {
      callback(undefined)
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  })

  act(() => button.click())
  await waitFor(() => warning.mock.callCount() === 1, 'read failure was not handled')
  assert.match(warning.mock.calls[0].arguments[1].message, /storage unavailable/)
  assert.equal(messages.length, 0)

  get.mock.restore()
  send.mock.restore()
  const failedSend = t.mock.method(
    globalThis.chrome.runtime,
    'sendMessage',
    (_message, callback) => {
      globalThis.chrome.runtime.lastError = { message: 'target tab unavailable' }
      try {
        callback(undefined)
      } finally {
        delete globalThis.chrome.runtime.lastError
      }
    },
  )
  act(() => button.click())
  await waitFor(() => warning.mock.callCount() === 2, 'activation failure was not handled')
  assert.match(warning.mock.calls[1].arguments[1].message, /target tab unavailable/)

  failedSend.mock.restore()
  t.mock.method(globalThis.chrome.runtime, 'sendMessage', (message, callback) => {
    messages.push(message)
    callback?.()
  })
  act(() => button.click())
  await waitFor(() => messages.length === 1, 'Go Back did not recover')
  assert.deepEqual(messages[0], { type: 'ACTIVATE_URL', data: { tabId: 202 } })
})
