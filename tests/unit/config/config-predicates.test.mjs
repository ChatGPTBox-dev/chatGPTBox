import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  getNavigatorLanguage,
  getPreferredLanguageKey,
  isUsingAimlApiModel,
  isUsingAzureOpenAiApiModel,
  isUsingBingWebModel,
  isUsingChatGLMApiModel,
  isUsingChatgptApiModel,
  isUsingClaudeApiModel,
  isUsingCustomModel,
  isUsingCustomNameOnlyModel,
  isUsingDeepSeekApiModel,
  isUsingGeminiWebModel,
  isUsingGithubThirdPartyApiModel,
  isUsingMoonshotApiModel,
  isUsingMoonshotWebModel,
  isUsingMultiModeModel,
  isUsingOllamaApiModel,
  isUsingOpenAiApiModel,
  isUsingOpenRouterApiModel,
} from '../../../src/config/index.mjs'

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

const restoreNavigator = () => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
  } else {
    delete globalThis.navigator
  }
}

const setNavigatorLanguage = (language) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language },
    configurable: true,
  })
}

afterEach(() => {
  restoreNavigator()
})

test('getNavigatorLanguage returns zhHant for zh-TW style locales', () => {
  setNavigatorLanguage('zh-TW')
  assert.equal(getNavigatorLanguage(), 'zhHant')
})

test('getNavigatorLanguage returns first two letters for non-zhHant locales', () => {
  setNavigatorLanguage('en-US')
  assert.equal(getNavigatorLanguage(), 'en')
})

test('getNavigatorLanguage normalizes mixed-case zh-TW locale to zhHant', () => {
  setNavigatorLanguage('ZH-TW')
  assert.equal(getNavigatorLanguage(), 'zhHant')
})

test('getNavigatorLanguage treats zh-Hant locale as zhHant', () => {
  setNavigatorLanguage('zh-Hant')
  assert.equal(getNavigatorLanguage(), 'zhHant')
})

test('isUsingChatgptApiModel detects chatgpt API models and excludes custom model', () => {
  assert.equal(isUsingChatgptApiModel({ modelName: 'chatgptApi4oMini' }), true)
  assert.equal(isUsingChatgptApiModel({ modelName: 'customModel' }), false)
})

test('isUsingOpenAiApiModel accepts both chat and completion API model groups', () => {
  assert.equal(isUsingOpenAiApiModel({ modelName: 'chatgptApi4oMini' }), true)
  assert.equal(isUsingOpenAiApiModel({ modelName: 'gptApiInstruct' }), true)
})

test('isUsingOpenAiApiModel excludes custom model', () => {
  assert.equal(isUsingOpenAiApiModel({ modelName: 'customModel' }), false)
})

test('isUsingCustomModel works with modelName and apiMode forms', () => {
  assert.equal(isUsingCustomModel({ modelName: 'customModel' }), true)

  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    customName: 'my-custom-model',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  assert.equal(isUsingCustomModel({ apiMode }), true)
})

test('isUsingMultiModeModel currently follows Bing web group behavior', () => {
  assert.equal(isUsingBingWebModel({ modelName: 'bingFree4' }), true)
  assert.equal(isUsingMultiModeModel({ modelName: 'bingFree4' }), true)
  assert.equal(isUsingBingWebModel({ modelName: 'chatgptFree35' }), false)
  assert.equal(isUsingMultiModeModel({ modelName: 'chatgptFree35' }), false)
})

// ── isUsing* predicate wrappers for remaining providers ──────────────

test('isUsingMoonshotWebModel detects moonshot web models', () => {
  assert.equal(isUsingMoonshotWebModel({ modelName: 'moonshotWebFree' }), true)
  assert.equal(isUsingMoonshotWebModel({ modelName: 'moonshotWebFreeK15' }), true)
  assert.equal(isUsingMoonshotWebModel({ modelName: 'chatgptFree35' }), false)
})

test('isUsingGeminiWebModel detects bard/gemini web models', () => {
  assert.equal(isUsingGeminiWebModel({ modelName: 'bardWebFree' }), true)
  assert.equal(isUsingGeminiWebModel({ modelName: 'chatgptFree35' }), false)
})

