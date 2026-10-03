import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  clampInputHeight,
  getKeyboardInputHeight,
  getPointerInputHeight,
  MIN_INPUT_HEIGHT,
} from '../../../src/components/InputBox/resize.mjs'

describe('input box resize helpers', () => {
  it('grows upward and shrinks downward within the available range', () => {
    assert.equal(getPointerInputHeight(160, 200, 150, 300), 210)
    assert.equal(getPointerInputHeight(160, 200, 230, 300), 130)
  })

  it('clamps pointer resizing to the minimum and maximum heights', () => {
    assert.equal(getPointerInputHeight(160, 200, 400, 300), MIN_INPUT_HEIGHT)
    assert.equal(getPointerInputHeight(160, 200, 0, 300), 300)
  })

  it('uses the minimum height when the available range is smaller', () => {
    assert.equal(clampInputHeight(160, 40), MIN_INPUT_HEIGHT)
  })

  it('supports keyboard resizing and larger shift-key steps', () => {
    assert.equal(getKeyboardInputHeight(160, 'ArrowUp', 300), 170)
    assert.equal(getKeyboardInputHeight(160, 'ArrowDown', 300), 150)
    assert.equal(getKeyboardInputHeight(160, 'ArrowUp', 300, true), 200)
    assert.equal(getKeyboardInputHeight(160, 'ArrowDown', 300, true), 120)
  })

  it('supports the minimum and maximum keyboard shortcuts', () => {
    assert.equal(getKeyboardInputHeight(160, 'Home', 300), MIN_INPUT_HEIGHT)
    assert.equal(getKeyboardInputHeight(160, 'End', 300), 300)
  })

  it('ignores unrelated keys and does not cross keyboard bounds', () => {
    assert.equal(getKeyboardInputHeight(160, 'Enter', 300), null)
    assert.equal(getKeyboardInputHeight(MIN_INPUT_HEIGHT, 'ArrowDown', 300), MIN_INPUT_HEIGHT)
    assert.equal(getKeyboardInputHeight(300, 'ArrowUp', 300), 300)
  })
})
