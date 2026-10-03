import assert from 'node:assert/strict'
import { test } from 'node:test'
import Browser from 'webextension-polyfill'
import { openUrl } from '../../../src/utils/open-url.mjs'

const overrideTabs = (t, methods) => {
  for (const [name, value] of Object.entries(methods)) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(Browser.tabs, name)
    Object.defineProperty(Browser.tabs, name, {
      value,
      writable: true,
      configurable: true,
    })
    t.after(() => {
      if (originalDescriptor) {
        Object.defineProperty(Browser.tabs, name, originalDescriptor)
      } else {
        delete Browser.tabs[name]
      }
    })
  }
}

test('openUrl activates an existing matching tab', async (t) => {
  const queryCalls = []
  const updateCalls = []
  let createCalled = false
  overrideTabs(t, {
    query: async (queryInfo) => {
      queryCalls.push(queryInfo)
      return [{ id: 42 }]
    },
    update: async (...args) => {
      updateCalls.push(args)
    },
    create: async () => {
      createCalled = true
    },
  })

  assert.equal(await openUrl('https://example.com'), undefined)
  assert.deepEqual(queryCalls, [{ url: 'https://example.com', currentWindow: true }])
  assert.deepEqual(updateCalls, [[42, { active: true }]])
  assert.equal(createCalled, false)
})

test('openUrl creates a tab when no existing tab matches', async (t) => {
  let updateCalled = false
  const createCalls = []
  overrideTabs(t, {
    query: async () => [],
    update: async () => {
      updateCalled = true
    },
    create: async (...args) => {
      createCalls.push(args)
    },
  })

  assert.equal(await openUrl('https://example.com'), undefined)
  assert.equal(updateCalled, false)
  assert.deepEqual(createCalls, [[{ url: 'https://example.com' }]])
})

test('openUrl logs a tabs.query failure and fulfills', async (t) => {
  const error = new Error('query failed')
  let updateCalled = false
  let createCalled = false
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => {
    loggedErrors.push(args)
  })
  overrideTabs(t, {
    query: async () => {
      throw error
    },
    update: async () => {
      updateCalled = true
    },
    create: async () => {
      createCalled = true
    },
  })

  assert.equal(await openUrl('https://example.com'), undefined)
  assert.deepEqual(loggedErrors, [['failed to open url', error]])
  assert.equal(updateCalled, false)
  assert.equal(createCalled, false)
})

test('openUrl logs a tabs.update failure and fulfills', async (t) => {
  const error = new Error('update failed')
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => {
    loggedErrors.push(args)
  })
  overrideTabs(t, {
    query: async () => [{ id: 42 }],
    update: async () => {
      throw error
    },
  })

  assert.equal(await openUrl('https://example.com'), undefined)
  assert.deepEqual(loggedErrors, [['failed to open url', error]])
})

test('openUrl logs a tabs.create failure and fulfills', async (t) => {
  const error = new Error('create failed')
  const loggedErrors = []
  t.mock.method(console, 'error', (...args) => {
    loggedErrors.push(args)
  })
  overrideTabs(t, {
    query: async () => [],
    create: async () => {
      throw error
    },
  })

  assert.equal(await openUrl('https://example.com'), undefined)
  assert.deepEqual(loggedErrors, [['failed to open url', error]])
})
