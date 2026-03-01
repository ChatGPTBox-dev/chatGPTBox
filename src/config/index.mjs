import { defaults } from 'lodash-es'
import Browser from 'webextension-polyfill'
import { isMobile } from '../utils/is-mobile.mjs'
import {
  isInApiModeGroup,
  isUsingModelName,
  modelNameToDesc,
} from '../utils/model-name-convert.mjs'
import { t } from 'i18next'
import {
  LEGACY_SECRET_KEY_TO_PROVIDER_ID,
  OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID as API_MODE_GROUP_TO_PROVIDER_ID,
} from './openai-provider-mappings.mjs'

export const TriggerMode = {
  always: 'Always',
  questionMark: 'When query ends with question mark (?)',
  manually: 'Manually',
}

export const ThemeMode = {
  light: 'Light',
  dark: 'Dark',
  auto: 'Auto',
}

export const ModelMode = {
  balanced: 'Balanced',
  creative: 'Creative',
  precise: 'Precise',
  fast: 'Fast',
}

export const chatgptWebModelKeys = [
  'chatgptFree35',
  'chatgptFree4oMini',
  'chatgptPlus4',
  'chatgptFree35Mobile',
  'chatgptPlus4Browsing',
  'chatgptPlus4Mobile',
]
export const bingWebModelKeys = ['bingFree4', 'bingFreeSydney']
export const bardWebModelKeys = ['bardWebFree']
export const claudeWebModelKeys = ['claude2WebFree']
export const moonshotWebModelKeys = [
  'moonshotWebFree',
  'moonshotWebFreeK15',
  'moonshotWebFreeK15Think',
]
export const gptApiModelKeys = ['gptApiInstruct']
export const chatgptApiModelKeys = [
  'chatgptApi35',
  'chatgptApi35_16k',
  'chatgptApi35_1106',
  'chatgptApi35_0125',
  'chatgptApi4o_128k',
  'chatgptApi5Latest',
  'chatgptApi5_1Latest',
  'chatgptApi4oMini',
  'chatgptApi4_8k',
  'chatgptApi4_8k_0613',
  'chatgptApi4_128k',
  'chatgptApi4_128k_preview',
  'chatgptApi4_128k_1106_preview',
  'chatgptApi4_128k_0125_preview',
  'chatgptApi4_1',
  'chatgptApi4_1_mini',
  'chatgptApi4_1_nano',
]
export const customApiModelKeys = ['customModel']
export const ollamaApiModelKeys = ['ollamaModel']
export const azureOpenAiApiModelKeys = ['azureOpenAi']
export const claudeApiModelKeys = [
  'claude3HaikuApi',
  'claude35HaikuApi',
  'claude37SonnetApi',
  'claudeOpus4Api',
  'claudeOpus41Api',
  'claudeOpus45Api',
  'claudeOpus46Api',
  'claudeSonnet4Api',
  'claudeSonnet45Api',
  'claudeHaiku45Api',
]
export const chatglmApiModelKeys = ['chatglmTurbo', 'chatglm4', 'chatglmEmohaa', 'chatglmCharGLM3']
export const githubThirdPartyApiModelKeys = ['waylaidwandererApi']
export const poeWebModelKeys = [
  'poeAiWebSage', //poe.com/Assistant
  'poeAiWebGPT4',
  'poeAiWebGPT4_32k',
  'poeAiWebClaudePlus',
  'poeAiWebClaude',
  'poeAiWebClaude100k',
  'poeAiWebCustom',
  'poeAiWebChatGpt',
  'poeAiWebChatGpt_16k',
  'poeAiWebGooglePaLM',
  'poeAiWeb_Llama_2_7b',
  'poeAiWeb_Llama_2_13b',
  'poeAiWeb_Llama_2_70b',
]
export const moonshotApiModelKeys = [
  'moonshot_k2',
  'moonshot_kimi_latest',
  'moonshot_v1_8k',
  'moonshot_v1_32k',
  'moonshot_v1_128k',
]
export const deepSeekApiModelKeys = ['deepseek_chat', 'deepseek_reasoner']
export const openRouterApiModelKeys = [
  'openRouter_google_gemini_3_pro',
  'openRouter_google_gemini_3_flash',
  'openRouter_google_gemini_3_1_pro',
  'openRouter_anthropic_claude_sonnet4',
  'openRouter_anthropic_claude_sonnet4_5',
  'openRouter_anthropic_claude_opus4_5',
  'openRouter_anthropic_claude_opus4_6',
  'openRouter_anthropic_claude_haiku4_5',
  'openRouter_anthropic_claude_3_7_sonnet',
  'openRouter_google_gemini_2_5_pro',
  'openRouter_google_gemini_2_5_flash',
  'openRouter_openai_o3',
  'openRouter_openai_gpt_4_1_mini',
]
export const aimlApiModelKeys = [
  'aiml_claude_3_7_sonnet_20250219',
  'aiml_openai_o3_2025_04_16',
  'aiml_openai_gpt_4_1_2025_04_14',
  'aiml_moonshot_kimi_k2_preview',
]

