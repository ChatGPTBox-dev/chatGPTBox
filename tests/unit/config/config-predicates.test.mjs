import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  getNavigatorLanguage,
  getPreferredLanguageKey,
  Models,
  chatgptApiModelKeys,
  gptApiModelKeys,
  claudeApiModelKeys,
  mistralApiModelKeys,
  openRouterApiModelKeys,
  aimlApiModelKeys,
  isUsingAimlApiModel,
  isUsingAzureOpenAiApiModel,
  isUsingBingWebModel,
  isUsingChatGLMApiModel,
  isUsingChatgptWebModel,
  isUsingChatgptApiModel,
  isUsingClaudeApiModel,
  isUsingCustomModel,
  isUsingCustomNameOnlyModel,
  isUsingDeepSeekApiModel,
  isUsingGeminiWebModel,
  isUsingGithubThirdPartyApiModel,
  isUsingMoonshotApiModel,
  isUsingMistralApiModel,
  isUsingMoonshotWebModel,
  isUsingMultiModeModel,
  isUsingOllamaApiModel,
  isUsingOpenAiApiModel,
  isUsingGptCompletionApiModel,
  isUsingOpenRouterApiModel,
} from '../../../src/config/index.mjs'
import {
  LEGACY_MODEL_KEY_MIGRATIONS,
  canonicalizeModelKey,
} from '../../../src/config/model-key-migrations.mjs'

const representativeChatgptApiModelNames = [
  'chatgptApi4oMini',
  'chatgptApi5',
  'chatgptApi5_1',
  'chatgptApi5_2',
  'chatgptApi5_4',
  'chatgptApi5_4Mini',
  'chatgptApi5_4Nano',
  'chatgptApi5_5',
  'chatgptApi5_6',
  'chatgptApi5_6Sol',
  'chatgptApi5_6Terra',
  'chatgptApi5_6Luna',
]
const representativeGptCompletionApiModelNames = ['gptApiInstruct']
const representativeClaudeApiModelNames = ['claudeOpus48Api', 'claudeSonnet46Api']
const representativeOpenRouterApiModelNames = [
  'openRouter_anthropic_claude_sonnet4_6',
  'openRouter_openai_gpt_5_5',
]
const representativeAimlApiModelNames = ['aiml_claude_sonnet_4_6_20260218', 'aiml_openai_gpt_5_5']

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

test('legacy model key migration targets remain valid model presets', () => {
  for (const [legacyModelKey, targetModelKey] of Object.entries(LEGACY_MODEL_KEY_MIGRATIONS)) {
    assert.ok(targetModelKey in Models, `${legacyModelKey} target ${targetModelKey} must exist`)
    assert.equal(canonicalizeModelKey(legacyModelKey), targetModelKey)
  }
})

