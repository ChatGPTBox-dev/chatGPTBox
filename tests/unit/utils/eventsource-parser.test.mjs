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