export const AlwaysCustomGroups = [
  'ollamaApiModelKeys',
  'customApiModelKeys',
  'azureOpenAiApiModelKeys',
]
export const CustomUrlGroups = ['customApiModelKeys']
export const CustomApiKeyGroups = ['customApiModelKeys']
export const ModelGroups = {
  chatgptWebModelKeys: {
    value: chatgptWebModelKeys,
    desc: 'ChatGPT (Web)',
  },
  claudeWebModelKeys: {
    value: claudeWebModelKeys,
    desc: 'Claude.ai (Web)',
  },
  moonshotWebModelKeys: {
    value: moonshotWebModelKeys,
    desc: 'Kimi.Moonshot (Web)',
  },
  bingWebModelKeys: {
    value: bingWebModelKeys,
    desc: 'Bing (Web)',
  },
  bardWebModelKeys: {
    value: bardWebModelKeys,
    desc: 'Gemini (Web)',
  },

  chatgptApiModelKeys: {
    value: chatgptApiModelKeys,
    desc: 'ChatGPT (API)',
  },
  claudeApiModelKeys: {
    value: claudeApiModelKeys,
    desc: 'Claude.ai (API)',
  },
  moonshotApiModelKeys: {
    value: moonshotApiModelKeys,
    desc: 'Kimi.Moonshot (API)',
  },
  chatglmApiModelKeys: {
    value: chatglmApiModelKeys,
    desc: 'ChatGLM (API)',
  },
  ollamaApiModelKeys: {
    value: ollamaApiModelKeys,
    desc: 'Ollama (API)',
  },
  azureOpenAiApiModelKeys: {
    value: azureOpenAiApiModelKeys,
    desc: 'ChatGPT (Azure API)',
  },
  gptApiModelKeys: {
    value: gptApiModelKeys,
    desc: 'GPT Completion (API)',
  },
  githubThirdPartyApiModelKeys: {
    value: githubThirdPartyApiModelKeys,
    desc: 'Github Third Party Waylaidwanderer (API)',
  },
  deepSeekApiModelKeys: {
    value: deepSeekApiModelKeys,
    desc: 'DeepSeek (API)',
  },
  openRouterApiModelKeys: {
    value: openRouterApiModelKeys,
    desc: 'OpenRouter (API)',
  },
  aimlModelKeys: {
    value: aimlApiModelKeys,
    desc: 'AI/ML (API)',
  },
  customApiModelKeys: {
    value: customApiModelKeys,
    desc: 'Custom Model',
  },
}

/**
 * @typedef {object} Model
 * @property {string} value
 * @property {string} desc
 */
/**
 * @type {Object.<string,Model>}
 */
