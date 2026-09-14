import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { Server } from 'node:http'
import {
  assertPopupIdentity,
  assertScenarioMessages,
  beginRequest,
  disconnectPorts,
  runScenarios,
  snapshot,
} from '../../../scripts/smoke/scenarios.mjs'
import { createLifecycle } from '../../../scripts/smoke/lifecycle.mjs'

for (const { name, primaryFailure = false, corruptContext } of [
  { name: 'scenario cleanup retains all failures with a primary error', primaryFailure: true },
  { name: 'scenario cleanup retains all failures without a primary error' },
  ...['missing', 'reordered', 'corrupted', 'extra success'].map((corruptContext) => ({
    name: `runScenarios rejects ${corruptContext} outbound context and cleans up`,
    corruptContext,
  })),
]) {
  test(name, async (t) => {
    const lifecycle = createLifecycle()
    t.after(() => lifecycle.cleanup())
    const primary = new Error('PRIMARY_CONFIGURATION_FAILURE')
    const disconnectFailure = new Error('SECONDARY_DISCONNECT_FAILURE')
    const closeFailure = new Error('SECONDARY_SERVER_CLOSE_FAILURE')
    const cleanupCalls = []
    const close = Server.prototype.close
    t.mock.method(Server.prototype, 'close', function (callback) {
      cleanupCalls.push('close')
      return close.call(this, (error) => callback(error || closeFailure))
    })
    const metadata = {
      expectedName: 'ChatGPTBox',
      expectedVersion: '2.7.0',
      extensionId: 'smoke-extension',
      popupUrl: 'moz-extension://smoke-uuid/popup.html',
    }
    let baseUrl
    let completed = false
    let streamed
    let disconnectAttempts = 0
    const adapter = {
      metadata,
      evaluateCleanup(fn, ...args) {
        return this.evaluate(fn, ...args)
      },
      async evaluate(fn, ...args) {
        if (fn.name === 'popupIdentity')
          return {
            visible: true,
            name: metadata.expectedName,
            version: metadata.expectedVersion,
            extensionId: metadata.extensionId,
            popupUrl: metadata.popupUrl,
            location: metadata.popupUrl,
          }
        if (fn.name === 'configure') {
          if (primaryFailure) throw primary
          baseUrl = args[0]
          return
        }
        if (fn.name === 'disconnectPorts') {
          cleanupCalls.push('disconnect')
          if (++disconnectAttempts === 1) throw disconnectFailure
          return
        }
        if (fn.name === 'beginRequest') {
          const [key, question, history] = args
          let messages = [
            ...history.flatMap(({ question, answer }) => [
              { role: 'user', content: question },
              { role: 'assistant', content: answer },
            ]),
            { role: 'user', content: question },
          ]
          if (key === 'error') {
            if (corruptContext === 'missing') messages = messages.slice(-1)
            if (corruptContext === 'reordered') {
              messages = [messages[1], messages[0], messages[2]]
            }
            if (corruptContext === 'corrupted') messages[1].content = 'Hello 世界�'
          } else if (corruptContext === 'extra success') {
            messages.unshift({ role: 'user', content: 'Unexpected previous question' })
          }
          const response = await globalThis.fetch(`${baseUrl}/${key}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer smoke-local-only',
            },
            body: JSON.stringify({
              model: 'smoke-model',
              stream: true,
              messages,
            }),
            signal: globalThis.AbortSignal.timeout(5000),
          })
          if (key === 'success') {
            streamed = response.text().then(() => {
              completed = true
            })
            streamed.catch(() => {})
          } else await response.text()
          return
        }
        if (fn.name === 'snapshot') {
          const history = [{ question: 'Smoke success question', answer: 'Hello 世界🙂' }]
          if (args[0] === 'error') return [session(history), { error: 'smoke_503' }]
          return completed
            ? [
                session([]),
                { answer: 'Hello ', done: false },
                { answer: 'Hello 世界🙂', done: false },
                { ...session(history), answer: null, done: true },
              ]
            : [session([]), { answer: 'Hello ', done: false }]
        }
        throw new Error(`Unexpected evaluation: ${fn.name}`)
      },
    }
    const checks = []
    let reported
    await assert.rejects(runScenarios(adapter, { lifecycle, checks }), (error) => {
      reported = error
      if (primaryFailure) assert.equal(error, primary)
      else if (corruptContext) {
        assert.ok(error instanceof assert.AssertionError)
        assert.equal(error.code, 'ERR_ASSERTION')
        assert.equal(error.operator, 'deepStrictEqual')
        const expected = [{ role: 'user', content: 'Smoke success question' }]
        if (corruptContext !== 'extra success') {
          expected.push(
            { role: 'assistant', content: 'Hello 世界🙂' },
            { role: 'user', content: 'Smoke error question' },
          )
        }
        assert.deepEqual(error.expected, expected)
        assert.notDeepEqual(error.actual, expected)
        assert.equal(checks.length, 4)
      } else {
        assert.ok(error instanceof AggregateError)
        assert.deepEqual(error.errors, [disconnectFailure, closeFailure])
        assert.equal(checks.length, 4)
      }
      assert.deepEqual(error.cleanupErrors, [disconnectFailure, closeFailure])
      assert.ok(error.cleanupErrors.every((failure) => failure instanceof Error))
      return true
    })
    assert.deepEqual(cleanupCalls, ['disconnect', 'close'])
    await streamed
    await lifecycle.cleanup()
    assert.equal(
      disconnectAttempts,
      2,
      'A later successful disconnect retry must not erase its first failure',
    )
    assert.deepEqual(reported.cleanupErrors, [disconnectFailure, closeFailure])
  })
}

test('request state survives fresh evaluation sandboxes sharing the popup window', () => {
  const window = {}
  let onMessage
  let disconnected = 0
  const sent = []
  const port = {
    onMessage: {
      addListener: (listener) => {
        onMessage = listener
      },
    },
    onDisconnect: { addListener() {} },
    postMessage: (message) => sent.push(message),
    disconnect: () => disconnected++,
  }
  const browser = { runtime: { connect: () => port } }
  const evaluate = (fn, ...args) =>
    runInNewContext(`(${fn.toString()})(...args)`, {
      window,
      browser,
      args,
    })
  evaluate(beginRequest, 'success', 'Question', [])
  assert.equal(sent.length, 1)
  onMessage({ answer: 'Hello ', done: false })
  assert.equal(evaluate(snapshot, 'success')[0].answer, 'Hello ')
  onMessage({ answer: 'Hello 世界🙂', done: false })
  assert.equal(evaluate(snapshot, 'success')[1].answer, 'Hello 世界🙂')
  assert.throws(() => evaluate(beginRequest, 'success', 'Duplicate', []), /already started/)
  assert.equal(sent.length, 1)
  evaluate(disconnectPorts)
  assert.equal(disconnected, 1)
  assert.equal(window.__chatGPTBoxSmoke, undefined)
  evaluate(disconnectPorts)
  assert.equal(disconnected, 1)
})

test('a failed scenario preserves completed checks in the caller array and disconnects ports', async (t) => {
  const lifecycle = createLifecycle()
  t.after(async () => assert.deepEqual(await lifecycle.cleanup(), []))
  const checks = ['Existing runner check']
  const failure = new Error('Configuration write failed')
  const metadata = {
    expectedName: 'ChatGPTBox',
    expectedVersion: '2.7.0',
    extensionId: 'smoke-extension',
    popupUrl: 'moz-extension://smoke-uuid/popup.html',
  }
  const calls = []
  const adapter = {
    metadata,
    evaluateCleanup(fn, ...args) {
      return this.evaluate(fn, ...args)
    },
    async evaluate(fn) {
      calls.push(fn.name)
      if (fn.name === 'popupIdentity') {
        return {
          visible: true,
          name: metadata.expectedName,
          version: metadata.expectedVersion,
          extensionId: metadata.extensionId,
          popupUrl: metadata.popupUrl,
          location: metadata.popupUrl,
        }
      }
      if (fn.name === 'disconnectPorts') return
      throw failure
    },
  }
  await assert.rejects(runScenarios(adapter, { lifecycle, checks }), (error) => error === failure)
  assert.deepEqual(checks, [
    'Existing runner check',
    'Installed popup visible with matching runtime identity and version',
  ])
  assert.deepEqual(calls, ['popupIdentity', 'configure', 'disconnectPorts'])
})

test('popup identity uses the adapter installation manifest and rejects mismatches or missing expectations', () => {
  const metadata = {
    expectedName: 'ChatGPTBox',
    expectedVersion: '2.7.0',
    extensionId: 'smoke-extension',
    popupUrl: 'moz-extension://smoke-uuid/popup.html',
  }
  const identity = {
    name: metadata.expectedName,
    version: metadata.expectedVersion,
    extensionId: metadata.extensionId,
    popupUrl: metadata.popupUrl,
    location: metadata.popupUrl,
    visible: true,
  }
  assertPopupIdentity(identity, metadata)
  for (const override of [
    { name: 'Wrong extension' },
    { version: '0.0.0' },
    { extensionId: 'other-extension' },
    { location: 'https://example.com/' },
    { visible: false },
  ]) {
    assert.throws(() => assertPopupIdentity({ ...identity, ...override }, metadata))
  }
  for (const key of Object.keys(metadata)) {
    assert.throws(() => assertPopupIdentity(identity, { ...metadata, [key]: undefined }))
  }
})

const question = 'Smoke success question'
const history = [{ question: 'Previous question', answer: 'Previous answer' }]
const session = (records) => ({ session: { conversationRecords: records } })
const partial = [session(history), { answer: 'Hello ', done: false }]
const completed = [
  ...partial,
  { answer: 'Hello 世界🙂', done: false },
  { ...session([...history, { question, answer: 'Hello 世界🙂' }]), answer: null, done: true },
]
const failure = [session(history), { error: '{"error":{"code":"smoke_503"}}' }]

test('scenario assertions accept partial, final, and HTTP failure messages', () => {
  assertScenarioMessages(partial, { phase: 'partial', question, history })
  assertScenarioMessages(completed, { phase: 'final', question, history })
  assertScenarioMessages(failure, { phase: 'error', question, history })
})

test('partial proof rejects completion before release and incorrect first answers', () => {
  for (const messages of [
    completed,
    [session(history), { answer: 'Hello 世界🙂' }],
    [session(history)],
  ]) {
    assert.throws(() => assertScenarioMessages(messages, { phase: 'partial', question, history }))
  }
})

test('partial proof requires one unchanged session acknowledgement before the answer', () => {
  for (const messages of [
    [partial[1]],
    [partial[1], partial[0]],
    [partial[0], partial[0], partial[1]],
    [{ ...partial[0], ...partial[1] }],
    [session([]), partial[1]],
  ]) {
    assert.throws(() => assertScenarioMessages(messages, { phase: 'partial', question, history }))
  }
})

test('final proof rejects duplicate completion, corrupted Unicode, and duplicate history', () => {
  const duplicateHistory = {
    ...session([
      ...history,
      { question, answer: 'Hello 世界🙂' },
      { question, answer: 'Hello 世界🙂' },
    ]),
    done: true,
  }
  for (const messages of [
    [...completed, completed.at(-1)],
    [...partial, { answer: 'Hello 世界�' }, completed.at(-1)],
    [...completed.slice(0, -1), duplicateHistory],
    partial,
  ]) {
    assert.throws(() => assertScenarioMessages(messages, { phase: 'final', question, history }))
  }
})

test('final proof preserves the initial acknowledgement and completion ordering', () => {
  for (const messages of [
    [...completed.slice(0, -1), session(history), completed.at(-1)],
    [...completed.slice(0, -1), session([]), completed.at(-1)],
    [session([]), ...completed.slice(1)],
    [...partial, completed.at(-1), completed[2]],
    [...partial, { ...completed.at(-1), answer: 'Hello 世界🙂' }],
    [...completed.slice(0, -1), { ...completed.at(-1), answer: undefined }],
  ]) {
    assert.throws(() => assertScenarioMessages(messages, { phase: 'final', question, history }))
  }
})

test('HTTP failure requires one standalone acknowledgement before the error', () => {
  for (const messages of [
    [failure[1]],
    [failure[1], failure[0]],
    [failure[0], failure[0], failure[1]],
    [{ ...failure[0], ...failure[1] }],
  ]) {
    assert.throws(() => assertScenarioMessages(messages, { phase: 'error', question, history }))
  }
})

test('HTTP failure proof rejects false success, unrelated errors, and modified history', () => {
  for (const messages of [
    [...failure, { done: true }],
    [...failure, { answer: 'unexpected' }],
    [...failure, session([...history, { question, answer: '' }])],
    [session(history), { error: 'Unexpected provider failure' }],
    [session([]), failure[1]],
  ]) {
    assert.throws(() => assertScenarioMessages(messages, { phase: 'error', question, history }))
  }
})

test('answer sequences reject corruption, duplication, omission and reordering before a valid final answer', () => {
  for (const answers of [
    ['wrong', 'Hello 世界🙂'],
    ['Hello ', 'corrupt', 'Hello 世界🙂'],
    ['Hello ', 42, 'Hello 世界🙂'],
    ['Hello ', 'Hello ', 'Hello 世界🙂'],
    ['Hello ', 'Hello 世界🙂', 'Hello 世界🙂'],
    ['Hello 世界🙂', 'Hello ', 'Hello 世界🙂'],
    ['Hello 世界🙂'],
  ]) {
    assert.throws(() =>
      assertScenarioMessages(
        [session(history), ...answers.map((answer) => ({ answer, done: false })), completed.at(-1)],
        { phase: 'final', question, history },
      ),
    )
  }
  for (const answers of [
    ['bad', 'Hello '],
    ['Hello ', 'Hello '],
  ]) {
    assert.throws(() =>
      assertScenarioMessages(
        answers.map((answer) => ({ answer })),
        { phase: 'partial', question, history },
      ),
    )
  }
})

test('scenario cancellation uses independent cleanup and successful disconnect is idempotent', async (t) => {
  const controller = new AbortController()
  const lifecycle = createLifecycle({ signal: controller.signal })
  t.after(() => lifecycle.cleanup())
  const reason = new Error('Cancelled during configuration')
  let disconnects = 0
  const metadata = {
    expectedName: 'Fixture',
    expectedVersion: '1',
    extensionId: 'fixture',
    popupUrl: 'moz-extension://fixture/popup.html',
  }
  const adapter = {
    metadata,
    async evaluate(fn) {
      controller.signal.throwIfAborted()
      if (fn.name === 'popupIdentity')
        return {
          visible: true,
          name: metadata.expectedName,
          version: metadata.expectedVersion,
          extensionId: metadata.extensionId,
          popupUrl: metadata.popupUrl,
          location: metadata.popupUrl,
        }
      assert.equal(fn.name, 'configure')
      controller.abort(reason)
      throw reason
    },
    async evaluateCleanup(fn) {
      assert.equal(controller.signal.aborted, true)
      assert.equal(fn, disconnectPorts)
      disconnects++
    },
  }
  await assert.rejects(runScenarios(adapter, { lifecycle, signal: controller.signal }), (error) => {
    assert.equal(error, reason)
    assert.equal(error.cleanupErrors, undefined)
    return true
  })
  assert.deepEqual(await lifecycle.cleanup(), [])
  assert.equal(disconnects, 1)
})
