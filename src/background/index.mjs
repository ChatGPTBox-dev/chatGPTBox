import Browser from 'webextension-polyfill'
import {
  deleteConversation,
  generateAnswersWithChatgptWebApi,
  sendMessageFeedback,
} from '../services/apis/chatgpt-web'
import { generateAnswersWithBingWebApi } from '../services/apis/bing-web.mjs'
import {
  generateAnswersWithChatgptApi,
  generateAnswersWithGptCompletionApi,
} from '../services/apis/openai-api'
import { generateAnswersWithCustomApi } from '../services/apis/custom-api.mjs'
import { generateAnswersWithOllamaApi } from '../services/apis/ollama-api.mjs'
import { generateAnswersWithAzureOpenaiApi } from '../services/apis/azure-openai-api.mjs'
import { generateAnswersWithClaudeApi } from '../services/apis/claude-api.mjs'
import { generateAnswersWithChatGLMApi } from '../services/apis/chatglm-api.mjs'
import { generateAnswersWithWaylaidwandererApi } from '../services/apis/waylaidwanderer-api.mjs'
import {
  defaultConfig,
  getUserConfig,
  setUserConfig,
  isUsingChatgptWebModel,
  isUsingBingWebModel,
  isUsingGptCompletionApiModel,
  isUsingChatgptApiModel,
  isUsingCustomModel,
  isUsingOllamaApiModel,
  isUsingAzureOpenAiApiModel,
  isUsingClaudeApiModel,
  isUsingChatGLMApiModel,
  isUsingGithubThirdPartyApiModel,
  isUsingGeminiWebModel,
  isUsingClaudeWebModel,
  isUsingMoonshotApiModel,
  isUsingMoonshotWebModel,
} from '../config/index.mjs'
import '../_locales/i18n'
import { openUrl } from '../utils/open-url'
import {
  getBardCookies,
  getBingAccessToken,
  getChatGptAccessToken,
  getClaudeSessionKey,
  registerPortListener,
} from '../services/wrappers.mjs'
import { refreshMenu } from './menus.mjs'
import { registerCommands } from './commands.mjs'
import { generateAnswersWithBardWebApi } from '../services/apis/bard-web.mjs'
import { generateAnswersWithClaudeWebApi } from '../services/apis/claude-web.mjs'
import { generateAnswersWithMoonshotCompletionApi } from '../services/apis/moonshot-api.mjs'
import { generateAnswersWithMoonshotWebApi } from '../services/apis/moonshot-web.mjs'
import { isUsingModelName } from '../utils/model-name-convert.mjs'

const RECONNECT_CONFIG = {
  MAX_ATTEMPTS: 5,
  BASE_DELAY_MS: 1000, // Base delay in milliseconds
  BACKOFF_MULTIPLIER: 2, // Multiplier for exponential backoff
};

const SENSITIVE_KEYWORDS = [
  'apikey',
  'token',
  'secret',
  'password',
  'kimimoonshotrefreshtoken',
  'auth',
  'key',
  'credential',
];

function redactSensitiveFields(obj, recursionDepth = 0, maxDepth = 5, seen = new WeakSet()) {
  if (recursionDepth > maxDepth) {
    return 'REDACTED_TOO_DEEP';
  }
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (seen.has(obj)) {
    return 'REDACTED_CIRCULAR_REFERENCE';
  }
  seen.add(obj);

  const redactedObj = Array.isArray(obj) ? [] : {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const lowerKey = key.toLowerCase();
      let isSensitive = false;
      for (const keyword of SENSITIVE_KEYWORDS) {
        if (lowerKey.includes(keyword)) {
          isSensitive = true;
          break;
        }
      }
      if (isSensitive) {
        redactedObj[key] = 'REDACTED';
      } else if (typeof obj[key] === 'object') {
        redactedObj[key] = redactSensitiveFields(obj[key], recursionDepth + 1, maxDepth, seen);
      } else {
        redactedObj[key] = obj[key];
      }
    }
  }
  return redactedObj;
}