export const Models = {
  chatgptFree35: { value: 'auto', desc: 'ChatGPT (Web)' },

  chatgptFree4oMini: { value: 'gpt-4o-mini', desc: 'ChatGPT (Web, GPT-4o mini)' },

  chatgptPlus4: { value: 'gpt-4', desc: 'ChatGPT (Web, GPT-4)' },
  chatgptPlus4Browsing: { value: 'gpt-4', desc: 'ChatGPT (Web, GPT-4)' }, // for compatibility

  chatgptApi35: { value: 'gpt-3.5-turbo', desc: 'ChatGPT (GPT-3.5-turbo)' },
  chatgptApi35_16k: { value: 'gpt-3.5-turbo-16k', desc: 'ChatGPT (GPT-3.5-turbo-16k)' },

  chatgptApi4o_128k: { value: 'gpt-4o', desc: 'ChatGPT (GPT-4o, 128k)' },
  chatgptApi4oMini: { value: 'gpt-4o-mini', desc: 'ChatGPT (GPT-4o mini)' },
  chatgptApi4_8k: { value: 'gpt-4', desc: 'ChatGPT (GPT-4-8k)' },
  chatgptApi4_128k: {
    value: 'gpt-4-turbo',
    desc: 'ChatGPT (GPT-4-Turbo 128k)',
  },
  chatgptApi4_128k_preview: {
    value: 'gpt-4-turbo-preview',
    desc: 'ChatGPT (GPT-4-Turbo 128k Preview)',
  },
  chatgptApi4_128k_1106_preview: {
    value: 'gpt-4-1106-preview',
    desc: 'ChatGPT (GPT-4-Turbo 128k 1106 Preview)',
  },
  chatgptApi4_128k_0125_preview: {
    value: 'gpt-4-0125-preview',
    desc: 'ChatGPT (GPT-4-Turbo 128k 0125 Preview)',
  },
  chatgptApi5Latest: { value: 'gpt-5-chat-latest', desc: 'ChatGPT (ChatGPT-5 latest)' },
  chatgptApi5_1Latest: { value: 'gpt-5.1-chat-latest', desc: 'ChatGPT (ChatGPT-5.1 latest)' },

  chatgptApi4_1: { value: 'gpt-4.1', desc: 'ChatGPT (GPT-4.1)' },
  chatgptApi4_1_mini: { value: 'gpt-4.1-mini', desc: 'ChatGPT (GPT-4.1 mini)' },
  chatgptApi4_1_nano: { value: 'gpt-4.1-nano', desc: 'ChatGPT (GPT-4.1 nano)' },

  claude2WebFree: { value: '', desc: 'Claude.ai (Web)' },
  claude3HaikuApi: {
    value: 'claude-3-haiku-20240307',
    desc: 'Claude.ai (API, Claude 3 Haiku)',
  },
  claude35HaikuApi: {
    value: 'claude-3-5-haiku-20241022',
    desc: 'Claude.ai (API, Claude 3.5 Haiku)',
  },
  claude37SonnetApi: {
    value: 'claude-3-7-sonnet-20250219',
    desc: 'Claude.ai (API, Claude 3.7 Sonnet)',
  },
  claudeOpus4Api: {
    value: 'claude-opus-4-20250514',
    desc: 'Claude.ai (API, Claude Opus 4)',
  },
  claudeOpus41Api: {
    value: 'claude-opus-4-1-20250805',
    desc: 'Claude.ai (API, Claude Opus 4.1)',
  },
  claudeOpus45Api: {
    value: 'claude-opus-4-5',
    desc: 'Claude.ai (API, Claude Opus 4.5)',
  },
  claudeOpus46Api: {
    value: 'claude-opus-4-6',
    desc: 'Claude.ai (API, Claude Opus 4.6)',
  },
  claudeSonnet4Api: {
    value: 'claude-sonnet-4-20250514',
    desc: 'Claude.ai (API, Claude Sonnet 4)',
  },
  claudeSonnet45Api: {
    value: 'claude-sonnet-4-5-20250929',
    desc: 'Claude.ai (API, Claude Sonnet 4.5)',
  },
  claudeHaiku45Api: {
    value: 'claude-haiku-4-5-20251001',
    desc: 'Claude.ai (API, Claude Haiku 4.5)',
  },

  bingFree4: { value: '', desc: 'Bing (Web, GPT-4)' },
  bingFreeSydney: { value: '', desc: 'Bing (Web, GPT-4, Sydney)' },

  moonshotWebFree: { value: 'k2', desc: 'Kimi.Moonshot (Web k2, 128K)' },
  moonshotWebFreeK15: { value: 'k1.5', desc: 'Kimi.Moonshot (Web k1.5, 128k)' },
  moonshotWebFreeK15Think: {
    value: 'k1.5-thinking',
    desc: 'Kimi.Moonshot (Web k1.5 Thinking, 128k)',
  },

  bardWebFree: { value: '', desc: 'Gemini (Web)' },

  chatglmTurbo: { value: 'GLM-4-Air', desc: 'ChatGLM (GLM-4-Air, 128k)' },
  chatglm4: { value: 'GLM-4-0520', desc: 'ChatGLM (GLM-4-0520, 128k)' },
  chatglmEmohaa: { value: 'Emohaa', desc: 'ChatGLM (Emohaa)' },
  chatglmCharGLM3: { value: 'CharGLM-3', desc: 'ChatGLM (CharGLM-3)' },

  chatgptFree35Mobile: { value: 'text-davinci-002-render-sha-mobile', desc: 'ChatGPT (Mobile)' },
  chatgptPlus4Mobile: { value: 'gpt-4-mobile', desc: 'ChatGPT (Mobile, GPT-4)' },

  chatgptApi35_1106: { value: 'gpt-3.5-turbo-1106', desc: 'ChatGPT (GPT-3.5-turbo 1106)' },
  chatgptApi35_0125: { value: 'gpt-3.5-turbo-0125', desc: 'ChatGPT (GPT-3.5-turbo 0125)' },
  chatgptApi4_8k_0613: { value: 'gpt-4', desc: 'ChatGPT (GPT-4-8k 0613)' },

  gptApiInstruct: { value: 'gpt-3.5-turbo-instruct', desc: 'GPT-3.5-turbo Instruct' },

  customModel: { value: '', desc: 'Custom Model' },
  ollamaModel: { value: '', desc: 'Ollama API' },
  azureOpenAi: { value: '', desc: 'ChatGPT (Azure)' },
  waylaidwandererApi: { value: '', desc: 'Waylaidwanderer API (Github)' },

  poeAiWebSage: { value: 'Assistant', desc: 'Poe AI (Web, Assistant)' },
  poeAiWebGPT4: { value: 'gpt-4', desc: 'Poe AI (Web, GPT-4)' },
  poeAiWebGPT4_32k: { value: 'gpt-4-32k', desc: 'Poe AI (Web, GPT-4-32k)' },
  poeAiWebClaudePlus: { value: 'claude-2-100k', desc: 'Poe AI (Web, Claude 2 100k)' },
  poeAiWebClaude: { value: 'claude-instant', desc: 'Poe AI (Web, Claude instant)' },
  poeAiWebClaude100k: { value: 'claude-instant-100k', desc: 'Poe AI (Web, Claude instant 100k)' },
  poeAiWebGooglePaLM: { value: 'Google-PaLM', desc: 'Poe AI (Web, Google-PaLM)' },
  poeAiWeb_Llama_2_7b: { value: 'Llama-2-7b', desc: 'Poe AI (Web, Llama-2-7b)' },
  poeAiWeb_Llama_2_13b: { value: 'Llama-2-13b', desc: 'Poe AI (Web, Llama-2-13b)' },
  poeAiWeb_Llama_2_70b: { value: 'Llama-2-70b', desc: 'Poe AI (Web, Llama-2-70b)' },
  poeAiWebChatGpt: { value: 'chatgpt', desc: 'Poe AI (Web, ChatGPT)' },
  poeAiWebChatGpt_16k: { value: 'chatgpt-16k', desc: 'Poe AI (Web, ChatGPT-16k)' },
  poeAiWebCustom: { value: '', desc: 'Poe AI (Web, Custom)' },

  moonshot_k2: {
    value: 'kimi-k2-0711-preview',
    desc: 'Kimi.Moonshot (k2)',
  },
  moonshot_kimi_latest: {
    value: 'kimi-latest',
    desc: 'Kimi.Moonshot (kimi-latest)',
  },
  moonshot_v1_8k: {
    value: 'moonshot-v1-8k',
    desc: 'Kimi.Moonshot (8k)',
  },
  moonshot_v1_32k: {
    value: 'moonshot-v1-32k',
    desc: 'Kimi.Moonshot (32k)',
  },
  moonshot_v1_128k: {
    value: 'moonshot-v1-128k',
    desc: 'Kimi.Moonshot (128k)',
  },

  deepseek_chat: {
    value: 'deepseek-chat',
    desc: 'DeepSeek (Chat)',
  },
  deepseek_reasoner: {
    value: 'deepseek-reasoner',
    desc: 'DeepSeek (Reasoner)',
  },

  openRouter_anthropic_claude_sonnet4: {
    value: 'anthropic/claude-sonnet-4',
    desc: 'OpenRouter (Claude Sonnet 4)',
  },
  openRouter_anthropic_claude_sonnet4_5: {
    value: 'anthropic/claude-sonnet-4.5',
    desc: 'OpenRouter (Claude Sonnet 4.5)',
  },
  openRouter_anthropic_claude_haiku4_5: {
    value: 'anthropic/claude-haiku-4.5',
    desc: 'OpenRouter (Claude Haiku 4.5)',
  },
  openRouter_anthropic_claude_opus4_5: {
    value: 'anthropic/claude-opus-4.5',
    desc: 'OpenRouter (Claude Opus 4.5)',
  },
  openRouter_anthropic_claude_opus4_6: {
    value: 'anthropic/claude-opus-4.6',
    desc: 'OpenRouter (Claude Opus 4.6)',
  },
  openRouter_anthropic_claude_3_7_sonnet: {
    value: 'anthropic/claude-3.7-sonnet',
    desc: 'OpenRouter (Claude 3.7 Sonnet)',
  },
  openRouter_google_gemini_3_pro: {
    value: 'google/gemini-3-pro-preview',
    desc: 'OpenRouter (Gemini 3 Pro)',
  },
  openRouter_google_gemini_3_flash: {
    value: 'google/gemini-3-flash-preview',
    desc: 'OpenRouter (Gemini 3 Flash)',
  },
  openRouter_google_gemini_3_1_pro: {
    value: 'google/gemini-3.1-pro-preview',
    desc: 'OpenRouter (Gemini 3.1 Pro)',
  },
  openRouter_google_gemini_2_5_pro: {
    value: 'google/gemini-2.5-pro',
    desc: 'OpenRouter (Gemini 2.5 Pro)',
  },
  openRouter_google_gemini_2_5_flash: {
    value: 'google/gemini-2.5-flash',
    desc: 'OpenRouter (Gemini 2.5 Flash)',
  },
  openRouter_openai_o3: {
    value: 'openai/o3',
    desc: 'OpenRouter (GPT-o3)',
  },
  openRouter_openai_gpt_4_1_mini: {
    value: 'openai/gpt-4.1-mini',
    desc: 'OpenRouter (GPT-4.1 Mini)',
  },
  aiml_claude_3_7_sonnet_20250219: {
    value: 'claude-3-7-sonnet-20250219',
    desc: 'AIML (Claude 3.7 Sonnet)',
  },
  aiml_openai_o3_2025_04_16: {
    value: 'openai/o3-2025-04-16',
    desc: 'AIML (GPT-o3)',
  },
  aiml_openai_gpt_4_1_2025_04_14: {
    value: 'openai/gpt-4.1-2025-04-14',
    desc: 'AIML (GPT-4.1)',
  },
  aiml_moonshot_kimi_k2_preview: {
    value: 'moonshot/kimi-k2-preview',
    desc: 'AIML (Kimi K2)',
  },
}

