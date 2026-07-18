import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  waitForElementToExistAndSelect,
  waitForSiteAdapterElement,
} from '../../../src/utils/wait-for-element-to-exist-and-select.mjs'

const originalDocument = globalThis.document
const originalMutationObserver = globalThis.MutationObserver

let matchingElement
let observers

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.disconnected = false
    observers.push(this)
  }

  observe() {}

  disconnect() {
    this.disconnected = true
  }

  trigger() {
    this.callback()
  }
}

beforeEach(() => {
  matchingElement = null
  observers = []
  globalThis.document = {
    body: {},
    querySelector: () => matchingElement,
  }
  globalThis.MutationObserver = FakeMutationObserver
})

afterEach(() => {
  globalThis.document = originalDocument
  globalThis.MutationObserver = originalMutationObserver
})

test('waitForElementToExistAndSelect returns an existing element immediately', async () => {
  matchingElement = { id: 'existing' }

  assert.equal(await waitForElementToExistAndSelect('#target'), matchingElement)
  assert.equal(observers.length, 0)
})

test('waitForElementToExistAndSelect resolves after a matching mutation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const promise = waitForElementToExistAndSelect('#target', 100)
  matchingElement = { id: 'inserted' }

  observers[0].trigger()

  assert.equal(await promise, matchingElement)
  assert.equal(observers[0].disconnected, true)
})

test('waitForElementToExistAndSelect can wait indefinitely without a timeout', async () => {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => {
    throw new Error('setTimeout should not be called')
  }

  try {
    const promise = waitForElementToExistAndSelect('#target')
    matchingElement = { id: 'inserted' }
    observers[0].trigger()

    assert.equal(await promise, matchingElement)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('waitForElementToExistAndSelect resolves null after its timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const promise = waitForElementToExistAndSelect('#target', 100)

  t.mock.timers.tick(100)

  assert.equal(await promise, null)
  assert.equal(observers[0].disconnected, true)
})

test('waitForElementToExistAndSelect clears a pending timeout after a match', async () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timeoutId = { id: 'timeout' }
  let clearedTimeout

  globalThis.setTimeout = () => timeoutId
  globalThis.clearTimeout = (id) => {
    clearedTimeout = id
  }

  try {
    const promise = waitForElementToExistAndSelect('#target', 100)
    matchingElement = { id: 'inserted' }
    observers[0].trigger()

    assert.equal(await promise, matchingElement)
    assert.equal(clearedTimeout, timeoutId)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test('site-adapter wait remains active after 5 ms and resolves from a later mutation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const promise = waitForSiteAdapterElement('#target').then((element) => {
    settled = true
    return element
  })

  t.mock.timers.tick(5)
  await Promise.resolve()
  assert.equal(settled, false)

  matchingElement = { id: 'inserted' }
  observers[0].trigger()

  assert.equal(await promise, matchingElement)
})

test('site-adapter wait accepts a compound selector for fallback containers', async () => {
  const fallbackElement = { id: 'results' }
  globalThis.document.querySelector = (selector) => {
    assert.equal(selector, '.sidebar,#results')
    return fallbackElement
  }

  assert.equal(await waitForSiteAdapterElement('.sidebar,#results'), fallbackElement)
  assert.equal(observers.length, 0)
})

test('site-adapter wait times out after 5 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const promise = waitForSiteAdapterElement('#target').then((element) => {
    settled = true
    return element
  })

  t.mock.timers.tick(4_999)
  await Promise.resolve()
  assert.equal(settled, false)

  t.mock.timers.tick(1)

  assert.equal(await promise, null)
})
