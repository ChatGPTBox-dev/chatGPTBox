import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParser } from '../../../src/utils/eventsource-parser.mjs'

const encoder = new TextEncoder()

const toBytes = (text) => encoder.encode(text)

test('createParser parses basic SSE event data', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data: hello world\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].type, 'event')
  assert.equal(parsed[0].data, 'hello world')
})

test('createParser parses retry, event metadata, and multiline data', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('retry: 1500\n'))
  parser.feed(
    toBytes('event: update\nid: msg-1\ndata: part-1\ndata: part-2\nmeta: {"source":"test"}\n\n'),
  )

  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], {
    type: 'reconnect-interval',
    value: 1500,
  })

  assert.equal(parsed[1].type, 'event')
  assert.equal(parsed[1].event, 'update')
  assert.equal(parsed[1].id, 'msg-1')
  assert.equal(parsed[1].data, 'part-1\npart-2')
  assert.deepEqual(parsed[1].extra, [{ meta: { source: 'test' } }])
})

test('createParser supports chunked input boundaries', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data: par'))
  parser.feed(toBytes('tial message'))
  parser.feed(toBytes('\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'partial message')
})

test('createParser ignores UTF-8 BOM in the first chunk', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  const withBom = new Uint8Array([239, 187, 191, ...toBytes('data: bom\n\n')])
  parser.feed(withBom)

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'bom')
})

test('createParser handles \\r\\n line endings', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data: hello\r\ndata: world\r\n\r\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'hello\nworld')
})

test('createParser handles \\r only line endings', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data: solo\r\r'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'solo')
})

test('createParser ignores comment lines starting with colon', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes(': this is a comment\ndata: actual\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'actual')
})

test('createParser handles data field with no space after colon', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data:nospace\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'nospace')
})

test('createParser handles empty data field (colon only)', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data:\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, '')
})

test('createParser ignores id field containing null byte', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('id: abc\0def\ndata: test\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, undefined)
  assert.equal(parsed[0].data, 'test')
})

test('createParser handles field line without colon (noValue)', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, '')
})

test('createParser handles partial buffer after complete events', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('data: first\n\ndata: incom'))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'first')

  parser.feed(toBytes('plete\n\n'))
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].data, 'incomplete')
})

test('createParser strips BOM-like characters from decoded buffer', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  // Construct bytes that decode to chars with charCodes [239, 187, 191] (ï»¿) followed by SSE data
  const bomChars = new Uint8Array([195, 175, 194, 187, 194, 191])
  const sseData = toBytes('data: after-bom\n\n')
  const combined = new Uint8Array(bomChars.length + sseData.length)
  combined.set(bomChars)
  combined.set(sseData, bomChars.length)

  parser.feed(combined)

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data, 'after-bom')
})

test('createParser handles retry with non-numeric value', () => {
  const parsed = []
  const parser = createParser((event) => parsed.push(event))

  parser.feed(toBytes('retry: notanumber\ndata: test\n\n'))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].type, 'event')
  assert.equal(parsed[0].data, 'test')
})
