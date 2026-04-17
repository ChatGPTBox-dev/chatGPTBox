import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchSSE } from '../../../src/utils/fetch-sse.mjs'
import { createMockSseResponse } from '../helpers/sse-response.mjs'

test('fetchSSE streams SSE chunks and calls lifecycle callbacks', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const starts = []
  const messages = []
  const errors = []
  let endCount = 0

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse(['data: {"delta":"A"}\n\n', 'data: [DONE]\n\n']),
  )

  await fetchSSE('https://example.com/sse', {
    method: 'POST',
    onStart: async (chunkText) => {
      starts.push(chunkText)
    },
    onMessage: (message) => {
      messages.push(message)
    },
    onEnd: async () => {
      endCount += 1
    },
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(starts.length, 1)
  assert.equal(starts[0], 'data: {"delta":"A"}\n\n')
  assert.deepEqual(messages, ['{"delta":"A"}', '[DONE]'])
  assert.equal(endCount, 1)
  assert.equal(errors.length, 0)
})

test('fetchSSE converts a plain JSON first chunk into fake SSE data', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const messages = []
  let startedWith = ''
  let endCount = 0

  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(['{"answer":"ok"}']))

  await fetchSSE('https://example.com/json', {
    onStart: async (chunkText) => {
      startedWith = chunkText
    },
    onMessage: (message) => {
      messages.push(message)
    },
    onEnd: async () => {
      endCount += 1
    },
    onError: async () => {},
  })

  assert.equal(startedWith, '{"answer":"ok"}')
  assert.deepEqual(messages, ['{"answer":"ok"}', '[DONE]'])
  assert.equal(endCount, 1)
})

test('fetchSSE forwards non-ok responses to onError', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  let endCalled = false

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }),
  )

  await fetchSSE('https://example.com/error', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {
      endCalled = true
    },
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.equal(errors[0].status, 503)
  assert.equal(endCalled, false)
})

test('fetchSSE forwards fetch rejection errors to onError', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down')
  })

  await fetchSSE('https://example.com/reject', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, 'network down')
})
