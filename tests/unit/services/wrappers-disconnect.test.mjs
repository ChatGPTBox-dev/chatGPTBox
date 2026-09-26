import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createFakePort } from '../helpers/port.mjs'

const onConnectListeners = new Set()
globalThis.chrome.runtime.onConnect = {
  addListener(listener) {
    onConnectListeners.add(listener)
  },
  removeListener(listener) {
    onConnectListeners.delete(listener)
  },
}

globalThis.chrome.cookies = {
  getAll() {
    return Promise.resolve([])
  },
  get() {
    return Promise.resolve(null)
  },
}

import Browser from 'webextension-polyfill'
import { registerPortListener } from '../../../src/services/wrappers.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const triggerConnect = (port) => {
  for (const listener of Array.from(onConnectListeners)) listener(port)
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  onConnectListeners.clear()
})

test('disconnect invalidates a session request waiting for configuration', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const pendingConfig = deferred()
  t.mock.method(Browser.storage.local, 'get', () => pendingConfig.promise)
  const executor = t.mock.fn(async () => {})

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  await nextTask()
  port.emitDisconnect()

  pendingConfig.resolve({})
  await pendingConfig.promise
  await nextTask()

  assert.equal(executor.mock.calls.length, 0)
  assert.deepEqual(port.postedMessages, [])
})

test('disconnect prevents delayed request-port messages from reaching the closed connection', async (t) => {
  t.mock.method(console, 'debug', () => {})
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ modelName: 'chatgptApi4oMini' })

  let requestPort
  let markReady
  const ready = new Promise((resolve) => {
    markReady = resolve
  })
  const executor = t.mock.fn(async (_session, currentRequestPort) => {
    requestPort = currentRequestPort
    markReady()
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)
  port.emitMessage({ session: { conversationRecords: [], aiName: 'Test AI' } })
  await ready

  assert.equal(port.postedMessages.length, 1)
  port.emitDisconnect()
  requestPort.postMessage({ done: true })

  assert.equal(port.postedMessages.length, 1)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
