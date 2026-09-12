import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParser } from '../../../src/utils/eventsource-parser.mjs'

const encoder = new TextEncoder()
const toBytes = (text) => encoder.encode(text)
const isBufferLimitError = (err) =>
  err instanceof RangeError && err.code === 'SSE_BUFFER_LIMIT_EXCEEDED'

const assertBufferLimit = (input, maxBufferSize) => {
  const parser = createParser(() => {}, { maxBufferSize })
  assert.throws(() => parser.feed(toBytes(input)), isBufferLimitError)
}

const assertLiveReplacementLimit = (field) => {
  const limit = 100 * 1024
  const parser = createParser(() => {}, { maxBufferSize: limit })

  const oldValue = 'a'.repeat(90 * 1024)
  parser.feed(toBytes(`${field}: ${oldValue}\n`))
  const slicedReplacement = toBytes(`${field}: ${'b'.repeat(90 * 1024)}\n`)
  assert.ok(slicedReplacement.byteLength > 64 * 1024)
  assert.throws(() => parser.feed(slicedReplacement), isBufferLimitError)

  parser.reset()
  parser.feed(toBytes(`${field}: ${'a'.repeat(60 * 1024)}\n`))
  const finalSliceReplacement = toBytes(`${field}: ${'b'.repeat(50 * 1024)}\n`)
  assert.ok(finalSliceReplacement.byteLength < 64 * 1024)
  assert.throws(() => parser.feed(finalSliceReplacement), isBufferLimitError)
}

test('createParser counts retained event, id, and meta state toward the limit', () => {
  assertBufferLimit('event: 123456789\n', 8)
  assertBufferLimit('id: 123456789\n', 8)
  assertBufferLimit('meta: {"source":"test"}\n', 16)
})

test('createParser rejects an oversized complete event before dispatch', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event), { maxBufferSize: 10 })

  assert.throws(() => parser.feed(toBytes('data: 1234567890\n\n')), isBufferLimitError)
  assert.deepEqual(parsed, [])
})

test('createParser reset discards metadata and its buffer accounting', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event), { maxBufferSize: 13 })

  parser.feed(toBytes('meta: {"a":1}\n'))
  parser.reset()
  parser.feed(toBytes('meta: {"a":1}\n'))
  parser.reset()
  parser.feed(toBytes('data: ok\n\n'))

  assert.deepEqual(parsed.map((event) => [event.data, event.extra]), [['ok', undefined]])
})

test('createParser processes a large transport chunk containing small events', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event), { maxBufferSize: 8 })
  const eventCount = 20000

  parser.feed(toBytes('data: a\n\n'.repeat(eventCount)))

  assert.equal(parsed.length, eventCount)
  assert.equal(parsed.every((event) => event.data === 'a'), true)
})

test('createParser preserves UTF-8 and line framing across internal decode slices', () => {
  const limit = 64 * 1024
  const answer = '台'.repeat(limit - 3) + '🙂'
  const parsed = []
  const parser = createParser((event) => parsed.push(event), { maxBufferSize: limit })
  const bytes = toBytes(`data: ${answer}\r\n\r\n`)

  assert.ok(bytes.byteLength > 64 * 1024)
  parser.feed(bytes)
  assert.deepEqual(parsed.map((event) => event.data), [answer])
  assertBufferLimit(`data: ${answer}x\n\n`, limit)
})

test('createParser counts partial slices together with already retained event state', (t) => {
  const limit = 128 * 1024
  const parser = createParser(() => {}, { maxBufferSize: limit })
  parser.feed(toBytes(`data: ${'a'.repeat(96 * 1024)}\n`))

  const decode = TextDecoder.prototype.decode
  let decodedBytes = 0
  t.mock.method(TextDecoder.prototype, 'decode', function (input, options) {
    decodedBytes += input.byteLength
    return decode.call(this, input, options)
  })

  assert.throws(
    () => parser.feed(toBytes(`data: ${'b'.repeat(96 * 1024)}`)),
    isBufferLimitError,
  )
  assert.equal(decodedBytes, 64 * 1024)
})

test('createParser counts a live event replacement across decode slices and final slices', () => {
  assertLiveReplacementLimit('event')
})

test('createParser counts a live id replacement across decode slices and final slices', () => {
  assertLiveReplacementLimit('id')
})

test('createParser counts unknown field names instead of treating them as free syntax', () => {
  const parser = createParser(() => {}, { maxBufferSize: 16 })
  assert.throws(() => parser.feed(toBytes(`${'x'.repeat(100)}:`)), isBufferLimitError)
})

test('createParser keeps BufferSource compatibility when the limit is enabled', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event), { maxBufferSize: 20 })
  const first = toBytes('data: one\n\n').slice()
  const second = toBytes('data: two\n\n').slice()

  parser.feed(first.buffer)
  parser.feed(new DataView(second.buffer, second.byteOffset, second.byteLength))

  assert.deepEqual(parsed.map((event) => event.data), ['one', 'two'])
})

test('createParser bounds each decode and stops a huge unfinished line early', (t) => {
  const decode = TextDecoder.prototype.decode
  let decodedBytes = 0
  let maxDecodeBytes = 0
  t.mock.method(TextDecoder.prototype, 'decode', function (input, options) {
    decodedBytes += input.byteLength
    maxDecodeBytes = Math.max(maxDecodeBytes, input.byteLength)
    return decode.call(this, input, options)
  })

  const bytes = toBytes('x'.repeat(1024 * 1024))
  const parser = createParser(() => {}, { maxBufferSize: 16 })
  assert.throws(() => parser.feed(bytes), isBufferLimitError)
  assert.ok(maxDecodeBytes <= 64 * 1024)
  assert.ok(decodedBytes < bytes.byteLength)
})