function setPortProxy(port, proxyTabId) {
  try {
    console.debug(`[background] Attempting to connect to proxy tab: ${proxyTabId}`)

    if (port.proxy) {
        try {
            if (port._proxyOnMessage) port.proxy.onMessage.removeListener(port._proxyOnMessage);
            if (port._proxyOnDisconnect) port.proxy.onDisconnect.removeListener(port._proxyOnDisconnect);
        } catch(e) {
            console.warn('[background] Error removing old listeners from previous port.proxy instance:', e);
        }
    }
    if (port._portOnMessage) port.onMessage.removeListener(port._portOnMessage);
    if (port._portOnDisconnect) port.onDisconnect.removeListener(port._portOnDisconnect);

    port.proxy = Browser.tabs.connect(proxyTabId, { name: 'background-to-content-script-proxy' })
    console.debug(`[background] Successfully connected to proxy tab: ${proxyTabId}`)
    port._reconnectAttempts = 0

    port._proxyOnMessage = (msg) => {
      console.debug('[background] Message from proxy tab:', msg)
      port.postMessage(msg)
    }
    port._portOnMessage = (msg) => {
      console.debug('[background] Message to proxy tab:', msg)
      if (port.proxy) {
        port.proxy.postMessage(msg)
      } else {
        console.warn('[background] Port proxy not available to send message:', msg)
      }
    }

    port._proxyOnDisconnect = () => {
      console.warn(`[background] Proxy tab ${proxyTabId} disconnected.`)

      const proxyRef = port.proxy;
      port.proxy = null

      if (proxyRef) {
        if (port._proxyOnMessage) {
            try { proxyRef.onMessage.removeListener(port._proxyOnMessage); }
            catch(e) { console.warn("[background] Error removing _proxyOnMessage from disconnected proxyRef:", e); }
        }
        if (port._proxyOnDisconnect) {
            try { proxyRef.onDisconnect.removeListener(port._proxyOnDisconnect); }
            catch(e) { console.warn("[background] Error removing _proxyOnDisconnect from disconnected proxyRef:", e); }
        }
      }

      port._reconnectAttempts = (port._reconnectAttempts || 0) + 1;
      if (port._reconnectAttempts > RECONNECT_CONFIG.MAX_ATTEMPTS) {
        console.error(`[background] Max reconnect attempts (${RECONNECT_CONFIG.MAX_ATTEMPTS}) reached for tab ${proxyTabId}. Giving up.`);
        if (port._portOnMessage) {
            try { port.onMessage.removeListener(port._portOnMessage); }
            catch(e) { console.warn("[background] Error removing _portOnMessage on max retries:", e); }
        }
        return;
      }

      const delay = Math.pow(RECONNECT_CONFIG.BACKOFF_MULTIPLIER, port._reconnectAttempts - 1) * RECONNECT_CONFIG.BASE_DELAY_MS;
      console.log(`[background] Attempting reconnect #${port._reconnectAttempts} in ${delay / 1000}s for tab ${proxyTabId}.`)

      setTimeout(() => {
        console.debug(`[background] Retrying connection to tab ${proxyTabId}, attempt ${port._reconnectAttempts}.`);
        setPortProxy(port, proxyTabId);
      }, delay);
    }

    port._portOnDisconnect = () => {
      console.log('[background] Main port disconnected (e.g. popup/sidebar closed). Cleaning up proxy connections and listeners.');
      if (port._portOnMessage) {
        try { port.onMessage.removeListener(port._portOnMessage); }
        catch(e) { console.warn("[background] Error removing _portOnMessage on main port disconnect:", e); }
      }
      const proxyRef = port.proxy;
      if (proxyRef) {
        if (port._proxyOnMessage) {
            try { proxyRef.onMessage.removeListener(port._proxyOnMessage); }
            catch(e) { console.warn("[background] Error removing _proxyOnMessage from proxyRef on main port disconnect:", e); }
        }
        if (port._proxyOnDisconnect) {
            try { proxyRef.onDisconnect.removeListener(port._proxyOnDisconnect); }
            catch(e) { console.warn("[background] Error removing _proxyOnDisconnect from proxyRef on main port disconnect:", e); }
        }
        try {
            proxyRef.disconnect();
        } catch(e) {
            console.warn('[background] Error disconnecting proxyRef on main port disconnect:', e);
        }
        port.proxy = null;
      }
      if (port._portOnDisconnect) {
        try { port.onDisconnect.removeListener(port._portOnDisconnect); }
        catch(e) { console.warn("[background] Error removing _portOnDisconnect on main port disconnect:", e); }
      }
      port._reconnectAttempts = 0;
    }

    port.proxy.onMessage.addListener(port._proxyOnMessage)
    port.onMessage.addListener(port._portOnMessage)
    port.proxy.onDisconnect.addListener(port._proxyOnDisconnect)
    port.onDisconnect.addListener(port._portOnDisconnect)

  } catch (error) {
    console.error(`[background] Error in setPortProxy for tab ${proxyTabId}:`, error)
  }
}

