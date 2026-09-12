import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'
import { test } from 'node:test'
import {
  FETCH_JSON_RESPONSE_TOO_LARGE,
  fetchSSE,
} from '../../../src/utils/fetch-sse.mjs'

const encoder = new TextEncoder()

test('fetchSSE cancels and releases the reader when parser processing throws', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const consoleWarn = t.mock.method(console, 'warn', () => {})
  const callbackError = new Error('message failed')
  let readCount = 0
  let cancelCount = 0
  let releaseCount = 0
  let endCount = 0
  const errors = []

  const reader = {
    async read() {
      if (readCount++ === 0) {
        return { done: false, value: encoder.encode('data: hello\n\n') }
      }
      return { done: true, value: undefined }
    },
    async cancel() {
      cancelCount += 1
      throw new Error('reader cancellation failed')
    },
    releaseLock() {
      releaseCount += 1
    },
  }

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    body: {
      getReader() {
        return reader
      },
    },
  }))

  await assert.rejects(
    fetchSSE('https://example.com/sse', {
      onStart: async () => {},
      onMessage: () => {
        throw callbackError
      },
      onEnd: async () => {
        endCount += 1
      },
      onError: async (error) => {
        errors.push(error)
      },
    }),
    callbackError,
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(errors, [callbackError])
  assert.equal(cancelCount, 1)
  assert.equal(releaseCount, 1)
  assert.equal(endCount, 0)
  assert.equal(consoleWarn.mock.callCount(), 1)
})

test('fetchSSE preserves callback errors when onError and reader cleanup also throw', async (t) => {
  for (const callback of ['onStart', 'onMessage']) {
    await t.test(callback, async (t) => {
      t.mock.method(console, 'debug', () => {})
      const warn = t.mock.method(console, 'warn', () => {})
      const original = new Error('original processing failure')
      const cleanup = []
      const reader = {
        async read() {
          return { done: false, value: encoder.encode('data: hello\n\n') }
        },
        async cancel() {
          cleanup.push('cancel')
          throw new Error('cancel failed')
        },
        releaseLock() {
          cleanup.push('release')
          throw new Error('release failed')
        },
      }
      t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        body: { getReader: () => reader },
      }))
      await assert.rejects(
        fetchSSE('https://example.com/sse', {
          onStart: () => {},
          onMessage: () => {},
          onEnd: () => assert.fail('must not complete after a processing failure'),
          onError: async (err) => {
            assert.equal(err, original)
            throw new Error('onError failed')
          },
          [callback]: () => {
            throw original
          },
        }),
        (err) => err === original,
      )
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(cleanup, ['cancel', 'release'])
      assert.equal(warn.mock.callCount(), 3)
    })
  }
})

test(
  'fetchSSE bounds huge first-chunk decoding and preserves parser overflow errors',
  async (t) => {
    t.mock.method(console, 'debug', () => {})
    t.mock.method(console, 'warn', () => {})
    const decode = TextDecoder.prototype.decode
    let maxDecodeBytes = 0
    t.mock.method(TextDecoder.prototype, 'decode', function (input, options) {
      maxDecodeBytes = Math.max(maxDecodeBytes, input.byteLength)
      return decode.call(this, input, options)
    })
    const parse = t.mock.method(JSON, 'parse')
    let cancellations = 0
    let reported
    let previewLength
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: ' + 'x'.repeat(9 * 1024 * 1024)))
      },
      cancel() {
        cancellations += 1
      },
    })
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }))
    await assert.rejects(
      fetchSSE('https://example.com/sse', {
        onStart: (preview) => {
          previewLength = preview.length
        },
        onMessage: () => assert.fail('must not dispatch an oversized event'),
        onEnd: () => assert.fail('must not complete an oversized event'),
        onError: async (err) => {
          reported = err
          throw new Error('secondary error')
        },
      }),
      (err) => err === reported && err.code === 'SSE_BUFFER_LIMIT_EXCEEDED',
    )
    assert.ok(maxDecodeBytes <= 64 * 1024)
    assert.equal(previewLength, 64 * 1024)
    assert.equal(parse.mock.callCount(), 0)
    assert.equal(cancellations, 1)
    assert.equal(body.locked, false)
  },
)

test(
  'fetchSSE accepts a huge first chunk with leading SSE framing despite JSON content type',
  async (t) => {
    t.mock.method(console, 'debug', () => {})
    const data = 'x'.repeat(1024)
    const eventCount = 8192
    const leadingBlankLines = '\n'.repeat(64 * 1024 + 1)
    const chunk = encoder.encode(
      `${leadingBlankLines}: keepalive\n\n${`data: ${data}\n\n`.repeat(eventCount)}`,
    )
    assert.ok(chunk.byteLength > 8 * 1024 * 1024)
    let messageCount = 0
    let endCount = 0
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk)
        controller.close()
      },
      cancel: () => assert.fail('a normally completed stream must not be cancelled'),
    })
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body,
    }))
    await fetchSSE('https://example.com/sse', {
      onStart: (preview) => assert.equal(preview, '\n'.repeat(64 * 1024)),
      onMessage: (message) => {
        assert.equal(message, data)
        messageCount += 1
      },
      onEnd: () => {
        assert.equal(body.locked, false)
        endCount += 1
      },
      onError: (err) => {
        throw err
      },
    })
    assert.equal(messageCount, eventCount)
    assert.equal(endCount, 1)
  },
)

