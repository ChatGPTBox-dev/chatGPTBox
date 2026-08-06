import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldHandleInputAction } from '../../../src/components/InputBox/input-action.mjs'

test('input actions handle button clicks and both plain Enter forms', () => {
  assert.equal(shouldHandleInputAction({ type: 'click' }), true)
  assert.equal(
    shouldHandleInputAction({ type: 'keydown', key: 'Enter', shiftKey: false }),
    true,
  )
  assert.equal(
    shouldHandleInputAction({ type: 'keydown', keyCode: 13, shiftKey: false }),
    true,
  )
})

test('input actions preserve Shift+Enter line breaks', () => {
  assert.equal(
    shouldHandleInputAction({ type: 'keydown', key: 'Enter', keyCode: 13, shiftKey: true }),
    false,
  )
})

test('input actions ignore directly exposed active IME composition', () => {
  assert.equal(
    shouldHandleInputAction({
      type: 'keydown',
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      isComposing: true,
    }),
    false,
  )
})

test('input actions ignore active IME composition on synthetic native events', () => {
  assert.equal(
    shouldHandleInputAction({
      type: 'keydown',
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      nativeEvent: { isComposing: true },
    }),
    false,
  )
})

test('input actions ignore the legacy IME keyCode 229 fallback', () => {
  assert.equal(
    shouldHandleInputAction({
      type: 'keydown',
      key: 'Enter',
      keyCode: 229,
      shiftKey: false,
      isComposing: false,
    }),
    false,
  )
})

test('input actions ignore unrelated keyboard events', () => {
  assert.equal(
    shouldHandleInputAction({ type: 'keydown', key: 'a', keyCode: 65, shiftKey: false }),
    false,
  )
})
