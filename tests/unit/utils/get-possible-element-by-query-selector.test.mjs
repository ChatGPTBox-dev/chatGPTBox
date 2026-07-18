import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { getPossibleElementByQuerySelector } from '../../../src/utils/get-possible-element-by-query-selector.mjs'

const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

const restoreDocument = () => {
  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', originalDocumentDescriptor)
  } else {
    delete globalThis.document
  }
}

const setDocument = (querySelector) => {
  Object.defineProperty(globalThis, 'document', {
    value: { querySelector },
    configurable: true,
  })
}

afterEach(() => {
  restoreDocument()
})

test('getPossibleElementByQuerySelector returns the first matching selector', () => {
  const firstMatch = { id: 'first' }
  const calls = []
  setDocument((selector) => {
    calls.push(selector)
    return selector === '.first' ? firstMatch : { id: 'later' }
  })

  const result = getPossibleElementByQuerySelector(['.first', '.later'])

  assert.equal(result, firstMatch)
  assert.deepEqual(calls, ['.first'])
})

test('getPossibleElementByQuerySelector falls through missing and invalid selectors', () => {
  const fallbackMatch = { id: 'fallback' }
  const calls = []
  setDocument((selector) => {
    calls.push(selector)
    if (selector === '[') throw new DOMException('Invalid selector', 'SyntaxError')
    if (selector === '.fallback') return fallbackMatch
    return null
  })

  const result = getPossibleElementByQuerySelector(['.missing', '[', '.fallback'])

  assert.equal(result, fallbackMatch)
  assert.deepEqual(calls, ['.missing', '[', '.fallback'])
})

test('getPossibleElementByQuerySelector returns undefined without usable matches', () => {
  const calls = []
  setDocument((selector) => {
    calls.push(selector)
    return null
  })

  assert.equal(getPossibleElementByQuerySelector(null), undefined)
  assert.equal(getPossibleElementByQuerySelector([]), undefined)
  assert.equal(getPossibleElementByQuerySelector(['', null, '.missing']), undefined)
  assert.deepEqual(calls, ['.missing'])
})
