import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStreamDelta } from '../../../src/components/MarkdownRender/stream-delta.mjs'

test('the first snapshot is written whole', () => {
  const stream = createStreamDelta()

  assert.deepEqual(stream.next('Hello', false), {
    reset: true,
    write: 'Hello',
    finalize: false,
  })
})

test('growth is written as a delta', () => {
  const stream = createStreamDelta()
  stream.next('Hello', false)

  assert.deepEqual(stream.next('Hello world', false), {
    reset: false,
    write: ' world',
    finalize: false,
  })
})

test('an unchanged snapshot does nothing', () => {
  const stream = createStreamDelta()
  stream.next('Hello', false)

  assert.equal(stream.next('Hello', false), null)
})

test('completion finalizes once, and only after the last text', () => {
  const stream = createStreamDelta()
  stream.next('Hello', false)
  stream.next('Hello world', false)

  assert.deepEqual(stream.next('Hello world!', true), {
    reset: false,
    write: '!',
    finalize: true,
  })
  assert.equal(stream.next('Hello world!', true), null)
})

test('completion with no trailing text still finalizes once', () => {
  const stream = createStreamDelta()
  stream.next('Hello', false)

  assert.deepEqual(stream.next('Hello', true), { reset: false, write: '', finalize: true })
  assert.equal(stream.next('Hello', true), null)
})

test('a snapshot that does not extend the last one restarts the renderer', () => {
  const stream = createStreamDelta()
  stream.next('Hello world', true)

  assert.deepEqual(stream.next('Fresh', false), {
    reset: true,
    write: 'Fresh',
    finalize: false,
  })
})

test('a completed answer already on screen is left alone', () => {
  const stream = createStreamDelta()

  assert.deepEqual(stream.next('Stored answer', true), {
    reset: true,
    write: 'Stored answer',
    finalize: true,
  })
  assert.equal(stream.next('Stored answer', true), null)
})
