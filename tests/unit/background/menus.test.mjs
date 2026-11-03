import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import i18n from 'i18next'
import { getUserConfig } from '../../../src/config/index.mjs'

const createdMenus = []
const listeners = new Set()
globalThis.chrome.contextMenus = {
  onClicked: {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    hasListener: (listener) => listeners.has(listener),
  },
  removeAll(callback) {
    createdMenus.length = 0
    queueMicrotask(callback)
  },
  create(options) {
    createdMenus.push(options)
    return options.id
  },
}

register(new URL('../../setup/menu-loader-hooks.mjs', import.meta.url))
const { refreshMenu } = await import('../../../src/background/menus.mjs')

test('menu refresh observes the hide preference before its storage event arrives', async (t) => {
  await i18n.init({ lng: 'en', resources: { en: { translation: {} } } })
  const shim = globalThis.__TEST_BROWSER_SHIM__
  shim.replaceStorage({ hideContextMenu: false })
  for (let attempt = 0; attempt < 3; attempt++) await getUserConfig()
  shim.deferStorageEvents()
  t.after(() => shim.flushStorageEvents())

  shim.setStorage({ hideContextMenu: true })
  await refreshMenu()
  assert.equal(createdMenus.length, 0, 'the committed hide setting must take effect')

  shim.setStorage({ hideContextMenu: false })
  await refreshMenu()
  assert.ok(createdMenus.some((menu) => menu.id === 'ChatGPTBox-Menu'))
})
