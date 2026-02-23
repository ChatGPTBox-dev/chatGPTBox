import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setElementPositionInViewport } from '../../../src/utils/set-element-position-in-viewport.mjs'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

const restoreWindow = () => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    delete globalThis.window
  }
}

const setViewport = (innerWidth, innerHeight) => {
  Object.defineProperty(globalThis, 'window', {
    value: { innerWidth, innerHeight },
    configurable: true,
  })
}

const createElement = (offsetWidth, offsetHeight) => ({
  offsetWidth,
  offsetHeight,
  style: {},
})

afterEach(() => {
  restoreWindow()
})

test('setElementPositionInViewport keeps position within viewport bounds', () => {
  setViewport(320, 200)
  const element = createElement(80, 40)

  const position = setElementPositionInViewport(element, 100, 60)

  assert.deepEqual(position, { x: 100, y: 60 })
  assert.equal(element.style.left, '100px')
  assert.equal(element.style.top, '60px')
})

test('setElementPositionInViewport clamps negative coordinates to zero', () => {
  setViewport(320, 200)
  const element = createElement(80, 40)

  const position = setElementPositionInViewport(element, -10, -20)

  assert.deepEqual(position, { x: 0, y: 0 })
  assert.equal(element.style.left, '0px')
  assert.equal(element.style.top, '0px')
})

test('setElementPositionInViewport clamps overflow to max visible coordinates', () => {
  setViewport(320, 200)
  const element = createElement(80, 40)

  const position = setElementPositionInViewport(element, 500, 300)

  assert.deepEqual(position, { x: 240, y: 160 })
  assert.equal(element.style.left, '240px')
  assert.equal(element.style.top, '160px')
})

test('setElementPositionInViewport returns zero when element is larger than viewport', () => {
  setViewport(100, 80)
  const element = createElement(150, 120)

  const position = setElementPositionInViewport(element, 20, 30)

  assert.deepEqual(position, { x: 0, y: 0 })
  assert.equal(element.style.left, '0px')
  assert.equal(element.style.top, '0px')
})