async function executeApi(session, port, config) {
  console.log(
    `[background] executeApi called for model: ${session.modelName}, apiMode: ${session.apiMode}`,
  )
  console.debug('[background] Full session details (redacted):', redactSensitiveFields(session))
  console.debug('[background] Full config details (redacted):', redactSensitiveFields(config))
  if (session.apiMode) {
    console.debug('[background] Session apiMode details (redacted):', redactSensitiveFields(session.apiMode))
  }

  try {
    if (isUsingCustomModel(session)) {
      console.debug('[background] Using Custom Model API')
      if (!session.apiMode)
        await generateAnswersWithCustomApi(
          port,
          session.question,
          session,
          config.customModelApiUrl.trim() || 'http://localhost:8000/v1/chat/completions',
          config.customApiKey,
          config.customModelName,
        )
      else
        await generateAnswersWithCustomApi(
          port,
          session.question,
          session,
          session.apiMode.customUrl.trim() ||
            config.customModelApiUrl.trim() ||
            'http://localhost:8000/v1/chat/completions',
          session.apiMode.apiKey.trim() || config.customApiKey,
          session.apiMode.customName,
        )
    } else if (isUsingChatgptWebModel(session)) {
      console.debug('[background] Using ChatGPT Web Model')
      let tabId
      if (
        config.chatgptTabId &&
        config.customChatGptWebApiUrl === defaultConfig.customChatGptWebApiUrl
      ) {
        try {
          const tab = await Browser.tabs.get(config.chatgptTabId)
          if (tab) tabId = tab.id
        } catch (e) {
          console.warn(
            `[background] Failed to get ChatGPT tab with ID ${config.chatgptTabId}:`,
            e.message,
          )
        }
      }
      if (tabId) {
        console.debug(`[background] ChatGPT Tab ID ${tabId} found.`)
        if (!port.proxy) {
          console.debug('[background] port.proxy not found, calling setPortProxy.')
          setPortProxy(port, tabId)
        }
        if (port.proxy) {
          console.debug('[background] Posting message to proxy tab:', { session })
          port.proxy.postMessage({ session })
        } else {
          console.error(
            '[background] Failed to send message: port.proxy is still not available after setPortProxy.',
          )
        }
      } else {
        console.debug('[background] No valid ChatGPT Tab ID found. Using direct API call.')
        const accessToken = await getChatGptAccessToken()
        await generateAnswersWithChatgptWebApi(port, session.question, session, accessToken)
      }
    } else if (isUsingClaudeWebModel(session)) {
      console.debug('[background] Using Claude Web Model')
      const sessionKey = await getClaudeSessionKey()
      await generateAnswersWithClaudeWebApi(port, session.question, session, sessionKey)
    } else if (isUsingMoonshotWebModel(session)) {
      console.debug('[background] Using Moonshot Web Model')
      await generateAnswersWithMoonshotWebApi(port, session.question, session, config)
    } else if (isUsingBingWebModel(session)) {
      console.debug('[background] Using Bing Web Model')
      const accessToken = await getBingAccessToken()
      if (isUsingModelName('bingFreeSydney', session)) {
        console.debug('[background] Using Bing Free Sydney model')
        await generateAnswersWithBingWebApi(port, session.question, session, accessToken, true)
      } else {
        await generateAnswersWithBingWebApi(port, session.question, session, accessToken)
      }
    } else if (isUsingGeminiWebModel(session)) {
      console.debug('[background] Using Gemini Web Model')
      const cookies = await getBardCookies()
      await generateAnswersWithBardWebApi(port, session.question, session, cookies)
    } else if (isUsingChatgptApiModel(session)) {
      console.debug('[background] Using ChatGPT API Model')
      await generateAnswersWithChatgptApi(port, session.question, session, config.apiKey)
    } else if (isUsingClaudeApiModel(session)) {
      console.debug('[background] Using Claude API Model')
      await generateAnswersWithClaudeApi(port, session.question, session)
    } else if (isUsingMoonshotApiModel(session)) {
      console.debug('[background] Using Moonshot API Model')
      await generateAnswersWithMoonshotCompletionApi(
        port,
        session.question,
        session,
        config.moonshotApiKey,
      )
    } else if (isUsingChatGLMApiModel(session)) {
      console.debug('[background] Using ChatGLM API Model')
      await generateAnswersWithChatGLMApi(port, session.question, session)
    } else if (isUsingOllamaApiModel(session)) {
      console.debug('[background] Using Ollama API Model')
      await generateAnswersWithOllamaApi(port, session.question, session)
    } else if (isUsingAzureOpenAiApiModel(session)) {
      console.debug('[background] Using Azure OpenAI API Model')
      await generateAnswersWithAzureOpenaiApi(port, session.question, session)
    } else if (isUsingGptCompletionApiModel(session)) {
      console.debug('[background] Using GPT Completion API Model')
      await generateAnswersWithGptCompletionApi(port, session.question, session, config.apiKey)
    } else if (isUsingGithubThirdPartyApiModel(session)) {
      console.debug('[background] Using Github Third Party API Model')
      await generateAnswersWithWaylaidwandererApi(port, session.question, session)
    } else {
      console.warn('[background] Unknown model or session configuration:', session)
      port.postMessage({ error: 'Unknown model configuration' })
    }
  } catch (error) {
    console.error(`[background] Error in executeApi for model ${session.modelName}:`, error)
    port.postMessage({ error: error.message || 'An unexpected error occurred in executeApi' })
  }
}