test(
  'fetchSSE lets the parser disambiguate object-like oversized SSE despite JSON content type',
  async (t) => {
    t.mock.method(console, 'debug', () => {})
    const paddingLine = `ignored: ${'x'.repeat(64 * 1024 - 16)}\n`
    const chunk = encoder.encode(`{ignored: value\n${paddingLine.repeat(129)}data: ok\n\n`)
    assert.ok(chunk.byteLength > 8 * 1024 * 1024)

    const messages = []
    let endCount = 0
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk)
        controller.close()
      },
    })
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body,
    }))

    await fetchSSE('https://example.com/sse', {
      onStart: (preview) => assert.equal(preview.startsWith('{ignored: value\n'), true),
      onMessage: (message) => messages.push(message),
      onEnd: () => {
        endCount += 1
      },
      onError: (err) => {
        throw err
      },
    })

    assert.deepEqual(messages, ['ok'])
    assert.equal(endCount, 1)
    assert.equal(body.locked, false)
  },
)

test('fetchSSE finishes plain JSON fallback after an empty chunk before cancellation settles', async (t) => {
  const json = '{"answer":"hello"}'
  const messages = []
  let cancellations = 0
  let endCount = 0
  let resolveCancellation
  const cancellation = new Promise((resolve) => {
    resolveCancellation = resolve
  })
  t.after(() => resolveCancellation())

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array())
      controller.enqueue(encoder.encode(json))
    },
    cancel() {
      cancellations += 1
      return cancellation
    },
  })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }))

  let outcome
  const request = fetchSSE('https://example.com/sse', {
    onStart: (preview) => assert.equal(preview, json),
    onMessage: (message) => {
      messages.push(message)
    },
    onEnd: () => {
      assert.equal(body.locked, false)
      endCount += 1
    },
    onError: (err) => {
      throw err
    },
  }).then(
    () => {
      outcome = { status: 'fulfilled' }
    },
    (err) => {
      outcome = { status: 'rejected', err }
    },
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(messages, [json, '[DONE]'])
  assert.equal(cancellations, 1)
  assert.equal(endCount, 1)
  assert.equal(body.locked, false)
  assert.equal(outcome?.status, 'fulfilled')

  resolveCancellation()
  await request
})

test('fetchSSE delivers plain JSON exactly at the first-chunk inspection limit', async (t) => {
  const maxJsonBytes = 8 * 1024 * 1024
  const prefix = '{"value":"'
  const suffix = '"}'
  const payloadLength = maxJsonBytes - encoder.encode(prefix + suffix).byteLength
  const json = prefix + 'x'.repeat(payloadLength) + suffix
  const chunk = encoder.encode(json)
  assert.equal(chunk.byteLength, maxJsonBytes)

  const messages = []
  let cancellations = 0
  let endCount = 0
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk)
    },
    cancel() {
      cancellations += 1
    },
  })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }))

  await fetchSSE('https://example.com/sse', {
    onStart: (preview) => assert.equal(preview.length, json.length),
    onMessage: (message) => messages.push(message),
    onEnd: () => {
      endCount += 1
    },
    onError: (err) => {
      throw err
    },
  })

  assert.deepEqual(messages, [json, '[DONE]'])
  assert.equal(cancellations, 1)
  assert.equal(endCount, 1)
  assert.equal(body.locked, false)
})

test('fetchSSE rejects oversized JSON instead of silently completing', async (t) => {
  const cases = [
    {
      name: 'multibyte JSON without content type',
      createJson: () =>
        JSON.stringify({
          choices: [{ message: { content: '台'.repeat(3 * 1024 * 1024) } }],
        }),
      contentType: null,
      expectedCancellations: 0,
    },
    {
      name: 'JSON with large trailing whitespace and JSON content type',
      createJson: () =>
        '{"choices":[{"message":{"content":"ok"}}]}' +
        '\n'.repeat(8 * 1024 * 1024),
      contentType: 'application/json',
      expectedCancellations: 0,
    },
    {
      name: 'JSON object after a full blank preview without content type',
      createJson: () =>
        '\n'.repeat(64 * 1024 + 1) +
        '{"choices":[{"message":{"content":"ok"}}]}' +
        '\n'.repeat(8 * 1024 * 1024),
      contentType: null,
      expectedCancellations: 0,
    },
  ]

  for (const { name, createJson, contentType, expectedCancellations } of cases) {
    await t.test(name, async (t) => {
      const json = createJson()
      const chunk = encoder.encode(json)
      assert.ok(chunk.byteLength > 8 * 1024 * 1024)
      const expectedPreview = new TextDecoder().decode(chunk.subarray(0, 64 * 1024))

      const messages = []
      const errors = []
      let endCount = 0
      let cancellations = 0
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk)
          controller.close()
        },
        cancel() {
          cancellations += 1
        },
      })
      t.mock.method(globalThis, 'fetch', async () => ({
        ok: true,
        headers: contentType ? new Headers({ 'content-type': contentType }) : undefined,
        body,
      }))

      await assert.rejects(
        fetchSSE('https://example.com/sse', {
          onStart: (preview) => assert.equal(preview, expectedPreview),
          onMessage: (message) => messages.push(message),
          onEnd: () => {
            endCount += 1
          },
          onError: (err) => {
            errors.push(err)
          },
        }),
        (err) => err.code === FETCH_JSON_RESPONSE_TOO_LARGE,
      )

      assert.deepEqual(messages, [])
      assert.equal(errors.length, 1)
      assert.equal(errors[0].code, FETCH_JSON_RESPONSE_TOO_LARGE)
      assert.equal(endCount, 0)
      assert.equal(cancellations, expectedCancellations)
      assert.equal(body.locked, false)
    })
  }
})