for (const modelName in Models) {
  if (isUsingMultiModeModel({ modelName }))
    for (const mode in ModelMode) {
      const key = `${modelName}-${mode}`
      Models[key] = {
        value: mode,
        desc: modelNameToDesc(key, t),
      }
    }
}

/**
 * @typedef {typeof defaultConfig} UserConfig
 */
export const defaultConfig = {
  // general

  /** @type {keyof TriggerMode}*/
  triggerMode: 'manually',
  /** @type {keyof ThemeMode}*/
  themeMode: 'auto',
  /** @type {keyof Models}*/
  modelName: getNavigatorLanguage() === 'zh' ? 'moonshotWebFree' : 'claude2WebFree',
  apiMode: null,

  preferredLanguage: getNavigatorLanguage(),
  clickIconAction: 'popup',
  insertAtTop: isMobile(),
  alwaysFloatingSidebar: false,
  allowEscToCloseAll: false,
  lockWhenAnswer: true,
  answerScrollMargin: 200,
  autoRegenAfterSwitchModel: false,
  selectionToolsNextToInputBox: false,
  alwaysPinWindow: false,
  focusAfterAnswer: true,

  apiKey: '', // openai ApiKey

  azureApiKey: '',
  azureEndpoint: '',
  azureDeploymentName: '',

  poeCustomBotName: '',

  claudeApiKey: '',
  chatglmApiKey: '',
  moonshotApiKey: '',
  deepSeekApiKey: '',

  customApiKey: '',

  /** @type {keyof ModelMode}*/
  modelMode: 'balanced',

  customModelApiUrl: 'http://localhost:8000/v1/chat/completions',
  customModelName: 'gpt-4.1',
  githubThirdPartyUrl: 'http://127.0.0.1:3000/conversation',

  ollamaEndpoint: 'http://127.0.0.1:11434',
  ollamaModelName: 'llama4',
  ollamaApiKey: '',
  ollamaKeepAliveTime: '5m',

  openRouterApiKey: '',
  aimlApiKey: '',

  // advanced

  maxResponseTokenLength: 2000,
  maxConversationContextLength: 9,
  temperature: 1,
  customChatGptWebApiUrl: 'https://chatgpt.com',
  customChatGptWebApiPath: '/backend-api/conversation',
  customOpenAiApiUrl: 'https://api.openai.com',
  customClaudeApiUrl: 'https://api.anthropic.com',
  disableWebModeHistory: true,
  hideContextMenu: false,
  cropText: true,
  siteRegex: 'match nothing',
  useSiteRegexOnly: false,
  inputQuery: '',
  appendQuery: '',
  prependQuery: '',

  // others

  alwaysCreateNewConversationWindow: false,
  // The handling of activeApiModes and customApiModes is somewhat complex.
  // It does not directly convert activeApiModes into customApiModes, which is for compatibility considerations.
  // It allows the content of activeApiModes to change with version updates when the user has not customized ApiModes.
  // If it were directly written into customApiModes, the value would become fixed, even if the user has not made any customizations.
  activeApiModes: [
    'chatgptFree35',
    'claude2WebFree',
    'moonshotWebFree',
    'ollamaModel',
    'customModel',
    'azureOpenAi',
    'openRouter_anthropic_claude_sonnet4_5',
    'openRouter_google_gemini_2_5_pro',
    'openRouter_openai_o3',
  ],
  customApiModes: [
    {
      groupName: '',
      itemName: '',
      isCustom: false,
      customName: '',
      customUrl: '',
      apiKey: '',
      providerId: '',
      active: false,
    },
  ],
  customOpenAIProviders: [],
  providerSecrets: {},
  configSchemaVersion: 1,
  activeSelectionTools: ['translate', 'translateToEn', 'summary', 'polish', 'code', 'ask'],
  customSelectionTools: [
    {
      name: '',
      iconKey: 'explain',
      prompt: 'sample prompt: {{selection}}',
      active: false,
    },
  ],
  activeSiteAdapters: [
    'bilibili',
    'github',
    'gitlab',
    'quora',
    'reddit',
    'youtube',
    'zhihu',
    'stackoverflow',
    'juejin',
    'mp.weixin.qq',
    'followin',
    'arxiv',
  ],
  accessToken: '',
  tokenSavedOn: 0,
  bingAccessToken: '',
  notificationJumpBackTabId: 0,
  chatgptTabId: 0,
  chatgptArkoseReqUrl: '',
  chatgptArkoseReqForm: '',
  kimiMoonShotRefreshToken: '',
  kimiMoonShotAccessToken: '',

  // unchangeable

  userLanguage: getNavigatorLanguage(),
  apiModes: Object.keys(Models),
  chatgptArkoseReqParams: 'cgb=vhwi',
  selectionTools: [
    'explain',
    'translate',
    'translateToEn',
    'summary',
    'polish',
    'sentiment',
    'divide',
    'code',
    'ask',
  ],
  selectionToolsDesc: [
    'Explain',
    'Translate',
    'Translate (To English)',
    'Summary',
    'Polish',
    'Sentiment Analysis',
    'Divide Paragraphs',
    'Code Explain',
    'Ask',
  ],
  // importing configuration will result in gpt-3-encoder being packaged into the output file
  siteAdapters: [
    'bilibili',
    'github',
    'gitlab',
    'quora',
    'reddit',
    'youtube',
    'zhihu',
    'stackoverflow',
    'juejin',
    'mp.weixin.qq',
    'followin',
    'arxiv',
  ],
}

