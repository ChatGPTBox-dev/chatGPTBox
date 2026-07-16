import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FETCH_REQUEST_FAILED,
  FETCH_RESPONSE_STREAM_FAILED,
  INVALID_API_ENDPOINT,
  fetchSSE,
} from '../../../src/utils/fetch-sse.mjs'
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
  assert.equal(errors[0].code, undefined)
  assert.equal(errors[0].requestOrigin, undefined)
  assert.equal(endCalled, false)
})

test('fetchSSE forwards fetch rejection errors to onError', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  const networkError = new TypeError('Failed to fetch')

  t.mock.method(globalThis, 'fetch', async () => {
    throw networkError
  })

  await fetchSSE('https://example.com:8443/reject?api_key=secret#fragment', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.equal(errors[0], networkError)
  assert.equal(errors[0].message, 'Failed to fetch')
  assert.equal(errors[0].code, FETCH_REQUEST_FAILED)
  assert.equal(errors[0].requestOrigin, 'https://example.com:8443')
})

test('fetchSSE wraps a frozen fetch rejection with transport metadata', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  const requestError = Object.freeze(new TypeError('Failed to fetch'))

  t.mock.method(globalThis, 'fetch', async () => {
    throw requestError
  })

  await fetchSSE('https://api.example.com/v1/chat/completions', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.notEqual(errors[0], requestError)
  assert.equal(errors[0].name, 'TypeError')
  assert.equal(errors[0].message, 'Failed to fetch')
  assert.equal(errors[0].code, FETCH_REQUEST_FAILED)
  assert.equal(errors[0].requestOrigin, 'https://api.example.com')
  assert.equal(errors[0].cause, requestError)
})

test('fetchSSE wraps an error when its request origin cannot be added', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  const requestError = new TypeError('Failed to fetch')
  requestError.code = 'E_NETWORK'
  Object.preventExtensions(requestError)

  t.mock.method(globalThis, 'fetch', async () => {
    throw requestError
  })

  await fetchSSE('https://api.example.com/v1/chat/completions', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.notEqual(errors[0], requestError)
  assert.equal(errors[0].name, 'TypeError')
  assert.equal(errors[0].message, 'Failed to fetch')
  assert.equal(errors[0].code, FETCH_REQUEST_FAILED)
  assert.equal(errors[0].requestOrigin, 'https://api.example.com')
  assert.equal(errors[0].cause, requestError)
})

test('fetchSSE wraps an error when a setter ignores its transport code', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  const requestError = new TypeError('Failed to fetch')
  Object.defineProperty(requestError, 'code', {
    get() {
      return 'E_NETWORK'
    },
    set() {},
  })

  t.mock.method(globalThis, 'fetch', async () => {
    throw requestError
  })

  await fetchSSE('https://api.example.com/v1/chat/completions', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.notEqual(errors[0], requestError)
  assert.equal(errors[0].code, FETCH_REQUEST_FAILED)
  assert.equal(errors[0].requestOrigin, 'https://api.example.com')
  assert.equal(errors[0].cause, requestError)
  assert.equal(requestError.code, 'E_NETWORK')
  assert.equal(requestError.requestOrigin, undefined)
})

test('fetchSSE classifies a malformed resource URL as an invalid API endpoint', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called')
  })

  await fetchSSE('not a valid URL', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, INVALID_API_ENDPOINT)
  assert.equal(errors[0].message, '')
  assert.equal(errors[0].requestOrigin, undefined)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('fetchSSE rejects unsupported and credentialed API endpoint URLs before fetch', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called')
  })
  const options = {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  }

  await fetchSSE('ftp://api.example.com/chat', options)
  await fetchSSE('https://user:secret@api.example.com/chat', options)

  assert.equal(errors.length, 2)
  assert.equal(
    errors.every((error) => error.code === INVALID_API_ENDPOINT),
    true,
  )
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('fetchSSE classifies a response stream read failure separately', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  const streamError = new TypeError('The network connection was lost.')

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            throw streamError
          },
        }
      },
    },
  }))

  await fetchSSE('https://api.example.com/v1/chat/completions', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.deepEqual(errors, [streamError])
  assert.equal(streamError.code, FETCH_RESPONSE_STREAM_FAILED)
  assert.equal(streamError.requestOrigin, 'https://api.example.com')
})