Browser.runtime.onMessage.addListener(async (message, sender) => {
  console.debug('[background] Received message:', message, 'from sender:', sender)
  try {
    switch (message.type) {
      case 'FEEDBACK': {
        console.log('[background] Processing FEEDBACK message')
        const token = await getChatGptAccessToken()
        await sendMessageFeedback(token, message.data)
        break
      }
      case 'DELETE_CONVERSATION': {
        console.log('[background] Processing DELETE_CONVERSATION message')
        const token = await getChatGptAccessToken()
        await deleteConversation(token, message.data.conversationId)
        break
      }
      case 'NEW_URL': {
        console.log('[background] Processing NEW_URL message:', message.data)
        await Browser.tabs.create({
          url: message.data.url,
          pinned: message.data.pinned,
        })
        if (message.data.jumpBack) {
          console.debug('[background] Setting jumpBackTabId:', sender.tab?.id)
          await setUserConfig({
            notificationJumpBackTabId: sender.tab?.id,
          })
        }
        break
      }
      case 'SET_CHATGPT_TAB': {
        console.log('[background] Processing SET_CHATGPT_TAB message. Tab ID:', sender.tab?.id)
        await setUserConfig({
          chatgptTabId: sender.tab?.id,
        })
        break
      }
      case 'ACTIVATE_URL':
        console.log('[background] Processing ACTIVATE_URL message:', message.data)
        await Browser.tabs.update(message.data.tabId, { active: true })
        break
      case 'OPEN_URL':
        console.log('[background] Processing OPEN_URL message:', message.data)
        openUrl(message.data.url)
        break
      case 'OPEN_CHAT_WINDOW': {
        console.log('[background] Processing OPEN_CHAT_WINDOW message')
        const config = await getUserConfig()
        const url = Browser.runtime.getURL('IndependentPanel.html')
        const tabs = await Browser.tabs.query({ url: url, windowType: 'popup' })
        if (!config.alwaysCreateNewConversationWindow && tabs.length > 0) {
          console.debug('[background] Focusing existing chat window:', tabs[0].windowId)
          await Browser.windows.update(tabs[0].windowId, { focused: true })
        } else {
          console.debug('[background] Creating new chat window.')
          await Browser.windows.create({
            url: url,
            type: 'popup',
            width: 500,
            height: 650,
          })
        }
        break
      }
      case 'REFRESH_MENU':
        console.log('[background] Processing REFRESH_MENU message')
        refreshMenu()
        break
      case 'PIN_TAB': {
        console.log('[background] Processing PIN_TAB message:', message.data)
        let tabId = message.data.tabId || sender.tab?.id
        if (tabId) {
          await Browser.tabs.update(tabId, { pinned: true })
          if (message.data.saveAsChatgptConfig) {
            console.debug('[background] Saving pinned tab as ChatGPT config tab:', tabId)
            await setUserConfig({ chatgptTabId: tabId })
          }
        } else {
          console.warn('[background] No tabId found for PIN_TAB message.')
        }
        break
      }
      case 'FETCH': {
        console.log('[background] Processing FETCH message for URL:', message.data.input)
        if (message.data.input.includes('bing.com')) {
          console.debug('[background] Fetching Bing access token for FETCH message.')
          const accessToken = await getBingAccessToken()
          await setUserConfig({ bingAccessToken: accessToken })
        }

        try {
          const response = await fetch(message.data.input, message.data.init)
          const text = await response.text()
          console.debug(
            `[background] FETCH successful for ${message.data.input}, status: ${response.status}`,
          )
          return [
            {
              body: text,
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers),
            },
            null,
          ]
        } catch (error) {
          console.error(`[background] FETCH error for ${message.data.input}:`, error)
          return [null, { message: error.message, stack: error.stack }]
        }
      }
      case 'GET_COOKIE': {
        console.log('[background] Processing GET_COOKIE message:', message.data)
        try {
          const cookie = await Browser.cookies.get({
            url: message.data.url,
            name: message.data.name,
          })
          console.debug('[background] Cookie found:', cookie)
          return cookie?.value
        } catch (error) {
          console.error(
            `[background] Error getting cookie ${message.data.name} for ${message.data.url}:`,
            error,
          )
          return null
        }
      }
      default:
        console.warn('[background] Unknown message type received:', message.type)
    }
  } catch (error) {
    console.error(
      `[background] Error processing message type ${message.type}:`,
      error,
      'Original message:',
      message,
    )
    if (message.type === 'FETCH') {
      return [null, { message: error.message, stack: error.stack }]
    }
  }
})