export function getNavigatorLanguage() {
  const l = navigator.language.toLowerCase()
  if (['zh-hk', 'zh-mo', 'zh-tw', 'zh-cht', 'zh-hant'].includes(l)) return 'zhHant'
  return navigator.language.substring(0, 2)
}

export function isUsingChatgptWebModel(configOrSession) {
  return isInApiModeGroup(chatgptWebModelKeys, configOrSession)
}

export function isUsingClaudeWebModel(configOrSession) {
  return isInApiModeGroup(claudeWebModelKeys, configOrSession)
}

export function isUsingMoonshotWebModel(configOrSession) {
  return isInApiModeGroup(moonshotWebModelKeys, configOrSession)
}

export function isUsingBingWebModel(configOrSession) {
  return isInApiModeGroup(bingWebModelKeys, configOrSession)
}

export function isUsingMultiModeModel(configOrSession) {
  return isInApiModeGroup(bingWebModelKeys, configOrSession)
}

export function isUsingGeminiWebModel(configOrSession) {
  return isInApiModeGroup(bardWebModelKeys, configOrSession)
}

export function isUsingChatgptApiModel(configOrSession) {
  return isInApiModeGroup(chatgptApiModelKeys, configOrSession)
}

export function isUsingGptCompletionApiModel(configOrSession) {
  return isInApiModeGroup(gptApiModelKeys, configOrSession)
}

export function isUsingOpenAiApiModel(configOrSession) {
  return isUsingChatgptApiModel(configOrSession) || isUsingGptCompletionApiModel(configOrSession)
}

export function isUsingClaudeApiModel(configOrSession) {
  return isInApiModeGroup(claudeApiModelKeys, configOrSession)
}

export function isUsingMoonshotApiModel(configOrSession) {
  return isInApiModeGroup(moonshotApiModelKeys, configOrSession)
}

export function isUsingDeepSeekApiModel(configOrSession) {
  return isInApiModeGroup(deepSeekApiModelKeys, configOrSession)
}

export function isUsingOpenRouterApiModel(configOrSession) {
  return isInApiModeGroup(openRouterApiModelKeys, configOrSession)
}

export function isUsingAimlApiModel(configOrSession) {
  return isInApiModeGroup(aimlApiModelKeys, configOrSession)
}

export function isUsingChatGLMApiModel(configOrSession) {
  return isInApiModeGroup(chatglmApiModelKeys, configOrSession)
}

export function isUsingOllamaApiModel(configOrSession) {
  return isInApiModeGroup(ollamaApiModelKeys, configOrSession)
}

export function isUsingAzureOpenAiApiModel(configOrSession) {
  return isInApiModeGroup(azureOpenAiApiModelKeys, configOrSession)
}

export function isUsingGithubThirdPartyApiModel(configOrSession) {
  return isInApiModeGroup(githubThirdPartyApiModelKeys, configOrSession)
}

export function isUsingCustomModel(configOrSession) {
  return isInApiModeGroup(customApiModelKeys, configOrSession)
}

/**
 * @deprecated
 */
export function isUsingCustomNameOnlyModel(configOrSession) {
  return isUsingModelName('poeAiWebCustom', configOrSession)
}

export async function getPreferredLanguageKey() {
  const config = await getUserConfig()
  if (config.preferredLanguage === 'auto') return config.userLanguage
  return config.preferredLanguage
}

const CONFIG_SCHEMA_VERSION = 1

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeProviderId(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeEndpointUrlForCompare(value) {
  return normalizeText(value).replace(/\/+$/, '')
}

function areStringRecordValuesEqual(leftRecord, rightRecord) {
  const leftIsRecord =
    Boolean(leftRecord) && typeof leftRecord === 'object' && !Array.isArray(leftRecord)
  const rightIsRecord =
    Boolean(rightRecord) && typeof rightRecord === 'object' && !Array.isArray(rightRecord)
  if (!leftIsRecord || !rightIsRecord) {
    return !leftIsRecord && !rightIsRecord && leftRecord === rightRecord
  }
  const left = leftRecord
  const right = rightRecord
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false
    if (normalizeText(left[key]) !== normalizeText(right[key])) return false
  }
  return true
}

function ensureUniqueProviderId(providerIdSet, preferredId) {
  let id = preferredId || 'custom-provider'
  let suffix = 2
  while (providerIdSet.has(id)) {
    id = `${preferredId || 'custom-provider'}-${suffix}`
    suffix += 1
  }
  return id
}

