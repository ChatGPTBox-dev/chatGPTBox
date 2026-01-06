import { getCoreContentText } from '../../utils/get-core-content-text'
import Browser from 'webextension-polyfill'
import { getUserConfig } from '../../config/index.mjs'
import { openUrl } from '../../utils/open-url'
import { speakText, isTtsAvailable } from '../../services/openai-tts.mjs'

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
  readSelectedText: {
    label: 'Read Selected Text',
    action: async (fromBackground) => {
      console.debug('read selected text action from background', fromBackground)

      const selection = window.getSelection()
      const selectedText = selection ? selection.toString().trim() : ''

      if (!selectedText) {
        alert('Please select some text first')
        return
      }

      try {
        const config = await getUserConfig()
        const useTts = await isTtsAvailable()

        if (useTts) {
          // Use OpenAI TTS
          await speakText(selectedText, {
            voice: config.openAiTtsVoice,
            model: config.openAiTtsModel,
            speed: config.openAiTtsSpeed,
          })
        } else {
          // Fallback to system TTS
          const synth = window.speechSynthesis
          synth.cancel()

          const utterance = new SpeechSynthesisUtterance(selectedText)
          const voices = synth.getVoices()

          let voice
          if (config.preferredLanguage.includes('en') && navigator.language.includes('en'))
            voice = voices.find((v) => v.name.toLowerCase().includes('microsoft aria'))
          else if (config.preferredLanguage.includes('zh') || navigator.language.includes('zh'))
            voice = voices.find((v) => v.name.toLowerCase().includes('xiaoyi'))
          else if (config.preferredLanguage.includes('ja') || navigator.language.includes('ja'))
            voice = voices.find((v) => v.name.toLowerCase().includes('nanami'))
          if (!voice)
            voice = voices.find((v) => v.lang.substring(0, 2) === config.preferredLanguage)
          if (!voice) voice = voices.find((v) => v.lang === navigator.language)

          if (voice) utterance.voice = voice
          utterance.rate = 1
          utterance.volume = 1

          synth.speak(utterance)
        }
      } catch (error) {
        console.error('Error reading selected text:', error)
        alert('Error reading selected text: ' + error.message)
      }
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
    action: async (fromBackground, tab) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        // eslint-disable-next-line no-undef
        chrome.sidePanel.open({ windowId: tab.windowId, tabId: tab.id })
      } else {
        // side panel is not supported
      }
    },
  },
  closeAllChats: {
    label: 'Close All Chats In This Page',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)
      Browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        Browser.tabs.sendMessage(tabs[0].id, {
          type: 'CLOSE_CHATS',
          data: {},
        })
      })
    },
  },
}
