import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFrameScheduler,
  createStreamBuffer,
} from '../../../src/components/ConversationCard/stream-buffer.mjs'

function createFakeFrames() {
  let nextHandle = 1
  const callbacks = new Map()
  const cancelled = []

  return {
    cancelled,
    requestFrame(callback) {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    cancelFrame(handle) {
      cancelled.push(handle)
      callbacks.delete(handle)
    },
    runFrames() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback()
    },
  }
}

function setup() {
  const frames = createFakeFrames()
  const renders = []
  const buffer = createStreamBuffer({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    render: (patch) => renders.push(patch),
  })
  return { frames, renders, buffer }
}

test('a burst of chunks renders once per frame with only the newest values', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'a' })
  buffer.push({ content: 'ab' })
  buffer.push({ content: 'abc' })
  assert.deepEqual(renders, [])

  frames.runFrames()

  assert.deepEqual(renders, [{ content: 'abc' }])
})

test('answer and reasoning arriving together are applied in a single patch', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'The answer.' })
  buffer.push({ reasoning: 'weighing options' })
  frames.runFrames()

  assert.deepEqual(renders, [{ content: 'The answer.', reasoning: 'weighing options' }])
})

test('a patch keeps the fields it does not mention', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'first' })
  frames.runFrames()
  buffer.push({ reasoning: 'thinking' })
  frames.runFrames()

  assert.deepEqual(renders, [{ content: 'first' }, { reasoning: 'thinking' }])
})

test('a chunk arriving after a frame schedules the next render', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'a' })
  frames.runFrames()
  buffer.push({ content: 'ab' })
  frames.runFrames()

  assert.deepEqual(renders, [{ content: 'a' }, { content: 'ab' }])
})

test('flush renders the newest patch so completion cannot drop the last one', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'a' })
  buffer.push({ content: 'ab', done: true })
  buffer.flush()
  assert.deepEqual(renders, [{ content: 'ab', done: true }])
  assert.equal(frames.cancelled.length, 1)

  frames.runFrames()
  assert.deepEqual(renders, [{ content: 'ab', done: true }], 'the cancelled frame must not render')
})

test('flush without a pending patch does not render', () => {
  const { renders, buffer } = setup()

  buffer.flush()

  assert.deepEqual(renders, [])
})

test('discard drops the pending patch without rendering it', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'a' })
  buffer.discard()
  frames.runFrames()

  assert.deepEqual(renders, [])
})

test('pushing after a discard schedules a fresh frame', () => {
  const { frames, renders, buffer } = setup()

  buffer.push({ content: 'a' })
  buffer.discard()
  buffer.push({ content: 'b' })
  frames.runFrames()

  assert.deepEqual(renders, [{ content: 'b' }])
})

test('createFrameScheduler uses the host animation frames when available', () => {
  const requested = []
  const cancelled = []
  const scheduler = createFrameScheduler({
    requestAnimationFrame: (callback) => {
      requested.push(callback)
      return 7
    },
    cancelAnimationFrame: (handle) => cancelled.push(handle),
  })

  const handle = scheduler.requestFrame(() => {})
  scheduler.cancelFrame(handle)

  assert.equal(requested.length, 1)
  assert.deepEqual(cancelled, [7])
})

test('createFrameScheduler falls back to a timer without animation frames', async () => {
  const scheduler = createFrameScheduler({})
  const renders = []

  await new Promise((resolve) => {
    scheduler.requestFrame(() => {
      renders.push('tick')
      resolve()
    })
  })

  assert.deepEqual(renders, ['tick'])
})

test('the timer fallback cancels a pending frame', async () => {
  const scheduler = createFrameScheduler({})
  const renders = []
  const handle = scheduler.requestFrame(() => renders.push('tick'))

  scheduler.cancelFrame(handle)
  await new Promise((resolve) => setTimeout(resolve, 32))

  assert.deepEqual(renders, [])
})
