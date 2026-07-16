import assert from 'node:assert/strict'
import { test } from 'node:test'
import BingAIClient from '../../../../src/services/clients/bing/index.mjs'

function installFakeWebSocket(t) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  const instances = []

  class FakeWebSocket {
    constructor() {
      this.closeCalled = false
      this.sendCalled = false
      instances.push(this)
    }

    close() {
      this.closeCalled = true
    }

    send() {
      this.sendCalled = true
    }
  }

  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket,
    writable: true,
  })
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', originalDescriptor))
  return instances
}

test('BingAIClient reports an aborted request as AbortError', async () => {
  const ws = {
    closeCalled: false,
    close() {
      this.closeCalled = true
    },
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws
  const abortController = new AbortController()

  const response = client.sendMessage('hello', {
    abortController,
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  abortController.abort()

  await assert.rejects(response, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.message, 'Request aborted')
    return true
  })
  assert.equal(ws.closeCalled, true)
})

test('BingAIClient reports WebSocket failures as errors', async (t) => {
  t.mock.method(console, 'error', () => {})
  const ws = {
    close() {},
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  ws.onerror({ message: 'WebSocket handshake failed' })

  await assert.rejects(response, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket handshake failed')
    return true
  })
})

test('BingAIClient redacts access tokens from WebSocket failures', async (t) => {
  const loggedErrors = []
  t.mock.method(console, 'error', (error) => loggedErrors.push(error))
  const ws = {
    close() {},
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  ws.onerror({
    message:
      "WebSocket connection to 'wss://sydney.bing.com/sydney/ChatHub?sec_access_token=secret%2Btoken&foo=1' failed",
  })

  await assert.rejects(response, (error) => {
    assert.equal(error.message.includes('secret%2Btoken'), false)
    assert.equal(error.message.includes('sec_access_token=[REDACTED]&foo=1'), true)
    return true
  })
  assert.equal(loggedErrors.length, 1)
  assert.equal(loggedErrors[0].message.includes('secret%2Btoken'), false)
  assert.equal(loggedErrors[0].message.includes('sec_access_token=[REDACTED]&foo=1'), true)
})

test('BingAIClient uses close diagnostics after generic WebSocket failures', async (t) => {
  t.mock.method(console, 'error', () => {})
  const ws = {
    close() {},
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket closed with code 1006')
    return true
  })
  ws.onerror({ isTrusted: true })
  ws.onclose({ code: 1006 })

  await rejection
})

test('BingAIClient keeps user cancellation silent after a generic WebSocket failure', async (t) => {
  t.mock.method(console, 'error', () => {})
  const ws = {
    closeCalled: false,
    close() {
      this.closeCalled = true
    },
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws
  const abortController = new AbortController()

  const response = client.sendMessage('hello', {
    abortController,
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  ws.onerror({ isTrusted: true })
  abortController.abort()

  await assert.rejects(response, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.message, 'Request aborted')
    return true
  })
  assert.equal(ws.closeCalled, true)
})

test('BingAIClient aborts a pending WebSocket handshake', async (t) => {
  const sockets = installFakeWebSocket(t)
  const client = new BingAIClient({ features: { genImage: false } })
  const abortController = new AbortController()

  const response = client.sendMessage('hello', {
    abortController,
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  const ws = sockets[0]
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.message, 'Request aborted')
    return true
  })
  abortController.abort()

  await rejection
  assert.equal(ws.closeCalled, true)
  assert.equal(ws.sendCalled, false)
})

test('BingAIClient uses close diagnostics after generic WebSocket handshake failures', async (t) => {
  const sockets = installFakeWebSocket(t)
  const client = new BingAIClient({ features: { genImage: false } })

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket closed with code 1006')
    return true
  })
  sockets[0].onerror({ isTrusted: true })
  sockets[0].onclose({ code: 1006 })

  await rejection
})

test('BingAIClient redacts access tokens from WebSocket handshake failures', async (t) => {
  const sockets = installFakeWebSocket(t)
  const client = new BingAIClient({ features: { genImage: false } })

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error.message.includes('handshake-secret'), false)
    assert.equal(error.message.includes('sec_access_token=[REDACTED]'), true)
    return true
  })
  sockets[0].onerror({
    message:
      "WebSocket connection to 'wss://sydney.bing.com/sydney/ChatHub?sec_access_token=handshake-secret' failed",
  })

  await rejection
  assert.equal(sockets[0].closeCalled, true)
})