try {
  Browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      try {
        console.debug('[background] onBeforeRequest triggered for URL:', details.url)
        if (
          details.url.includes('/public_key') &&
          !details.url.includes(defaultConfig.chatgptArkoseReqParams)
        ) {
          console.log('[background] Capturing Arkose public_key request:', details.url)
          let formData = new URLSearchParams()
          if (details.requestBody && details.requestBody.formData) {
            for (const k in details.requestBody.formData) {
              formData.append(k, details.requestBody.formData[k])
            }
          }
          const formString =
            formData.toString() ||
            (details.requestBody?.raw?.[0]?.bytes
              ? new TextDecoder('utf-8').decode(new Uint8Array(details.requestBody.raw[0].bytes))
              : '')

          setUserConfig({
            chatgptArkoseReqUrl: details.url,
            chatgptArkoseReqForm: formString,
          })
            .then(() => {
              console.log('[background] Arkose req url and form saved successfully.')
            })
            .catch((e) =>
              console.error('[background] Error saving Arkose req url and form:', e),
            )
        }
      } catch (error) {
        console.error('[background] Error in onBeforeRequest listener callback:', error, details)
      }
    },
    {
      urls: ['https://*.openai.com/*', 'https://*.chatgpt.com/*'],
      types: ['xmlhttprequest'],
    },
    ['requestBody'],
  )

  Browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        console.debug('[background] onBeforeSendHeaders triggered for URL:', details.url)
        const headers = details.requestHeaders
        let modified = false
        for (let i = 0; i < headers.length; i++) {
          if (headers[i]) {
            const headerNameLower = headers[i].name?.toLowerCase();
            if (headerNameLower === 'origin') {
              headers[i].value = 'https://www.bing.com'
              modified = true
            } else if (headerNameLower === 'referer') {
              headers[i].value = 'https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx'
              modified = true
            }
          }
        }
        if (modified) {
          console.debug('[background] Modified headers for Bing:', headers)
        }
        return { requestHeaders: headers }
      } catch (error) {
        console.error(
          '[background] Error in onBeforeSendHeaders listener callback:',
          error,
          details,
        )
        return { requestHeaders: details.requestHeaders }
      }
    },
    {
      urls: ['wss://sydney.bing.com/*', 'https://www.bing.com/*'],
      types: ['xmlhttprequest', 'websocket'],
    },
    ['blocking', 'requestHeaders'],
  )

  Browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    const outerTryCatchError = (error) => { // Renamed to avoid conflict with inner error
      console.error('[background] Error in tabs.onUpdated listener callback (outer):', error, tabId, info);
    };
    try {
      if (!tab.url || (info.status && info.status !== 'complete')) {
        console.debug(
          `[background] Skipping side panel update for tabId: ${tabId}. Tab URL: ${tab.url}, Info Status: ${info.status}`,
        );
        return;
      }
      console.debug(
        `[background] tabs.onUpdated event for tabId: ${tabId}, status: ${info.status}, url: ${tab.url}. Proceeding with side panel update.`,
      );

      let sidePanelSet = false;
      try {
        if (Browser.sidePanel && typeof Browser.sidePanel.setOptions === 'function') {
          await Browser.sidePanel.setOptions({
            tabId,
            path: 'IndependentPanel.html',
            enabled: true,
          });
          console.debug(`[background] Side panel options set for tab ${tabId} using Browser.sidePanel`);
          sidePanelSet = true;
        }
      } catch (browserError) {
        console.warn('[background] Browser.sidePanel.setOptions failed:', browserError.message);
        // Fallback will be attempted below if sidePanelSet is still false
      }

      if (!sidePanelSet) {
        // eslint-disable-next-line no-undef
        if (typeof chrome !== 'undefined' && chrome.sidePanel && typeof chrome.sidePanel.setOptions === 'function') {
          console.debug('[background] Attempting chrome.sidePanel.setOptions as fallback.');
          try {
            // eslint-disable-next-line no-undef
            await chrome.sidePanel.setOptions({
              tabId,
              path: 'IndependentPanel.html',
              enabled: true,
            });
            console.debug(`[background] Side panel options set for tab ${tabId} using chrome.sidePanel`);
            sidePanelSet = true;
          } catch (chromeError) {
            console.error('[background] chrome.sidePanel.setOptions also failed:', chromeError.message);
          }
        }
      }

      if (!sidePanelSet) {
        console.warn('[background] SidePanel API (Browser.sidePanel or chrome.sidePanel) not available or setOptions failed in this browser. Side panel options not set for tab:', tabId);
      }
    } catch (error) { // This is the outer try-catch from the original code
      outerTryCatchError(error);
    }
  });
} catch (error) {
  console.error('[background] Error setting up webRequest or tabs listeners:', error)
}

try {
  registerPortListener(async (session, port, config) => {
    console.debug(
      `[background] Port listener triggered for session: ${session.modelName}, port: ${port.name}`,
    )
    try {
      await executeApi(session, port, config)
    } catch (e) {
      console.error(
        `[background] Error in port listener callback executing API for session ${session.modelName}:`,
        e,
      )
      port.postMessage({ error: e.message || 'An unexpected error occurred in port listener' })
    }
  })
  console.log('[background] Port listener registered successfully.')
} catch (error) {
  console.error('[background] Error registering port listener:', error)
}

try {
  registerCommands()
  console.log('[background] Commands registered successfully.')
} catch (error) {
  console.error('[background] Error registering commands:', error)
}

try {
  refreshMenu()
  console.log('[background] Menu refreshed successfully.')
} catch (error) {
  console.error('[background] Error refreshing menu:', error)
}
