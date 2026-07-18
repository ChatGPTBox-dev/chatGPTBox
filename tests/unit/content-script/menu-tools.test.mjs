import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'
import { describe, test } from 'node:test'
import Browser from 'webextension-polyfill'
import { config } from '../../../src/content-script/menu-tools/index.mjs'

function replaceBrowserMethod(t, target, name, replacement) {
  const original = target[name]
  Object.defineProperty(target, name, {
    value: replacement,
    writable: true,
    configurable: true,
  })
  t.after(() => {
    Object.defineProperty(target, name, {
      value: original,
      writable: true,
      configurable: true,
    })
  })
}

describe('closeAllChats', () => {
  test('waits for the close message before resolving', async (t) => {
    t.mock.method(console, 'debug', () => {})

    let resolveMessage
    const messagePromise = new Promise((resolve) => {
      resolveMessage = resolve
    })
    replaceBrowserMethod(t, Browser.tabs, 'query', async () => [{ id: 17 }])
    const sendMessage = t.mock.fn(() => messagePromise)
    replaceBrowserMethod(t, Browser.tabs, 'sendMessage', sendMessage)

    let settled = false
    const actionPromise = config.closeAllChats.action(true).then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(settled, false)
    assert.deepEqual(sendMessage.mock.calls[0].arguments, [
      17,
      {
        type: 'CLOSE_CHATS',
        data: {},
      },
    ])

    resolveMessage()
    await actionPromise
    assert.equal(settled, true)
  })

  for (const [name, tabs] of [
    ['no active tab', []],
    ['an active tab without an id', [{}]],
  ]) {
    test(`does nothing when there is ${name}`, async (t) => {
      t.mock.method(console, 'debug', () => {})
      replaceBrowserMethod(t, Browser.tabs, 'query', async () => tabs)
      const sendMessage = t.mock.fn()
      replaceBrowserMethod(t, Browser.tabs, 'sendMessage', sendMessage)

      await config.closeAllChats.action(true)

      assert.equal(sendMessage.mock.callCount(), 0)
    })
  }

  test('handles active-tab query failures', async (t) => {
    t.mock.method(console, 'debug', () => {})
    const queryError = new Error('query failed')
    replaceBrowserMethod(t, Browser.tabs, 'query', async () => {
      throw queryError
    })
    const consoleError = t.mock.method(console, 'error', () => {})

    await config.closeAllChats.action(true)

    assert.deepEqual(consoleError.mock.calls[0].arguments, [
      'failed to close all chats',
      queryError,
    ])
  })

  test('handles close-message failures', async (t) => {
    t.mock.method(console, 'debug', () => {})
    const messageError = new Error('send failed')
    replaceBrowserMethod(t, Browser.tabs, 'query', async () => [{ id: 23 }])
    replaceBrowserMethod(t, Browser.tabs, 'sendMessage', async () => {
      throw messageError
    })
    const consoleError = t.mock.method(console, 'error', () => {})

    await config.closeAllChats.action(true)

    assert.deepEqual(consoleError.mock.calls[0].arguments, [
      'failed to close all chats',
      messageError,
    ])
  })
})

describe('openSidePanel', () => {
  test('opens the side panel synchronously with the active tab identifiers', async (t) => {
    const originalSidePanel = globalThis.chrome.sidePanel
    let called = false
    const open = t.mock.fn(() => {
      called = true
      return Promise.resolve()
    })
    globalThis.chrome.sidePanel = { open }
    t.after(() => {
      globalThis.chrome.sidePanel = originalSidePanel
    })

    const result = config.openSidePanel.action(true, { id: 7, windowId: 9 })

    assert.equal(called, true)
    assert.deepEqual(open.mock.calls[0].arguments, [{ windowId: 9, tabId: 7 }])
    await result
  })

  test('rejects when the side-panel API is unavailable', async (t) => {
    const originalSidePanel = globalThis.chrome.sidePanel
    globalThis.chrome.sidePanel = undefined
    t.after(() => {
      globalThis.chrome.sidePanel = originalSidePanel
    })

    await assert.rejects(config.openSidePanel.action(true, { id: 7, windowId: 9 }), {
      message: 'chrome.sidePanel API is not available',
    })
  })

  for (const [name, tab] of [
    ['tab', undefined],
    ['tab id', { windowId: 9 }],
    ['window id', { id: 7 }],
  ]) {
    test(`rejects when the ${name} is missing`, async (t) => {
      const originalSidePanel = globalThis.chrome.sidePanel
      const open = t.mock.fn(() => Promise.resolve())
      globalThis.chrome.sidePanel = { open }
      t.after(() => {
        globalThis.chrome.sidePanel = originalSidePanel
      })

      await assert.rejects(config.openSidePanel.action(true, tab), {
        message: 'chrome.sidePanel.open requires a tab with windowId and id',
      })
      assert.equal(open.mock.callCount(), 0)
    })
  }
})