function normalizeCustomProviderForStorage(provider, index, providerIdSet) {
  if (!provider || typeof provider !== 'object') return null
  const originalRawId = normalizeText(provider.id)
  const originalId = normalizeProviderId(provider.id)
  const preferredId = originalId || `custom-provider-${index + 1}`
  const id = ensureUniqueProviderId(providerIdSet, preferredId)
  providerIdSet.add(id)
  return {
    originalId,
    originalRawId,
    provider: {
      id,
      name: normalizeText(provider.name) || `Custom Provider ${index + 1}`,
      baseUrl: normalizeText(provider.baseUrl),
      chatCompletionsPath: normalizeText(provider.chatCompletionsPath) || '/v1/chat/completions',
      completionsPath: normalizeText(provider.completionsPath) || '/v1/completions',
      chatCompletionsUrl: normalizeText(provider.chatCompletionsUrl),
      completionsUrl: normalizeText(provider.completionsUrl),
      enabled: provider.enabled !== false,
      allowLegacyResponseField: Boolean(provider.allowLegacyResponseField),
    },
  }
}

function migrateUserConfig(options) {
  const migrated = { ...options }
  let dirty = false

  if (migrated.customChatGptWebApiUrl === 'https://chat.openai.com') {
    migrated.customChatGptWebApiUrl = 'https://chatgpt.com'
    dirty = true
  }

  const providerSecrets =
    migrated.providerSecrets && typeof migrated.providerSecrets === 'object'
      ? { ...migrated.providerSecrets }
      : {}
  if (!(migrated.providerSecrets && typeof migrated.providerSecrets === 'object')) {
    dirty = true
  }
  for (const [legacyKey, providerId] of Object.entries(LEGACY_SECRET_KEY_TO_PROVIDER_ID)) {
    const legacyKeyValue = normalizeText(migrated[legacyKey])
    const existingProviderSecret = normalizeText(providerSecrets[providerId])
    if (legacyKeyValue && !existingProviderSecret) {
      providerSecrets[providerId] = legacyKeyValue
      dirty = true
    }
  }

  const builtinProviderIds = new Set(
    Object.values(API_MODE_GROUP_TO_PROVIDER_ID)
      .map((providerId) => normalizeText(providerId))
      .filter((providerId) => providerId),
  )
  const providerIdSet = new Set(builtinProviderIds)
  const providerIdRenameLookup = new Map()
  const providerIdRenames = []
  const rawCustomOpenAIProviders = Array.isArray(migrated.customOpenAIProviders)
    ? migrated.customOpenAIProviders
    : []
  const legacyCustomProviderIds = new Set(
    rawCustomOpenAIProviders
      .map((provider) => normalizeProviderId(provider?.id))
      .filter((providerId) => providerId),
  )
  const normalizedProviderResults = rawCustomOpenAIProviders
    .map((provider, index) => normalizeCustomProviderForStorage(provider, index, providerIdSet))
    .filter((result) => result && result.provider)
  const unchangedProviderIds = new Set(
    normalizedProviderResults
      .filter(
        ({ originalId, provider }) => originalId && originalId === normalizeProviderId(provider.id),
      )
      .map(({ provider }) => normalizeProviderId(provider.id))
      .filter((id) => id),
  )
  const customOpenAIProviders = normalizedProviderResults.map(
    ({ originalId, originalRawId, provider }) => {
      if (originalId && originalId !== provider.id) {
        providerIdRenames.push({ oldId: originalId, oldRawId: originalRawId, newId: provider.id })
        if (!providerIdRenameLookup.has(originalId) && !unchangedProviderIds.has(originalId)) {
          providerIdRenameLookup.set(originalId, provider.id)
        }
        dirty = true
      }
      return provider
    },
  )
  if (!Array.isArray(migrated.customOpenAIProviders)) dirty = true

  for (let index = providerIdRenames.length - 1; index >= 0; index -= 1) {
    const {
      oldId: oldProviderId,
      oldRawId: oldRawProviderId,
      newId: newProviderId,
    } = providerIdRenames[index]
    if (oldProviderId === newProviderId) continue
    if (!legacyCustomProviderIds.has(oldProviderId)) continue
    const rawIdSecret = normalizeText(providerSecrets[oldRawProviderId])
    const normalizedIdSecret = normalizeText(providerSecrets[oldProviderId])
    const oldSecret = rawIdSecret || normalizedIdSecret
    if (oldSecret && normalizeText(providerSecrets[newProviderId]) !== oldSecret) {
      providerSecrets[newProviderId] = oldSecret
      dirty = true
    }
  }

  for (const { originalRawId, provider } of normalizedProviderResults) {
    const rawProviderId = normalizeText(originalRawId)
    const normalizedProviderId = normalizeText(provider?.id)
    if (!rawProviderId || !normalizedProviderId || rawProviderId === normalizedProviderId) continue
    const rawSecret = normalizeText(providerSecrets[rawProviderId])
    if (!rawSecret) continue
    if (!normalizeText(providerSecrets[normalizedProviderId])) {
      providerSecrets[normalizedProviderId] = rawSecret
      dirty = true
    }
  }

  const customApiModes = Array.isArray(migrated.customApiModes)
    ? migrated.customApiModes.map((apiMode) => ({ ...apiMode }))
    : []
  if (!Array.isArray(migrated.customApiModes)) dirty = true

  let customProviderCounter = customOpenAIProviders.length
  let customApiModesDirty = false
  let customProvidersDirty = false
  const legacyCustomProviderSecret = normalizeText(providerSecrets['legacy-custom-default'])
  for (const apiMode of customApiModes) {
    if (!apiMode || typeof apiMode !== 'object') continue
    if (apiMode.groupName !== 'customApiModelKeys') {
      const nonCustomApiModeKey = normalizeText(apiMode.apiKey)
      if (nonCustomApiModeKey) {
        const targetProviderId =
          API_MODE_GROUP_TO_PROVIDER_ID[normalizeText(apiMode.groupName)] ||
          normalizeText(apiMode.providerId)
        if (targetProviderId) {
          if (!normalizeText(providerSecrets[targetProviderId])) {
            providerSecrets[targetProviderId] = nonCustomApiModeKey
            dirty = true
          }
          apiMode.apiKey = ''
          customApiModesDirty = true
        }
      }
      if (normalizeText(apiMode.providerId)) {
        apiMode.providerId = ''
        customApiModesDirty = true
      }
      continue
    }

    const existingProviderIdRaw = typeof apiMode.providerId === 'string' ? apiMode.providerId : ''
    const existingProviderId = normalizeProviderId(existingProviderIdRaw)
    if (existingProviderId && existingProviderIdRaw !== existingProviderId) {
      apiMode.providerId = existingProviderId
      customApiModesDirty = true
    }
    let providerIdAssignedFromLegacyCustomUrl = false
    const renamedProviderId = providerIdRenameLookup.get(existingProviderId)
    if (renamedProviderId && normalizeText(apiMode.providerId) !== renamedProviderId) {
      apiMode.providerId = renamedProviderId
      customApiModesDirty = true
    }

    if (!normalizeText(apiMode.providerId)) {
      const customUrl = normalizeText(apiMode.customUrl)
      const normalizedCustomUrl = normalizeEndpointUrlForCompare(customUrl)
      if (customUrl) {
        const apiModeKeyForMatch = normalizeText(apiMode.apiKey)
        let provider = customOpenAIProviders.find((item) => {
          if (normalizeEndpointUrlForCompare(item.chatCompletionsUrl) !== normalizedCustomUrl)
            return false
          if (apiModeKeyForMatch) {
            const existingSecret = normalizeText(providerSecrets[item.id])
            if (existingSecret && existingSecret !== apiModeKeyForMatch) return false
          }
          return true
        })
        if (!provider) {
          customProviderCounter += 1
          const preferredId =
            normalizeProviderId(apiMode.customName) || `custom-provider-${customProviderCounter}`
          const providerId = ensureUniqueProviderId(providerIdSet, preferredId)
          providerIdSet.add(providerId)
          provider = {
            id: providerId,
            name: normalizeText(apiMode.customName) || `Custom Provider ${customProviderCounter}`,
            baseUrl: '',
            chatCompletionsPath: '/v1/chat/completions',
            completionsPath: '/v1/completions',
            chatCompletionsUrl: customUrl,
            completionsUrl: '',
            enabled: true,
            allowLegacyResponseField: true,
          }
          customOpenAIProviders.push(provider)
          customProvidersDirty = true
        }
        apiMode.providerId = provider.id
        if (normalizeText(apiMode.customUrl)) {
          apiMode.customUrl = ''
        }
        providerIdAssignedFromLegacyCustomUrl = true
      } else {
        apiMode.providerId = 'legacy-custom-default'
      }
      customApiModesDirty = true
    }

    const apiModeKey = normalizeText(apiMode.apiKey)
    if (apiModeKey) {
      const existingProviderSecret = normalizeText(providerSecrets[apiMode.providerId])
      if (!existingProviderSecret) {
        providerSecrets[apiMode.providerId] = apiModeKey
        dirty = true
      }
      // Mode-level custom keys are treated as legacy data; after migration,
      // providerSecrets is the single source of truth.
      apiMode.apiKey = ''
      customApiModesDirty = true
    } else if (legacyCustomProviderSecret && providerIdAssignedFromLegacyCustomUrl) {
      const existingProviderSecret = normalizeText(providerSecrets[apiMode.providerId])
      if (!existingProviderSecret) {
        providerSecrets[apiMode.providerId] = legacyCustomProviderSecret
        dirty = true
      }
    }
  }

  if (migrated.apiMode && typeof migrated.apiMode === 'object') {
    const selectedApiMode = { ...migrated.apiMode }
    let selectedApiModeDirty = false
    const selectedIsCustom = selectedApiMode.groupName === 'customApiModelKeys'
    let selectedProviderIdAssignedFromLegacyCustomUrl = false

    if (selectedIsCustom) {
      const existingSelectedProviderIdRaw =
        typeof selectedApiMode.providerId === 'string' ? selectedApiMode.providerId : ''
      const existingSelectedProviderId = normalizeProviderId(existingSelectedProviderIdRaw)
      if (
        existingSelectedProviderId &&
        existingSelectedProviderIdRaw !== existingSelectedProviderId
      ) {
        selectedApiMode.providerId = existingSelectedProviderId
        selectedApiModeDirty = true
      }
      const renamedSelectedProviderId = providerIdRenameLookup.get(existingSelectedProviderId)
      if (
        renamedSelectedProviderId &&
        normalizeText(selectedApiMode.providerId) !== renamedSelectedProviderId
      ) {
        selectedApiMode.providerId = renamedSelectedProviderId
        selectedApiModeDirty = true
      }
    }

    if (selectedIsCustom && !normalizeText(selectedApiMode.providerId)) {
      const customUrl = normalizeText(selectedApiMode.customUrl)
      const normalizedCustomUrl = normalizeEndpointUrlForCompare(customUrl)
      if (customUrl) {
        const selectedApiModeKeyForMatch = normalizeText(selectedApiMode.apiKey)
        let provider = customOpenAIProviders.find((item) => {
          if (normalizeEndpointUrlForCompare(item.chatCompletionsUrl) !== normalizedCustomUrl)
            return false
          if (selectedApiModeKeyForMatch) {
            const existingSecret = normalizeText(providerSecrets[item.id])
            if (existingSecret && existingSecret !== selectedApiModeKeyForMatch) return false
          }
          return true
        })
        if (!provider) {
          customProviderCounter += 1
          const preferredId =
            normalizeProviderId(selectedApiMode.customName) ||
            `custom-provider-${customProviderCounter}`
          const providerId = ensureUniqueProviderId(providerIdSet, preferredId)
          providerIdSet.add(providerId)
          provider = {
            id: providerId,
            name:
              normalizeText(selectedApiMode.customName) ||
              `Custom Provider ${customProviderCounter}`,
            baseUrl: '',
            chatCompletionsPath: '/v1/chat/completions',
            completionsPath: '/v1/completions',
            chatCompletionsUrl: customUrl,
            completionsUrl: '',
            enabled: true,
            allowLegacyResponseField: true,
          }
          customOpenAIProviders.push(provider)
          customProvidersDirty = true
        }
        selectedApiMode.providerId = provider.id
        if (normalizeText(selectedApiMode.customUrl)) {
          selectedApiMode.customUrl = ''
          selectedApiModeDirty = true
        }
        selectedProviderIdAssignedFromLegacyCustomUrl = true
      } else {
        selectedApiMode.providerId = 'legacy-custom-default'
      }
      selectedApiModeDirty = true
    }

    const selectedApiModeKey = normalizeText(selectedApiMode.apiKey)
    const selectedTargetProviderId = selectedIsCustom
      ? normalizeText(selectedApiMode.providerId) || 'legacy-custom-default'
      : API_MODE_GROUP_TO_PROVIDER_ID[normalizeText(selectedApiMode.groupName)] ||
        normalizeText(selectedApiMode.providerId)
    if (
      selectedIsCustom &&
      selectedProviderIdAssignedFromLegacyCustomUrl &&
      !selectedApiModeKey &&
      legacyCustomProviderSecret &&
      selectedTargetProviderId &&
      !normalizeText(providerSecrets[selectedTargetProviderId])
    ) {
      providerSecrets[selectedTargetProviderId] = legacyCustomProviderSecret
      dirty = true
    }
    if (selectedApiModeKey) {
      const targetProviderId = selectedIsCustom
        ? normalizeText(selectedApiMode.providerId) || 'legacy-custom-default'
        : API_MODE_GROUP_TO_PROVIDER_ID[normalizeText(selectedApiMode.groupName)] ||
          normalizeText(selectedApiMode.providerId)
      if (targetProviderId) {
        const existingProviderSecret = normalizeText(providerSecrets[targetProviderId])
        if (!existingProviderSecret) {
          providerSecrets[targetProviderId] = selectedApiModeKey
          dirty = true
        } else if (selectedIsCustom && existingProviderSecret !== selectedApiModeKey) {
          // Keep the currently selected custom mode effective after migration by
          // promoting its legacy mode-level key to providerSecrets.
          providerSecrets[targetProviderId] = selectedApiModeKey
          dirty = true
        }
        selectedApiMode.apiKey = ''
        selectedApiModeDirty = true
      }
    }

    if (!selectedIsCustom && normalizeText(selectedApiMode.providerId)) {
      selectedApiMode.providerId = ''
      selectedApiModeDirty = true
    }

    if (selectedApiModeDirty) {
      migrated.apiMode = selectedApiMode
      dirty = true
    }
  }

  if (customProvidersDirty) dirty = true
  if (customApiModesDirty) dirty = true

  if (migrated.configSchemaVersion !== CONFIG_SCHEMA_VERSION) {
    migrated.configSchemaVersion = CONFIG_SCHEMA_VERSION
    dirty = true
  }

  migrated.providerSecrets = providerSecrets
  migrated.customOpenAIProviders = customOpenAIProviders
  migrated.customApiModes = customApiModes

  // Reverse-sync providerSecrets to legacy fields for backward compatibility
  // so that older extension versions can still read the keys.
  for (const [legacyKey, providerId] of Object.entries(LEGACY_SECRET_KEY_TO_PROVIDER_ID)) {
    const providerSecret = normalizeText(providerSecrets[providerId])
    if (providerSecret && normalizeText(migrated[legacyKey]) !== providerSecret) {
      migrated[legacyKey] = providerSecret
      dirty = true
    }
  }

  return { migrated, dirty }
}

