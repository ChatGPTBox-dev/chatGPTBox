import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createAnswerBuffer,
  createFrameScheduler,
} from '../../../src/components/ConversationCard/answer-buffer.mjs'

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
  const buffer = createAnswerBuffer({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    render: (answer) => renders.push(answer),
  })
  return { frames, renders, buffer }
}

test('a burst of chunks renders once per frame with only the newest text', () => {
  const { frames, renders, buffer } = setup()

  buffer.push('a')
  buffer.push('ab')
  buffer.push('abc')
  assert.deepEqual(renders, [])

  frames.runFrames()

  assert.deepEqual(renders, ['abc'])
})

test('a chunk arriving after a frame schedules the next render', () => {
  const { frames, renders, buffer } = setup()

  buffer.push('a')
  frames.runFrames()
  buffer.push('ab')
  frames.runFrames()

  assert.deepEqual(renders, ['a', 'ab'])
})

test('flush renders the newest chunk so completion cannot drop the last one', () => {
  const { frames, renders, buffer } = setup()

  buffer.push('a')
  buffer.push('ab')
  buffer.flush()
  assert.deepEqual(renders, ['ab'])
  assert.equal(frames.cancelled.length, 1)

  frames.runFrames()
  assert.deepEqual(renders, ['ab'], 'the cancelled frame must not render again')
})

test('flush without pending text does not render', () => {
  const { renders, buffer } = setup()

  buffer.flush()

  assert.deepEqual(renders, [])
})

test('discard drops the pending text without rendering it', () => {
  const { frames, renders, buffer } = setup()

  buffer.push('a')
  buffer.discard()
  frames.runFrames()

  assert.deepEqual(renders, [])
})

test('pushing after a discard schedules a fresh frame', () => {
  const { frames, renders, buffer } = setup()

  buffer.push('a')
  buffer.discard()
  buffer.push('b')
  frames.runFrames()

  assert.deepEqual(renders, ['b'])
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
