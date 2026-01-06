import Browser from 'webextension-polyfill'
import { defaultConfig, getPreferredLanguageKey, getUserConfig } from '../config/index.mjs'
import { changeLanguage, t } from 'i18next'
import { config as menuConfig } from '../content-script/menu-tools/index.mjs'

const menuId = 'ChatGPTBox-Menu'
const onClickMenu = (info, tab) => {
  Browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const currentTab = tabs[0]
    const message = {
      itemId: info.menuItemId.replace(menuId, ''),
      selectionText: info.selectionText,
      useMenuPosition: tab.id === currentTab.id,
    }
    console.debug('menu clicked', message)

    if (defaultConfig.selectionTools.includes(message.itemId)) {
      Browser.tabs.sendMessage(currentTab.id, {
        type: 'CREATE_CHAT',
        data: message,
      })
    } else if (message.itemId.startsWith('custom_')) {
      // Handle custom selection tools
      Browser.tabs.sendMessage(currentTab.id, {
        type: 'CREATE_CHAT',
        data: message,
      })
    } else if (message.itemId in menuConfig) {
      if (menuConfig[message.itemId].action) {
        menuConfig[message.itemId].action(true, tab)
      }

      if (menuConfig[message.itemId].genPrompt) {
        Browser.tabs.sendMessage(currentTab.id, {
          type: 'CREATE_CHAT',
          data: message,
        })
      }
    }
  })
}
export function refreshMenu() {
  if (Browser.contextMenus.onClicked.hasListener(onClickMenu))
    Browser.contextMenus.onClicked.removeListener(onClickMenu)
  Browser.contextMenus.removeAll().then(async () => {
    const userConfig = await getUserConfig()
    if (userConfig.hideContextMenu) return

    await getPreferredLanguageKey().then((lang) => {
      changeLanguage(lang)
    })
    Browser.contextMenus.create({
      id: menuId,
      title: 'ChatGPTBox',
      contexts: ['all'],
    })

    for (const [k, v] of Object.entries(menuConfig)) {
      Browser.contextMenus.create({
        id: menuId + k,
        parentId: menuId,
        title: t(v.label),
        contexts: ['all'],
      })
    }
    Browser.contextMenus.create({
      id: menuId + 'separator1',
      parentId: menuId,
      contexts: ['selection'],
      type: 'separator',
    })

    // Add default selection tools that are active
    for (const index in defaultConfig.selectionTools) {
      const key = defaultConfig.selectionTools[index]
      const desc = defaultConfig.selectionToolsDesc[index]
      if (userConfig.activeSelectionTools.includes(key)) {
        Browser.contextMenus.create({
          id: menuId + key,
          parentId: menuId,
          title: t(desc),
          contexts: ['selection'],
        })
      }
    }

    // Add custom selection tools that are active
    userConfig.customSelectionTools?.forEach((tool, i) => {
      if (tool?.active && tool?.name) {
        Browser.contextMenus.create({
          id: menuId + 'custom_' + i,
          parentId: menuId,
          title: tool.name,
          contexts: ['selection'],
        })
      }
    })

    Browser.contextMenus.onClicked.addListener(onClickMenu)
  })
}
