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
        // Also wrap in try/catch because Browser.commands.onCommand documents
        // `tab` as optional, so an action that dereferences tab.* (e.g. the
        // openSidePanel call) can throw synchronously.
        let result
        try {
          result = menuConfig[command].action(true, tab)
        } catch (error) {
          console.error(`failed to run command action "${command}"`, error)
          return
        }
        if (result && typeof result.catch === 'function') {
          result.catch((error) => {
            console.error(`failed to run command action "${command}"`, error)
          })
        }
      }

      if (menuConfig[command].genPrompt) {
        // Mirror the pattern in menus.mjs so no step here can leak an
        // unhandled rejection in the background:
        //   - Browser.tabs.query() can reject (permission errors, etc.) —
        //     observe via try/catch.
        //   - tabs[0] may be undefined when no active tab exists — guard
        //     before dereferencing currentTab.id.
        //   - Browser.tabs.sendMessage() (via webextension-polyfill) rejects
        //     in normal extension usage (no content script listening,
        //     restricted pages like chrome://, stale content scripts after
        //     extension reload) — attach a .catch().
        let tabs
        try {
          tabs = await Browser.tabs.query({ active: true, currentWindow: true })
        } catch (error) {
          console.error(`failed to query active tab for command "${command}"`, error)
          return
        }
        const currentTab = tabs && tabs[0]
        if (!currentTab) {
          console.debug(`command "${command}" triggered but no active tab found, skipping`)
          return
        }
        Browser.tabs
          .sendMessage(currentTab.id, {
            type: 'CREATE_CHAT',
            data: message,
          })
          .catch((error) => {
            console.error(`failed to send CREATE_CHAT message for command "${command}"`, error)
          })
      }
    }
  })
}
