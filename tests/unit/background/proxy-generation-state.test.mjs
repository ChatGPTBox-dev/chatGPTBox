import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearProxyReconnectErrorSuppression,
  consumeProxyReconnectErrorSuppression,
  forwardProxyMessage,
  interruptProxyGeneration,
  isCurrentProxyGenerationMessage,
  markProxyGenerationFinished,
  markProxyGenerationFinishedFromMessage,
  markProxyGenerationStarted,
  shouldSkipProxyReconnect,
  tagProxyRequestGeneration,
} from '../../../src/background/proxy-generation-state.mjs'

test('only the current proxy generation can update generation state', () => {
  const port = {
    proxy: {
      postMessage() {},
    },
  }
  markProxyGenerationStarted(port, 2, 5)

  assert.equal(isCurrentProxyGenerationMessage(port, { done: true, proxyGenerationId: 2 }), true)
  assert.deepEqual(tagProxyRequestGeneration(port, { done: true }), {
    done: true,
    requestGenerationId: 5,
  })
  assert.equal(isCurrentProxyGenerationMessage(port, { done: true, proxyGenerationId: 1 }), false)
  assert.equal(
    markProxyGenerationFinishedFromMessage(port, { done: true, proxyGenerationId: 1 }),
    false,
  )
  assert.equal(port._generating, true)
  assert.equal(isCurrentProxyGenerationMessage(port, { done: true }), false)
  assert.equal(isCurrentProxyGenerationMessage(port, { done: true, stoppedGenerationId: 1 }), true)

  forwardProxyMessage(port, { stop: true })

  assert.equal(isCurrentProxyGenerationMessage(port, { done: true, proxyGenerationId: 2 }), false)
})

test('interrupted generation suppresses only its next reconnect error', () => {
  const port = {}

  markProxyGenerationStarted(port)

  assert.equal(interruptProxyGeneration(port), true)
  assert.equal(port._generating, false)
  assert.equal(interruptProxyGeneration(port), false)
  assert.equal(consumeProxyReconnectErrorSuppression(port), true)
  assert.equal(consumeProxyReconnectErrorSuppression(port), false)
})

test('retry stop messages do not finish the replacement generation', () => {
  const port = {}

  for (const message of [
    { done: true, stoppedGenerationId: 3 },
    { error: 'stopped', stoppedGenerationId: 3 },
  ]) {
    markProxyGenerationStarted(port)

    assert.equal(markProxyGenerationFinishedFromMessage(port, message), false)
    assert.equal(port._generating, true)
  }
})

test('retry stop finishes the old generation before its acknowledgement arrives', () => {
  const postedMessages = []
  const port = {
    proxy: {
      postMessage(message) {
        postedMessages.push(message)
      },
    },
  }

  markProxyGenerationStarted(port)
  forwardProxyMessage(port, { stop: true, stopGenerationId: 3 })

  assert.deepEqual(postedMessages, [{ stop: true, stopGenerationId: 3 }])
  assert.equal(port._generating, false)
  assert.equal(
    markProxyGenerationFinishedFromMessage(port, {
      done: true,
      stoppedGenerationId: 3,
    }),
    false,
  )
  assert.equal(port._generating, false)
})

test('failed retry stop forwarding still interrupts the old generation', () => {
  const port = {
    proxy: {
      postMessage() {
        throw new Error('disconnected')
      },
    },
  }

  markProxyGenerationStarted(port)

  assert.throws(
    () => forwardProxyMessage(port, { stop: true, stopGenerationId: 3 }),
    /disconnected/,
  )
  assert.equal(port._generating, false)
  assert.equal(consumeProxyReconnectErrorSuppression(port), true)
})

test('forwardProxyMessage preserves an upstream stop acknowledgement across the proxy', () => {
  const postedMessages = []
  const port = {
    _stopAcknowledged: true,
    proxy: {
      postMessage(message) {
        postedMessages.push(message)
      },
    },
  }

  markProxyGenerationStarted(port)
  forwardProxyMessage(port, { stop: true })

  assert.deepEqual(postedMessages, [{ stop: true, stopAcknowledged: true }])
  assert.equal(port._generating, false)
  assert.equal(consumeProxyReconnectErrorSuppression(port), true)
})

test('forwarded stop preserves reconnect error suppression from an interrupted generation', () => {
  const port = {
    proxy: {
      postMessage() {},
    },
  }

  markProxyGenerationStarted(port)
  interruptProxyGeneration(port)
  forwardProxyMessage(port, { stop: true })

  assert.equal(port._generating, false)
  assert.equal(consumeProxyReconnectErrorSuppression(port), true)
})

test('normal completion and errors finish the active proxy generation', () => {
  for (const message of [{ done: true }, { error: 'failed' }]) {
    const port = {}
    markProxyGenerationStarted(port)

    assert.equal(markProxyGenerationFinishedFromMessage(port, message), true)
    assert.equal(port._generating, false)
  }
})

test('new generation clears reconnect error suppression from an interrupted generation', () => {
  const port = {}

  markProxyGenerationStarted(port)
  interruptProxyGeneration(port)
  markProxyGenerationStarted(port)

  assert.equal(port._generating, true)
  assert.equal(consumeProxyReconnectErrorSuppression(port), false)
})

test('stable reconnect and normal completion clear reconnect error suppression', () => {
  const port = {}

  markProxyGenerationStarted(port)
  interruptProxyGeneration(port)
  clearProxyReconnectErrorSuppression(port)
  assert.equal(consumeProxyReconnectErrorSuppression(port), false)

  markProxyGenerationStarted(port)
  interruptProxyGeneration(port)
  markProxyGenerationFinished(port)
  assert.equal(port._generating, false)
  assert.equal(consumeProxyReconnectErrorSuppression(port), false)
})

test('active or closed ports skip stale reconnect callbacks', () => {
  assert.equal(shouldSkipProxyReconnect({}), false)
  assert.equal(shouldSkipProxyReconnect({ proxy: {} }), true)
  assert.equal(shouldSkipProxyReconnect({ _isClosed: true }), true)
})
