import { getCoreContentText } from '../../utils/get-core-content-text.mjs'
import Browser from 'webextension-polyfill'
import { getUserConfig } from '../../config/index.mjs'
import { openUrl } from '../../utils/open-url.mjs'

export const config = {
  newChat: {
    label: 'New Chat',
    genPrompt: async () => {
      return ''
    },
  },
  summarizePage: {
    label: 'Summarize Page',
    genPrompt: async () => {
      return `You are an expert summarizer. Carefully analyze the following web page content and provide a concise summary focusing on the key points:\n${getCoreContentText()}`
    },
  },
  openConversationPage: {
    label: 'Open Conversation Page',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        openUrl(Browser.runtime.getURL('IndependentPanel.html'))
      } else {
        Browser.runtime.sendMessage({
          type: 'OPEN_URL',
          data: {
            url: Browser.runtime.getURL('IndependentPanel.html'),
          },
        })
      }
    },
  },
  openConversationWindow: {
    label: 'Open Conversation Window',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        const config = await getUserConfig()
        const url = Browser.runtime.getURL('IndependentPanel.html')
        const tabs = await Browser.tabs.query({ url: url, windowType: 'popup' })
        if (!config.alwaysCreateNewConversationWindow && tabs.length > 0)
          await Browser.windows.update(tabs[0].windowId, { focused: true })
        else
          await Browser.windows.create({
            url: url,
            type: 'popup',
            width: 500,
            height: 650,
          })
      } else {
        Browser.runtime.sendMessage({
          type: 'OPEN_CHAT_WINDOW',
          data: {},
        })
      }
    },
  },
  openSidePanel: {
    label: 'Open Side Panel',
    action: (fromBackground, tab) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        // eslint-disable-next-line no-undef
        if (typeof chrome === 'undefined' || !chrome.sidePanel?.open) {
          // sidePanel API is not available in this browser (e.g. Firefox)
          return Promise.reject(new Error('chrome.sidePanel API is not available'))
        }
        // PDF guest viewers can omit windowId (and sometimes the whole tab).
        // Let the browser resolve CURRENT synchronously in that case. An async
        // query here loses the gesture; Edge's tab-specific PDF route can no-op.
        const hasWindow = Number.isInteger(tab?.windowId) && tab.windowId >= 0
        // eslint-disable-next-line no-undef
        return chrome.sidePanel.open({
          windowId: hasWindow ? tab.windowId : globalThis.chrome.windows?.WINDOW_ID_CURRENT ?? -2,
        })
      }
      // side panel is not supported
      return undefined
    },
  },
  closeAllChats: {
    label: 'Close All Chats In This Page',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)

      try {
        const tabs = await Browser.tabs.query({ active: true, currentWindow: true })
        const currentTab = tabs && tabs[0]
        if (currentTab?.id == null) return

        await Browser.tabs.sendMessage(currentTab.id, {
          type: 'CLOSE_CHATS',
          data: {},
        })
      } catch (error) {
        console.error('failed to close all chats', error)
      }
    },
  },
}
