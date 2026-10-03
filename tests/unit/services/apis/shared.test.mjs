import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acknowledgePortStop,
  pushRecord,
  setAbortController,
} from '../../../../src/services/apis/shared.mjs'
import { createFakePort } from '../../helpers/port.mjs'

test('pushRecord appends a new record in normal mode', () => {
  const session = {
    isRetry: false,
    conversationRecords: [],
  }

  pushRecord(session, 'Q1', 'A1')

  assert.deepEqual(session.conversationRecords, [{ question: 'Q1', answer: 'A1' }])
})

test('pushRecord overwrites last answer when retrying same question', () => {
  const session = {
    isRetry: true,
    conversationRecords: [{ question: 'Q1', answer: 'Old' }],
  }

  pushRecord(session, 'Q1', 'New')

  assert.equal(session.conversationRecords.length, 1)
  assert.deepEqual(session.conversationRecords[0], { question: 'Q1', answer: 'New' })
})

test('pushRecord appends when retry question differs from last one', () => {
  const session = {
    isRetry: true,
    conversationRecords: [{ question: 'Q1', answer: 'A1' }],
  }

  pushRecord(session, 'Q2', 'A2')

  assert.equal(session.conversationRecords.length, 2)
  assert.deepEqual(session.conversationRecords[1], { question: 'Q2', answer: 'A2' })
})

test('setAbortController aborts and cleans listeners on stop message', (t) => {
  t.mock.method(console, 'debug', () => {})
  const port = createFakePort()
  let onStopCalled = 0

  const { controller } = setAbortController(port, () => {
    onStopCalled += 1
  })

  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })

  port.emitMessage({ stop: true })

  assert.equal(controller.signal.aborted, true)
  assert.equal(onStopCalled, 1)
  assert.deepEqual(port.postedMessages, [{ done: true }])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 1 })
})

test('setAbortController echoes a retry stop generation id', (t) => {
  t.mock.method(console, 'debug', () => {})
  const port = createFakePort()
  const { getStopGenerationId } = setAbortController(port)

  port.emitMessage({ stop: true, stopGenerationId: 7 })

  assert.deepEqual(port.postedMessages, [{ done: true, stoppedGenerationId: 7 }])
  assert.equal(getStopGenerationId(), 7)
})

test('acknowledgePortStop posts only once for the current session request', () => {
  const port = createFakePort()
  const message = { stop: true, stopGenerationId: 7 }

  assert.equal(acknowledgePortStop(port, message), true)
  assert.equal(acknowledgePortStop(port, message), false)
  assert.equal(message.stopAcknowledged, true)
  assert.deepEqual(port.postedMessages, [{ done: true, stoppedGenerationId: 7 }])
})

test('acknowledgePortStop respects an acknowledgement from an upstream port', () => {
  const port = createFakePort()

  assert.equal(acknowledgePortStop(port, { stop: true, stopAcknowledged: true }), false)
  assert.deepEqual(port.postedMessages, [])
})

test('setAbortController aborts on disconnect and removes disconnect listener', (t) => {
  t.mock.method(console, 'debug', () => {})
  const port = createFakePort()
  let onDisconnectCalled = 0

  const { controller } = setAbortController(port, null, () => {
    onDisconnectCalled += 1
  })

  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })

  port.emitDisconnect()

  assert.equal(controller.signal.aborted, true)
  assert.equal(onDisconnectCalled, 1)
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 0 })
})

test('setAbortController ignores non-stop messages', (t) => {
  t.mock.method(console, 'debug', () => {})
  const port = createFakePort()
  let onStopCalled = 0

  const { controller } = setAbortController(port, () => {
    onStopCalled += 1
  })

  port.emitMessage({ stop: false })
  port.emitMessage({ foo: 'bar' })

  assert.equal(controller.signal.aborted, false)
  assert.equal(onStopCalled, 0)
  assert.deepEqual(port.postedMessages, [])
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })
})

test('setAbortController cleanController removes listeners safely', (t) => {
  t.mock.method(console, 'debug', () => {})
  const port = createFakePort()
  const { cleanController } = setAbortController(port)

  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })

  cleanController()
  cleanController()

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