test('fetchSSE rejects oversized multibyte JSON after a split BOM and blank chunk', async (t) => {
  const json = JSON.stringify({
    choices: [{ message: { content: '台'.repeat(3 * 1024 * 1024) } }],
  })
  const bytes = encoder.encode(json)
  assert.ok(bytes.byteLength > 8 * 1024 * 1024)

  const splitAt = 4 * 1024 * 1024
  const firstChunk = bytes.subarray(0, splitAt)
  const secondChunk = bytes.subarray(splitAt)
  const leadingBlankChunk = encoder.encode('\n\n')
  assert.ok(firstChunk.byteLength <= 8 * 1024 * 1024)
  assert.ok(secondChunk.byteLength <= 8 * 1024 * 1024)

  const messages = []
  const errors = []
  let endCount = 0
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.of(0xef))
      controller.enqueue(Uint8Array.of(0xbb))
      controller.enqueue(Uint8Array.of(0xbf))
      controller.enqueue(leadingBlankChunk)
      controller.enqueue(firstChunk)
      controller.enqueue(secondChunk)
      controller.close()
    },
  })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }))

  await assert.rejects(
    fetchSSE('https://example.com/sse', {
      onStart: () => {},
      onMessage: (message) => messages.push(message),
      onEnd: () => {
        endCount += 1
      },
      onError: (err) => {
        errors.push(err)
      },
    }),
    (err) => err.code === FETCH_JSON_RESPONSE_TOO_LARGE,
  )

  assert.deepEqual(messages, [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, FETCH_JSON_RESPONSE_TOO_LARGE)
  assert.equal(endCount, 0)
  assert.equal(body.locked, false)
})

test('fetchSSE reports processing errors before pending cancellation settles', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const original = new Error('message failed')
  let resolveCancellation
  const cancellation = new Promise((resolve) => {
    resolveCancellation = resolve
  })
  t.after(() => resolveCancellation())

  let cancelStarted = false
  let errorNotified = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: hello\n\n'))
    },
    cancel() {
      cancelStarted = true
      return cancellation
    },
  })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }))

  let outcome
  const request = fetchSSE('https://example.com/sse', {
    onStart: () => {},
    onMessage: () => {
      throw original
    },
    onEnd: () => assert.fail('must not complete after a processing failure'),
    onError: (err) => {
      assert.equal(err, original)
      errorNotified = true
    },
  }).then(
    () => {
      outcome = { status: 'fulfilled' }
    },
    (err) => {
      outcome = { status: 'rejected', err }
    },
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelStarted, true)
  assert.equal(errorNotified, true)
  assert.equal(body.locked, false)
  assert.equal(outcome?.status, 'rejected')
  assert.equal(outcome?.err, original)

  resolveCancellation()
  await request
})

test('fetchSSE releases the reader on stream errors and cancellation', async (t) => {
  for (const abort of [false, true]) {
    await t.test(abort ? 'abort' : 'read failure', async (t) => {
      const original = abort
        ? new DOMException('cancelled', 'AbortError')
        : new Error('read failed')
      const errors = []
      const endings = []
      const body = new ReadableStream({
        start(controller) {
          controller.error(original)
        },
      })
      t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }))
      await fetchSSE('https://example.com/sse', {
        onStart: () => assert.fail('must not start an errored stream'),
        onMessage: () => assert.fail('must not dispatch from an errored stream'),
        onError: (err) => {
          errors.push(err)
        },
        onEnd: (aborted) => {
          endings.push(aborted)
        },
      })
      assert.equal(body.locked, false)
      if (abort) {
        assert.deepEqual(errors, [])
        assert.deepEqual(endings, [true])
      } else {
        assert.equal(errors.length, 1)
        assert.equal(errors[0].code, 'FETCH_RESPONSE_STREAM_FAILED')
        assert.deepEqual(endings, [])
      }
    })
  }
})
