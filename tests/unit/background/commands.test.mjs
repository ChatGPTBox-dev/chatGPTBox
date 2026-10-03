import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'
import { beforeEach, test } from 'node:test'
import Browser from 'webextension-polyfill'
import { registerCommands } from '../../../src/background/commands.mjs'
import { config as menuConfig } from '../../../src/content-script/menu-tools/index.mjs'

const flushPromises = () => new Promise((resolve) => setImmediate(resolve))

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

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.resetEvents()
  registerCommands()
})

test('invokes command actions synchronously', (t) => {
  let called = false
  const originalAction = menuConfig.openSidePanel.action
  menuConfig.openSidePanel.action = () => {
    called = true
    return Promise.resolve()
  }
  t.after(() => {
    menuConfig.openSidePanel.action = originalAction
  })

  globalThis.chrome.commands.onCommand._trigger('openSidePanel', { id: 7, windowId: 9 })

  assert.equal(called, true)
})

test('dispatches the closeAllChats command to its action', (t) => {
  const tab = { id: 7, windowId: 9 }
  const originalAction = menuConfig.closeAllChats.action
  const action = t.mock.fn(() => Promise.resolve())
  menuConfig.closeAllChats.action = action
  t.after(() => {
    menuConfig.closeAllChats.action = originalAction
  })

  globalThis.chrome.commands.onCommand._trigger('closeAllChats', tab)

  assert.deepEqual(action.mock.calls[0].arguments, [true, tab])
})

test('handles active-tab query failures for prompt commands', async (t) => {
  const queryError = new Error('query failed')
  replaceBrowserMethod(t, Browser.tabs, 'query', async () => {
    throw queryError
  })
  const consoleError = t.mock.method(console, 'error', () => {})

  globalThis.chrome.commands.onCommand._trigger('newChat', { id: 7 })
  await flushPromises()

  assert.deepEqual(consoleError.mock.calls[0].arguments, [
    'failed to query active tab for command "newChat"',
    queryError,
  ])
})

test('does nothing when a prompt command has no active tab', async (t) => {
  replaceBrowserMethod(t, Browser.tabs, 'query', async () => [])
  const sendMessage = t.mock.fn()
  replaceBrowserMethod(t, Browser.tabs, 'sendMessage', sendMessage)

  globalThis.chrome.commands.onCommand._trigger('newChat', { id: 7 })
  await flushPromises()

  assert.equal(sendMessage.mock.callCount(), 0)
})

test('handles content-script message failures for prompt commands', async (t) => {
  const messageError = new Error('send failed')
  replaceBrowserMethod(t, Browser.tabs, 'query', async () => [{ id: 7 }])
  replaceBrowserMethod(t, Browser.tabs, 'sendMessage', async () => {
    throw messageError
  })
  const consoleError = t.mock.method(console, 'error', () => {})

  globalThis.chrome.commands.onCommand._trigger('newChat', { id: 7 })
  await flushPromises()

  assert.deepEqual(consoleError.mock.calls[0].arguments, [
    'failed to send CREATE_CHAT message for command "newChat"',
    messageError,
  ])
})

test('ignores unknown commands', async (t) => {
  const query = t.mock.fn()
  replaceBrowserMethod(t, Browser.tabs, 'query', query)

  globalThis.chrome.commands.onCommand._trigger('unknownCommand', { id: 7 })
  await flushPromises()

  assert.equal(query.mock.callCount(), 0)
})
