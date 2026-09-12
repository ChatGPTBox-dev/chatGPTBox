import assert from 'node:assert/strict'
import { test } from 'node:test'
import Browser from 'webextension-polyfill'
import i18next from 'i18next'
import { refreshMenu } from '../../../src/background/menus.mjs'
import { config as menuConfig } from '../../../src/content-script/menu-tools/index.mjs'

test('handles the waking side-panel click before asynchronous menu setup finishes', async (t) => {
  await i18next.init({ lng: 'en', resources: { en: { translation: {} } } })
  const originalMenus = Browser.contextMenus
  const originalAction = menuConfig.openSidePanel.action
  const listeners = new Set()
  let finishRemoval
  const removal = new Promise((resolve) => {
    finishRemoval = resolve
  })
  Browser.contextMenus = {
    onClicked: {
      addListener: (listener) => listeners.add(listener),
      hasListener: (listener) => listeners.has(listener),
    },
    removeAll: (callback) => {
      removal.then(() => callback())
    },
    create: () => {},
  }
  const action = t.mock.fn(() => Promise.resolve())
  menuConfig.openSidePanel.action = action
  t.after(() => {
    Browser.contextMenus = originalMenus
    menuConfig.openSidePanel.action = originalAction
  })

  const ready = refreshMenu()
  assert.equal(listeners.size, 1, 'listener must exist before removeAll resolves')
  const tab = { id: 7, windowId: 9 }
  for (const listener of listeners) listener({ menuItemId: 'ChatGPTBox-MenuopenSidePanel' }, tab)
  assert.deepEqual(action.mock.calls[0].arguments, [true, tab])
  finishRemoval()
  await ready
  await refreshMenu()
  assert.equal(listeners.size, 1, 'refresh must not duplicate the gesture listener')
})
