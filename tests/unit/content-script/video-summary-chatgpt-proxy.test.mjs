import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerVideoSummaryChatgptProxyListener } from '../../../src/content-script/video-summary-chatgpt-proxy.mjs'

function createEvent() {
  const listeners = new Set()
  return {
    addListener(listener) {
      listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    emit(value) {
      for (const listener of Array.from(listeners)) listener(value)
    },
  }
}

function createPort(name) {
  return {
    name,
    posted: [],
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    postMessage(message) {
      this.posted.push(message)
    },
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

test('accepts only dedicated proxy ports and valid correlated generate requests', async () => {
  const onConnect = createEvent()
  const calls = []
  registerVideoSummaryChatgptProxyListener({
    runtime: { onConnect },
    getAccessToken: async () => 'token',
    generateAnswers: async (port, question, session, accessToken) => {
      calls.push({ question, session, accessToken })
      port.postMessage({ answer: 'answer', done: true, finishReason: 'stop' })
    },
  })
  const ordinary = createPort('chatgptbox')
  const dedicated = createPort('bilibili-video-summary-chatgpt-proxy:req-1')
  onConnect.emit(ordinary)
  onConnect.emit(dedicated)

  ordinary.onMessage.emit({
    type: 'GENERATE_TEXT',
    requestId: 'req-1',
    session: { question: 'ignored' },
  })
  dedicated.onMessage.emit({ type: 'GENERATE_TEXT', requestId: 'wrong', session: {} })
  dedicated.onMessage.emit({
    type: 'GENERATE_TEXT',
    requestId: 'req-1',
    session: { modelName: 'chatgptWeb', question: 'private question' },
  })
  await nextTask()

  assert.deepEqual(calls, [
    {
      question: 'private question',
      session: { modelName: 'chatgptWeb', question: 'private question' },
      accessToken: 'token',
    },
  ])
  assert.deepEqual(dedicated.posted, [
    { requestId: 'req-1', answer: 'answer', done: true, finishReason: 'stop' },
  ])
  assert.deepEqual(ordinary.posted, [])
})

test('forwards cancellation and disconnect to only the request-local generation port', async () => {
  const onConnect = createEvent()
  const localPorts = new Map()
  registerVideoSummaryChatgptProxyListener({
    runtime: { onConnect },
    getAccessToken: async () => 'token',
    generateAnswers: async (port, _question, session) => {
      localPorts.set(session.question, port)
    },
  })
  const first = createPort('bilibili-video-summary-chatgpt-proxy:req-1')
  const second = createPort('bilibili-video-summary-chatgpt-proxy:req-2')
  onConnect.emit(first)
  onConnect.emit(second)
  first.onMessage.emit({
    type: 'GENERATE_TEXT',
    requestId: 'req-1',
    session: { question: 'first' },
  })
  second.onMessage.emit({
    type: 'GENERATE_TEXT',
    requestId: 'req-2',
    session: { question: 'second' },
  })
  await nextTask()

  const firstMessages = []
  const secondMessages = []
  localPorts.get('first').onMessage.addListener((message) => firstMessages.push(message))
  localPorts.get('second').onMessage.addListener((message) => secondMessages.push(message))
  first.onMessage.emit({ type: 'CANCEL_GENERATE_TEXT', requestId: 'req-1' })
  second.onDisconnect.emit()

  assert.deepEqual(firstMessages, [{ stop: true }])
  assert.deepEqual(secondMessages, [{ stop: true }])
})

test('does not start generation after disconnect during access-token lookup', async () => {
  const onConnect = createEvent()
  let resolveAccessToken
  const accessToken = new Promise((resolve) => {
    resolveAccessToken = resolve
  })
  const calls = []
  registerVideoSummaryChatgptProxyListener({
    runtime: { onConnect },
    getAccessToken: () => accessToken,
    generateAnswers: async (...args) => {
      calls.push(args)
    },
  })
  const port = createPort('bilibili-video-summary-chatgpt-proxy:req-1')
  onConnect.emit(port)
  port.onMessage.emit({
    type: 'GENERATE_TEXT',
    requestId: 'req-1',
    session: { question: 'private' },
  })
  await Promise.resolve()
  port.onDisconnect.emit()
  resolveAccessToken('token')
  await nextTask()

  assert.deepEqual(calls, [])
})

test('tags safe errors without logging request content', async () => {
  const onConnect = createEvent()
  const logs = []
  const logger = {
    error(value) {
      logs.push(value)
    },
  }
  registerVideoSummaryChatgptProxyListener({
    runtime: { onConnect },
    getAccessToken: async () => 'token',
    generateAnswers: async () => {
      throw new Error('private answer')
    },
    logger,
  })
  const port = createPort('bilibili-video-summary-chatgpt-proxy:req-1')
  onConnect.emit(port)
  port.onMessage.emit({
    type: 'GENERATE_TEXT',
    requestId: 'req-1',
    session: { question: 'private question' },
  })
  await nextTask()

  assert.deepEqual(port.posted, [{ requestId: 'req-1', error: 'MODEL_GATEWAY_PROVIDER_ERROR' }])
  assert.equal(JSON.stringify(logs).includes('private question'), false)
  assert.equal(JSON.stringify(logs).includes('private answer'), false)
})