test('isUsingClaudeApiModel detects Claude API models', () => {
  assert.equal(isUsingClaudeApiModel({ modelName: 'claude37SonnetApi' }), true)
  assert.equal(isUsingClaudeApiModel({ modelName: 'claudeOpus4Api' }), true)
  assert.equal(isUsingClaudeApiModel({ modelName: 'claude2WebFree' }), false)
})

test('isUsingMoonshotApiModel detects moonshot API models', () => {
  assert.equal(isUsingMoonshotApiModel({ modelName: 'moonshot_v1_8k' }), true)
  assert.equal(isUsingMoonshotApiModel({ modelName: 'moonshot_k2' }), true)
  assert.equal(isUsingMoonshotApiModel({ modelName: 'moonshotWebFree' }), false)
})

test('isUsingDeepSeekApiModel detects DeepSeek models', () => {
  assert.equal(isUsingDeepSeekApiModel({ modelName: 'deepseek_chat' }), true)
  assert.equal(isUsingDeepSeekApiModel({ modelName: 'deepseek_reasoner' }), true)
  assert.equal(isUsingDeepSeekApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingOpenRouterApiModel detects OpenRouter models', () => {
  assert.equal(
    isUsingOpenRouterApiModel({ modelName: 'openRouter_anthropic_claude_sonnet4' }),
    true,
  )
  assert.equal(isUsingOpenRouterApiModel({ modelName: 'openRouter_openai_o3' }), true)
  assert.equal(isUsingOpenRouterApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingAimlApiModel detects AI/ML models', () => {
  assert.equal(isUsingAimlApiModel({ modelName: 'aiml_claude_3_7_sonnet_20250219' }), true)
  assert.equal(isUsingAimlApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingChatGLMApiModel detects ChatGLM models', () => {
  assert.equal(isUsingChatGLMApiModel({ modelName: 'chatglmTurbo' }), true)
  assert.equal(isUsingChatGLMApiModel({ modelName: 'chatglm4' }), true)
  assert.equal(isUsingChatGLMApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingOllamaApiModel detects Ollama models', () => {
  assert.equal(isUsingOllamaApiModel({ modelName: 'ollamaModel' }), true)
  assert.equal(isUsingOllamaApiModel({ modelName: 'customModel' }), false)
})

test('isUsingAzureOpenAiApiModel detects Azure OpenAI models', () => {
  assert.equal(isUsingAzureOpenAiApiModel({ modelName: 'azureOpenAi' }), true)
  assert.equal(isUsingAzureOpenAiApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingGithubThirdPartyApiModel detects waylaidwanderer models', () => {
  assert.equal(isUsingGithubThirdPartyApiModel({ modelName: 'waylaidwandererApi' }), true)
  assert.equal(isUsingGithubThirdPartyApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingCustomNameOnlyModel detects poeAiWebCustom', () => {
  assert.equal(isUsingCustomNameOnlyModel({ modelName: 'poeAiWebCustom' }), true)
  assert.equal(isUsingCustomNameOnlyModel({ modelName: 'poeAiWebSage' }), false)
  assert.equal(isUsingCustomNameOnlyModel({ modelName: 'customModel' }), false)
})

// ── getPreferredLanguageKey ──────────────────────────────────────────

describe('getPreferredLanguageKey', () => {
  beforeEach(() => {
    globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  })

  test('returns stored preferredLanguage', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'fr' })
    const key = await getPreferredLanguageKey()
    assert.equal(key, 'fr')
  })

  test('falls back to userLanguage when preference is auto', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'auto' })
    const key = await getPreferredLanguageKey()
    // defaultConfig.userLanguage is derived from navigator.language ('en-US' → 'en')
    assert.equal(key, 'en')
  })

  test('uses defaultConfig when storage is empty', async () => {
    // defaultConfig.preferredLanguage = getNavigatorLanguage() which is 'en' in the shim
    const key = await getPreferredLanguageKey()
    assert.equal(key, 'en')
  })
})
