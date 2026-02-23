import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getNavigatorLanguage,
  isUsingBingWebModel,
  isUsingChatgptApiModel,
  isUsingCustomModel,
  isUsingMultiModeModel,
  isUsingOpenAiApiModel,
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
