import Browser from 'webextension-polyfill'
import { config as menuConfig } from '../content-script/menu-tools/index.mjs'

export function registerCommands() {
  Browser.commands.onCommand.addListener(async (command, tab) => {
    const message = {
      itemId: command,
      selectionText: '',
      useMenuPosition: false,
    }
    console.debug('command triggered', message)

    if (command in menuConfig) {
      if (menuConfig[command].action) {
        // The action may return a Promise (e.g. openSidePanel returns the
        // chrome.sidePanel.open() Promise). Keep the call synchronous so the
        // user-gesture context is preserved, but observe the Promise so a
        // rejection does not become an unhandled rejection in the background.
        const result = menuConfig[command].action(true, tab)
        if (result && typeof result.catch === 'function') {
          result.catch((error) => {
            console.error(`failed to run command action "${command}"`, error)
          })
        }
      }

      if (menuConfig[command].genPrompt) {
        const currentTab = (await Browser.tabs.query({ active: true, currentWindow: true }))[0]
        Browser.tabs.sendMessage(currentTab.id, {
          type: 'CREATE_CHAT',
          data: message,
        })
      }
    }
  })
}