test('BingAIClient rejects WebSocket closes during the handshake', async (t) => {
  const sockets = installFakeWebSocket(t)
  const client = new BingAIClient({ features: { genImage: false } })

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket closed with code 1006')
    return true
  })
  sockets[0].onclose({ code: 1006 })

  await rejection
})

test('BingAIClient times out a pending WebSocket handshake', async (t) => {
  const sockets = installFakeWebSocket(t)
  const handshakeTimeout = {}
  let timeoutCallback
  let clearedTimeout
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    timeoutCallback = callback
    return handshakeTimeout
  })
  t.mock.method(globalThis, 'clearTimeout', (timeout) => {
    clearedTimeout = timeout
  })
  const client = new BingAIClient({ features: { genImage: false } })

  const connection = client.createWebSocketConnection('signature')
  const rejection = assert.rejects(connection, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'Timed out waiting for WebSocket handshake.')
    return true
  })
  timeoutCallback()

  await rejection
  assert.equal(clearedTimeout, handshakeTimeout)
  assert.equal(sockets[0].closeCalled, true)
})

test('BingAIClient preserves WebSocket close diagnostics', async (t) => {
  const sockets = installFakeWebSocket(t)
  const client = new BingAIClient({ features: { genImage: false } })

  const connection = client.createWebSocketConnection('signature')
  const rejection = assert.rejects(connection, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket closed with code 1011: upstream overloaded')
    return true
  })
  sockets[0].onclose({ code: 1011, reason: 'upstream overloaded' })

  await rejection
})

test('BingAIClient rejects unexpected WebSocket closes after the handshake', async () => {
  const ws = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1
    },
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws
  const abortController = new AbortController()

  const response = client.sendMessage('hello', {
    abortController,
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket closed with code 1006')
    return true
  })
  ws.onclose({ code: 1006 })

  await rejection
  abortController.abort()
  assert.equal(ws.closeCalls, 0)
})

test('BingAIClient clears the ping interval after an unexpected WebSocket close', async (t) => {
  const sockets = installFakeWebSocket(t)
  const pingInterval = {}
  let clearedInterval
  t.mock.method(globalThis, 'setInterval', () => pingInterval)
  t.mock.method(globalThis, 'clearInterval', (interval) => {
    clearedInterval = interval
  })
  const client = new BingAIClient({ features: { genImage: false } })
  const connection = client.createWebSocketConnection('signature')
  const ws = sockets[0]
  ws.onopen()
  ws.onmessage({ data: '{}\x1e' })
  await connection
  client.createWebSocketConnection = async () => ws

  const response = client.sendMessage('hello', {
    abortController: new AbortController(),
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  const rejection = assert.rejects(response, (error) => {
    assert.equal(error.name, 'Error')
    assert.equal(error.message, 'WebSocket closed with code 1006')
    return true
  })
  ws.onclose({ code: 1006 })

  await rejection
  assert.equal(clearedInterval, pingInterval)
  assert.equal(ws.closeCalled, false)
})

test('BingAIClient removes abort cleanup after a successful response', async () => {
  const ws = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1
      this.onclose?.({ code: 1000 })
    },
    send() {},
  }
  const client = new BingAIClient({ features: { genImage: false } })
  client.createWebSocketConnection = async () => ws
  const abortController = new AbortController()

  const response = client.sendMessage('hello', {
    abortController,
    clientId: 'client-id',
    conversationId: 'conversation-id',
    encryptedConversationSignature: 'signature',
  })
  await Promise.resolve()
  const message = {
    adaptiveCards: [{ body: [{ text: 'hello' }] }],
    author: 'bot',
    text: 'hello',
  }
  ws.onmessage({
    data: `${JSON.stringify({
      item: { messages: [message] },
      type: 2,
    })}\x1e`,
  })

  const result = await response
  abortController.abort()

  assert.equal(result.response, 'hello')
  assert.equal(ws.closeCalls, 1)
})
