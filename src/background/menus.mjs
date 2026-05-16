import Browser from 'webextension-polyfill'
import { defaultConfig, getPreferredLanguageKey, getUserConfig } from '../config/index.mjs'
import { changeLanguage, t } from 'i18next'
import { config as menuConfig } from '../content-script/menu-tools/index.mjs'

const menuId = 'ChatGPTBox-Menu'
const onClickMenu = (info, tab) => {
  const itemId = info.menuItemId.replace(menuId, '')

  // sidePanel.open() must be called synchronously within the user gesture handler.
  // Calling it inside a Promise callback (e.g. Browser.tabs.query().then()) breaks
  // Chrome's user gesture requirement and causes the error:
  // "sidePanel.open() may only be called in response to a user gesture."
  if (itemId === 'openSidePanel' && menuConfig.openSidePanel?.action) {
    // Keep the call synchronous to preserve the user-gesture requirement,
    // but observe the returned Promise so a rejected sidePanel.open() does
    // not become an unhandled rejection in the background script.
    // Also wrap in try/catch because contextMenus.onClicked documents `tab`
    // as optional ("If the click did not take place in a tab, this parameter
    // will be missing"), so the openSidePanel action that dereferences
    // tab.windowId/tab.id can throw synchronously.
    let result
    try {
      result = menuConfig.openSidePanel.action(true, tab)
    } catch (error) {
      console.error('failed to open side panel', error)
      return
    }
    if (result && typeof result.catch === 'function') {
      result.catch((error) => {
        console.error('failed to open side panel', error)
      })
    }
    return
  }

  Browser.tabs
    .query({ active: true, currentWindow: true })
    .then((tabs) => {
      const currentTab = tabs && tabs[0]
      if (!currentTab) {
        console.debug('menu clicked but no active tab found, skipping')
        return
      }

      // contextMenus.onClicked documents `tab` as optional ("If the click did
      // not take place in a tab, this parameter will be missing"), so guard
      // before dereferencing tab.id when computing useMenuPosition.
      const message = {
        itemId,
        selectionText: info.selectionText,
        useMenuPosition: tab ? tab.id === currentTab.id : false,
      }
      console.debug('menu clicked', message)

      if (defaultConfig.selectionTools.includes(message.itemId)) {
        // Browser.tabs.sendMessage() (via webextension-polyfill) returns a
        // Promise that commonly rejects (no content script listening, restricted
        // pages such as chrome://, stale content scripts after extension reload)
        // — observe it so we don't leak unhandled rejections in the background.
        Browser.tabs
          .sendMessage(currentTab.id, {
            type: 'CREATE_CHAT',
            data: message,
          })
          .catch((error) => {
            console.error(`failed to send CREATE_CHAT message for "${message.itemId}"`, error)
          })
      } else if (message.itemId in menuConfig) {
        if (menuConfig[message.itemId].action) {
          // Several actions in menuConfig are async (e.g. tabs/windows calls)
          // and can throw synchronously or return a rejected Promise. Mirror
          // the handling already used for openSidePanel above and in
          // commands.mjs so neither path leaks an unhandled rejection in the
          // background script.
          let actionResult
          try {
            actionResult = menuConfig[message.itemId].action(true, tab)
          } catch (error) {
            console.error(`failed to run menu action "${message.itemId}"`, error)
          }
          if (actionResult && typeof actionResult.catch === 'function') {
            actionResult.catch((error) => {
              console.error(`failed to run menu action "${message.itemId}"`, error)
            })
          }
        }

        if (menuConfig[message.itemId].genPrompt) {
          // Same rationale as the sendMessage call above — observe the Promise
          // so a rejected sendMessage (no content script, restricted page, etc.)
          // doesn't surface as an unhandled rejection in the background.
          Browser.tabs
            .sendMessage(currentTab.id, {
              type: 'CREATE_CHAT',
              data: message,
            })
            .catch((error) => {
              console.error(`failed to send CREATE_CHAT message for "${message.itemId}"`, error)
            })
        }
      }
    })
    .catch((error) => {
      // Browser.tabs.query() can reject (e.g. on permission errors); make sure
      // it does not become an unhandled promise rejection in the background.
      console.error('failed to query active tab for menu click', error)
    })
}
export function refreshMenu() {
  if (Browser.contextMenus.onClicked.hasListener(onClickMenu))
    Browser.contextMenus.onClicked.removeListener(onClickMenu)
  Browser.contextMenus.removeAll().then(async () => {
    if ((await getUserConfig()).hideContextMenu) return

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
    for (const index in defaultConfig.selectionTools) {
      const key = defaultConfig.selectionTools[index]
      const desc = defaultConfig.selectionToolsDesc[index]
      Browser.contextMenus.create({
        id: menuId + key,
        parentId: menuId,
        title: t(desc),
        contexts: ['selection'],
      })
    }

    Browser.contextMenus.onClicked.addListener(onClickMenu)
  })
}
