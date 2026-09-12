import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TextDecoder } from 'node:util'
import { startMockServer } from '../../../scripts/smoke/mock-server.mjs'

async function setup(t) {
  const cleanups = []
  const mock = await startMockServer({
    lifecycle: { defer: (label, cleanup) => cleanups.push({ label, cleanup }) },
  })
  assert.equal(cleanups.length, 1)
  t.after(() => cleanups[0].cleanup())
  return mock
}

function post(mock, path, body = { model: 'smoke-model', stream: true, messages: [] }) {
  return globalThis.fetch(mock.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer smoke-local-only' },
    body: JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(5000),
  })
}

test(
  'mock gates the remainder until a client has observed the complete first event',
  { timeout: 10000 },
  async (t) => {
    const mock = await setup(t)
    assert.match(mock.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await post(mock, '/success/v1/chat/completions')
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('\r\n\r\n')) {
      const part = await reader.read()
      assert.equal(part.done, false)
      text += decoder.decode(part.value, { stream: true })
    }
    assert.match(text, /Hello /)
    assert.doesNotMatch(text, /世界|DONE/)
    const waiting = reader.read()
    assert.equal(await Promise.race([waiting, delay(30, 'still gated')]), 'still gated')
    mock.release()
    let part = await waiting
    while (!part.done) {
      text += decoder.decode(part.value, { stream: true })
      part = await reader.read()
    }
    text += decoder.decode()
    const events = text
      .split('\r\n\r\n')
      .filter(Boolean)
      .map((line) => line.slice(6))
    assert.equal(events.length, 3)
    assert.equal(JSON.parse(events[0]).choices[0].delta.content, 'Hello ')
    assert.equal(JSON.parse(events[1]).choices[0].delta.content, '世界🙂')
    assert.equal(events[2], '[DONE]')
    assert.equal(mock.requests.length, 1)
    assert.equal(mock.requests[0].status, 200)
    await mock.close()
    await mock.close()
  },
)

test('mock reports HTTP 503 and records the Chat Completions body', async (t) => {
  const mock = await setup(t)
  const response = await post(mock, '/error/v1/chat/completions')
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: { message: 'Smoke upstream unavailable', code: 'smoke_503' },
  })
  assert.deepEqual(mock.requests, [
    {
      method: 'POST',
      path: '/error/v1/chat/completions',
      body: { model: 'smoke-model', stream: true, messages: [] },
      status: 503,
    },
  ])
})

test('mock rejects a Responses endpoint and invalid Chat Completions payload', async (t) => {
  const mock = await setup(t)
  for (const [path, body, status] of [
    ['/v1/responses', {}, 404],
    ['/success/v1/chat/completions', { input: 'wrong API' }, 400],
  ]) {
    const response = await post(mock, path, body)
    assert.equal(response.status, status)
    await response.text()
  }
})

test(
  'cleanup closes an unreleased response and its listening socket',
  { timeout: 10000 },
  async (t) => {
    const mock = await setup(t)
    const response = await post(mock, '/success/v1/chat/completions')
    const consumed = response.text().then(
      () => 'ended',
      () => 'closed',
    )
    await mock.close()
    assert.equal(await consumed, 'closed')
    await assert.rejects(post(mock, '/error/v1/chat/completions'))
  },
)

test('an already aborted startup allocates no server', async () => {
  let registrations = 0
  await assert.rejects(
    startMockServer({
      lifecycle: { defer: () => registrations++ },
      signal: globalThis.AbortSignal.abort(new Error('cancelled')),
    }),
    /cancelled/,
  )
  assert.equal(registrations, 0)
})