test('canonicalized legacy model keys still match their provider predicates', () => {
  const cases = [
    ['chatgptFree4o', isUsingChatgptWebModel],
    ['gptApiDavinci', isUsingGptCompletionApiModel],
    ['chatgptApi35', isUsingChatgptApiModel],
    ['chatgptApi4_128k_preview', isUsingChatgptApiModel],
    ['claude2Api', isUsingClaudeApiModel],
    ['claude3OpusApi', isUsingClaudeApiModel],
    ['chatglmTurbo', isUsingChatGLMApiModel],
    ['moonshot_k2', isUsingMoonshotApiModel],
    ['openRouter_deepseek_deepseek_chat_v3_0324_free', isUsingOpenRouterApiModel],
    ['aiml_openai_o3_2025_04_16', isUsingAimlApiModel],
  ]

  for (const [legacyModelKey, predicate] of cases) {
    const canonicalModelKey = canonicalizeModelKey(legacyModelKey)
    assert.equal(predicate({ modelName: canonicalModelKey }), true, legacyModelKey)
  }
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

test('isUsingChatgptApiModel matches representative chatgpt API keys', () => {
  for (const modelName of representativeChatgptApiModelNames) {
    assert.equal(isUsingChatgptApiModel({ modelName }), true)
  }
  assert.equal(isUsingChatgptApiModel({ modelName: 'customModel' }), false)
})

test('isUsingChatgptApiModel accepts exported chatgpt API model keys', () => {
  for (const modelName of chatgptApiModelKeys) {
    assert.equal(isUsingChatgptApiModel({ modelName }), true)
  }
})

test('isUsingOpenAiApiModel matches representative chat and completion API keys', () => {
  for (const modelName of representativeChatgptApiModelNames) {
    assert.equal(isUsingOpenAiApiModel({ modelName }), true)
  }
  for (const modelName of representativeGptCompletionApiModelNames) {
    assert.equal(isUsingOpenAiApiModel({ modelName }), true)
  }
  assert.equal(isUsingOpenAiApiModel({ modelName: 'customModel' }), false)
})

test('isUsingOpenAiApiModel accepts exported chat and completion API model groups', () => {
  for (const modelName of chatgptApiModelKeys) {
    assert.equal(isUsingOpenAiApiModel({ modelName }), true)
  }
  for (const modelName of gptApiModelKeys) {
    assert.equal(isUsingOpenAiApiModel({ modelName }), true)
  }
})

test('isUsingGptCompletionApiModel matches representative completion API keys', () => {
  for (const modelName of representativeGptCompletionApiModelNames) {
    assert.equal(isUsingGptCompletionApiModel({ modelName }), true)
  }
  assert.equal(isUsingGptCompletionApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingGptCompletionApiModel accepts exported completion API model keys', () => {
  for (const modelName of gptApiModelKeys) {
    assert.equal(isUsingGptCompletionApiModel({ modelName }), true)
  }
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

test('isUsingClaudeApiModel matches representative Claude API keys', () => {
  for (const modelName of representativeClaudeApiModelNames) {
    assert.equal(isUsingClaudeApiModel({ modelName }), true)
  }
  assert.equal(isUsingClaudeApiModel({ modelName: 'claude2WebFree' }), false)
})

test('isUsingClaudeApiModel accepts exported Claude API model keys', () => {
  for (const modelName of claudeApiModelKeys) {
    assert.equal(isUsingClaudeApiModel({ modelName }), true)
  }
})

test('isUsingMoonshotApiModel detects moonshot API models', () => {
  assert.equal(isUsingMoonshotApiModel({ modelName: 'moonshot_v1_8k' }), true)
  assert.equal(isUsingMoonshotApiModel({ modelName: 'moonshot_k2_5' }), true)
  assert.equal(isUsingMoonshotApiModel({ modelName: 'moonshotWebFree' }), false)
})

test('isUsingMistralApiModel accepts exported Mistral API model keys', () => {
  for (const modelName of mistralApiModelKeys) {
    assert.equal(isUsingMistralApiModel({ modelName }), true)
  }
  assert.equal(isUsingMistralApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingDeepSeekApiModel detects DeepSeek models', () => {
  assert.equal(isUsingDeepSeekApiModel({ modelName: 'deepseek_v4_flash' }), true)
  assert.equal(isUsingDeepSeekApiModel({ modelName: 'deepseek_v4_pro' }), true)
  assert.equal(isUsingDeepSeekApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingOpenRouterApiModel matches representative OpenRouter API keys', () => {
  for (const modelName of representativeOpenRouterApiModelNames) {
    assert.equal(isUsingOpenRouterApiModel({ modelName }), true)
  }
  assert.equal(isUsingOpenRouterApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingOpenRouterApiModel accepts exported OpenRouter API model keys', () => {
  for (const modelName of openRouterApiModelKeys) {
    assert.equal(isUsingOpenRouterApiModel({ modelName }), true)
  }
})

test('isUsingAimlApiModel matches representative AI/ML API keys', () => {
  for (const modelName of representativeAimlApiModelNames) {
    assert.equal(isUsingAimlApiModel({ modelName }), true)
  }
  assert.equal(isUsingAimlApiModel({ modelName: 'chatgptApi4oMini' }), false)
})

test('isUsingAimlApiModel accepts exported AI/ML model keys', () => {
  for (const modelName of aimlApiModelKeys) {
    assert.equal(isUsingAimlApiModel({ modelName }), true)
  }
})

test('aimlApiModelKeys does not expose duplicate picker entries', () => {
  const signatures = aimlApiModelKeys.map((modelName) => {
    const model = Models[modelName]
    return model.value + '\n' + model.desc
  })

  assert.equal(new Set(signatures).size, signatures.length)
})

test('isUsingChatGLMApiModel detects ChatGLM models', () => {
  assert.equal(isUsingChatGLMApiModel({ modelName: 'chatglm52' }), true)
  assert.equal(isUsingChatGLMApiModel({ modelName: 'chatglm47' }), true)
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
    setNavigatorLanguage('en-US')
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