/**
 * get user config from local storage
 * @returns {Promise<UserConfig>}
 */
export async function getUserConfig() {
  const options = await Browser.storage.local.get(Object.keys(defaultConfig))
  const { migrated, dirty } = migrateUserConfig(options)
  if (dirty) {
    const payload = {}
    if (JSON.stringify(options.customApiModes) !== JSON.stringify(migrated.customApiModes)) {
      payload.customApiModes = migrated.customApiModes
    }
    if (
      JSON.stringify(options.customOpenAIProviders) !==
      JSON.stringify(migrated.customOpenAIProviders)
    ) {
      payload.customOpenAIProviders = migrated.customOpenAIProviders
    }
    if (!areStringRecordValuesEqual(options.providerSecrets, migrated.providerSecrets)) {
      payload.providerSecrets = migrated.providerSecrets
    }
    if (options.configSchemaVersion !== migrated.configSchemaVersion) {
      payload.configSchemaVersion = migrated.configSchemaVersion
    }
    if (migrated.customChatGptWebApiUrl !== undefined) {
      if (options.customChatGptWebApiUrl !== migrated.customChatGptWebApiUrl) {
        payload.customChatGptWebApiUrl = migrated.customChatGptWebApiUrl
      }
    }
    if (migrated.apiMode !== undefined) {
      if (JSON.stringify(options.apiMode ?? null) !== JSON.stringify(migrated.apiMode ?? null)) {
        payload.apiMode = migrated.apiMode
      }
    }
    for (const legacyKey of Object.keys(LEGACY_SECRET_KEY_TO_PROVIDER_ID)) {
      if (migrated[legacyKey] !== undefined) {
        if (options[legacyKey] !== migrated[legacyKey]) {
          payload[legacyKey] = migrated[legacyKey]
        }
      }
    }
    if (Object.keys(payload).length > 0) {
      await Browser.storage.local.set(payload)
    }
  }
  return defaults(migrated, defaultConfig)
}

/**
 * set user config to local storage
 * @param {Partial<UserConfig>} value
 */
export async function setUserConfig(value) {
  await Browser.storage.local.set(value)
}

export async function setAccessToken(accessToken) {
  await setUserConfig({ accessToken, tokenSavedOn: Date.now() })
}

const TOKEN_DURATION = 30 * 24 * 3600 * 1000

export async function clearOldAccessToken() {
  const duration = Date.now() - (await getUserConfig()).tokenSavedOn
  if (duration > TOKEN_DURATION) {
    await setAccessToken('')
  }
}
