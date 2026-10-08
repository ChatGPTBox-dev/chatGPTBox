import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createVideoSummaryChatgptProxy } from '../../../src/background/video-summary-chatgpt-proxy.mjs'

function createPort() {
  const posted = []
  const messageListeners = new Set()
  const disconnectListeners = new Set()
  let disconnected = false

  return {
    posted,
    get disconnected() {
      return disconnected
    },
    onMessage: {
      addListener(listener) {
        messageListeners.add(listener)
      },
      removeListener(listener) {
        messageListeners.delete(listener)
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.add(listener)
      },
      removeListener(listener) {
        disconnectListeners.delete(listener)
      },
    },
    postMessage(message) {
      posted.push(message)
    },
    disconnect() {
      if (disconnected) return
      disconnected = true
      for (const listener of Array.from(disconnectListeners)) listener()
    },
    emitMessage(message) {
      for (const listener of Array.from(messageListeners)) listener(message)
    },
    emitDisconnect() {
      for (const listener of Array.from(disconnectListeners)) listener()
    },
  }
}

function createHarness({ configuredTabId = 42, getTab = async (tabId) => ({ id: tabId }) } = {}) {
  const connectCalls = []
  const ports = []
  const logs = []
  const tabs = {
    get: getTab,
    connect(tabId, options) {
      connectCalls.push({ tabId, options })
      const port = createPort()
      ports.push(port)
      return port
    },
  }
  const logger = {
    info(value) {
      logs.push(value)
    },
    warn(value) {
      logs.push(value)
    },
  }
  const proxy = createVideoSummaryChatgptProxy({
    tabs,
    getConfiguredTabId: async () => configuredTabId,
    logger,
  })
  return { connectCalls, logs, ports, proxy }
}

async function assertProviderPageRequired(promise, modelName) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, 'MODEL_PROVIDER_PAGE_REQUIRED')
    assert.equal(error.code, 'MODEL_PROVIDER_PAGE_REQUIRED')
    assert.equal(error.condition, 'provider-page-required')
    assert.equal(error.modelName, modelName)
    return true
  })
}

test('requires a configured and valid ChatGPT provider page', async () => {
  const session = { modelName: 'chatgptWeb', question: 'private question' }
  const missing = createHarness({ configuredTabId: 0 })
  const closed = createHarness({
    getTab: async () => {
      throw new Error('No tab')
    },
  })
  const invalid = createHarness({ getTab: async () => null })

  await assertProviderPageRequired(
    missing.proxy.generate({ requestId: 'req-1', session }),
    'chatgptWeb',
  )
  await assertProviderPageRequired(
    closed.proxy.generate({ requestId: 'req-2', session }),
    'chatgptWeb',
  )
  await assertProviderPageRequired(
    invalid.proxy.generate({ requestId: 'req-3', session }),
    'chatgptWeb',
  )
  assert.deepEqual(missing.connectCalls, [])
  assert.deepEqual(closed.connectCalls, [])
  assert.deepEqual(invalid.connectCalls, [])
})

test('opens a one-shot request port and collects only its correlated answer', async () => {
  const session = { modelName: 'chatgptWeb', question: 'private question' }
  const { connectCalls, logs, ports, proxy } = createHarness()

  const resultPromise = proxy.generate({ requestId: 'req-1', session })
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(connectCalls, [
    { tabId: 42, options: { name: 'video-summary-chatgpt-proxy:req-1' } },
  ])
  assert.deepEqual(ports[0].posted[0], { type: 'GENERATE_TEXT', requestId: 'req-1', session })

  ports[0].emitMessage({ requestId: 'other', answer: 'wrong', done: true })
  ports[0].emitMessage({ requestId: 'req-1', answer: 'partial', done: false })
  ports[0].emitMessage({
    requestId: 'req-1',
    answer: 'private answer',
    done: true,
    finishReason: 'stop',
  })

  assert.deepEqual(await resultPromise, { text: 'private answer', finishReason: 'stop' })
  assert.equal(ports[0].disconnected, true)
  assert.equal(JSON.stringify(logs).includes(session.question), false)
  assert.equal(JSON.stringify(logs).includes('private answer'), false)
})

test('isolates concurrent request replies', async () => {
  const { ports, proxy } = createHarness()
  const first = proxy.generate({
    requestId: 'req-1',
    session: { modelName: 'chatgptWeb', question: 'first' },
  })
  const second = proxy.generate({
    requestId: 'req-2',
    session: { modelName: 'chatgptWeb', question: 'second' },
  })
  await Promise.resolve()
  await Promise.resolve()

  ports[0].emitMessage({ requestId: 'req-2', answer: 'crossed', done: true })
  ports[1].emitMessage({ requestId: 'req-1', answer: 'crossed', done: true })
  ports[1].emitMessage({ requestId: 'req-2', answer: 'answer 2', done: true })
  ports[0].emitMessage({ requestId: 'req-1', answer: 'answer 1', done: true })

  assert.deepEqual(await Promise.all([first, second]), [
    { text: 'answer 1', finishReason: null },
    { text: 'answer 2', finishReason: null },
  ])
})

test('rejects when the provider page disconnects before completion', async () => {
  const { ports, proxy } = createHarness()
  const result = proxy.generate({
    requestId: 'req-1',
    session: { modelName: 'chatgptWeb', question: 'private' },
  })
  await Promise.resolve()
  await Promise.resolve()

  ports[0].emitDisconnect()

  await assert.rejects(result, { code: 'MODEL_PROVIDER_PAGE_REQUIRED' })
})

test('does not connect when aborted during tab validation', async () => {
  const controller = new AbortController()
  const { connectCalls, proxy } = createHarness({
    getTab: async (tabId) => {
      controller.abort()
      return { id: tabId }
    },
  })

  await assert.rejects(
    proxy.generate({
      requestId: 'req-1',
      session: { modelName: 'chatgptWeb', question: 'private' },
      signal: controller.signal,
    }),
    { code: 'MODEL_GATEWAY_ABORTED' },
  )
  assert.deepEqual(connectCalls, [])
})

test('cancels and disconnects an aborted request', async () => {
  const controller = new AbortController()
  const { ports, proxy } = createHarness()
  const result = proxy.generate({
    requestId: 'req-1',
    session: { modelName: 'chatgptWeb', question: 'private' },
    signal: controller.signal,
  })
  await Promise.resolve()
  await Promise.resolve()

  controller.abort()

  await assert.rejects(result, { code: 'MODEL_GATEWAY_ABORTED' })
  assert.deepEqual(ports[0].posted.at(-1), {
    type: 'CANCEL_GENERATE_TEXT',
    requestId: 'req-1',
  })
  assert.equal(ports[0].disconnected, true)
})