test('fetchSSE classifies a missing response body as a response stream failure', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    body: null,
  }))

  await fetchSSE('https://api.example.com/v1/chat/completions', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async () => {},
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, FETCH_RESPONSE_STREAM_FAILED)
  assert.equal(errors[0].requestOrigin, 'https://api.example.com')
})

test('fetchSSE treats an AbortError while reading as unclassified cancellation', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  let aborted = false
  const abortError = Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 20,
  })

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            throw abortError
          },
        }
      },
    },
  }))

  await fetchSSE('https://example.com/abort', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async (wasAborted) => {
      aborted = wasAborted
    },
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(aborted, true)
  assert.deepEqual(errors, [])
  assert.equal(abortError.code, 20)
  assert.equal(abortError.requestOrigin, undefined)
})

test('fetchSSE treats an AbortError before streaming as unclassified cancellation', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const consoleWarn = t.mock.method(console, 'warn', () => {})
  const errors = []
  let aborted = false
  const abortError = Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 20,
  })

  t.mock.method(globalThis, 'fetch', async () => {
    throw abortError
  })

  await fetchSSE('https://example.com/abort', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async (wasAborted) => {
      aborted = wasAborted
      throw new Error('cleanup failed')
    },
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(aborted, true)
  assert.deepEqual(errors, [])
  assert.equal(abortError.code, 20)
  assert.equal(abortError.requestOrigin, undefined)
  assert.equal(consoleWarn.mock.callCount(), 1)
})

test('fetchSSE treats a legacy DOMException abort code as unclassified cancellation', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  let aborted = false
  const abortError = new DOMException('The operation was canceled.', 'AbortError')
  Object.defineProperty(abortError, 'name', { value: 'TypeError' })

  t.mock.method(globalThis, 'fetch', async () => {
    throw abortError
  })

  await fetchSSE('https://example.com/abort', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async (wasAborted) => {
      aborted = wasAborted
    },
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(aborted, true)
  assert.deepEqual(errors, [])
  assert.equal(abortError.name, 'TypeError')
  assert.equal(abortError.code, DOMException.ABORT_ERR)
  assert.equal(abortError.requestOrigin, undefined)
})

test('fetchSSE does not treat a non-DOMException code 20 as cancellation', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const errors = []
  let aborted = false
  const requestError = Object.assign(new TypeError('Request failed'), { code: 20 })

  t.mock.method(globalThis, 'fetch', async () => {
    throw requestError
  })

  await fetchSSE('https://example.com/failure', {
    onStart: async () => {},
    onMessage: () => {},
    onEnd: async (wasAborted) => {
      aborted = wasAborted
    },
    onError: async (error) => {
      errors.push(error)
    },
  })

  assert.equal(aborted, false)
  assert.deepEqual(errors, [requestError])
  assert.equal(requestError.code, FETCH_REQUEST_FAILED)
  assert.equal(requestError.requestOrigin, 'https://example.com')
})

test('fetchSSE propagates onEnd errors on normal completion', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(['data: {"delta":"A"}\n\n']))

  await assert.rejects(
    fetchSSE('https://example.com/sse', {
      onStart: async () => {},
      onMessage: () => {},
      onEnd: async () => {
        throw new Error('done failed')
      },
      onError: async () => {},
    }),
    /done failed/,
  )
})

test('fetchSSE propagates onStart errors', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(['data: {"delta":"A"}\n\n']))
  const errors = []

  await assert.rejects(
    fetchSSE('https://example.com/sse', {
      onStart: async () => {
        throw new Error('start failed')
      },
      onMessage: () => {},
      onEnd: async () => {},
      onError: async (error) => {
        errors.push(error)
      },
    }),
    /start failed/,
  )
  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, 'start failed')
})

test('fetchSSE propagates onMessage errors', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(['data: {"delta":"A"}\n\n']))
  const errors = []

  await assert.rejects(
    fetchSSE('https://example.com/sse', {
      onStart: async () => {},
      onMessage: () => {
        throw new Error('message failed')
      },
      onEnd: async () => {},
      onError: async (error) => {
        errors.push(error)
      },
    }),
    /message failed/,
  )
  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, 'message failed')
})
