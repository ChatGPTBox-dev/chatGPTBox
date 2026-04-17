import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getClientPosition } from '../../../src/utils/get-client-position.mjs'

test('getClientPosition returns x/y from bounding client rect', () => {
  const element = {
    getBoundingClientRect() {
      return { left: 50, top: 120 }
    },
  }

  assert.deepEqual(getClientPosition(element), { x: 50, y: 120 })
})

test('getClientPosition supports negative coordinates', () => {
  const element = {
    getBoundingClientRect() {
      return { left: -12, top: 8 }
    },
  }

  assert.deepEqual(getClientPosition(element), { x: -12, y: 8 })
})

test('getClientPosition throws when element does not expose getBoundingClientRect', () => {
  assert.throws(() => getClientPosition({}), TypeError)
})

test('getClientPosition throws when element is null', () => {
  assert.throws(() => getClientPosition(null), TypeError)
})

test('getClientPosition throws when element is undefined', () => {
  assert.throws(() => getClientPosition(undefined), TypeError)
})
