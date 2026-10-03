import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getNavigatorLanguage,
  isValidLanguageKey,
  languageList,
  resolveLanguageKey,
  resolvePreferredLanguageKey,
} from '../../../src/config/language-data.mjs'

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigatorLanguage(language) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language },
    configurable: true,
  })
}

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
  } else {
    delete globalThis.navigator
  }
})

test('language list uses canonical keys for Chinese and Indonesian', () => {
  assert.equal(Object.hasOwn(languageList, 'zh-Hans'), true)
  assert.equal(Object.hasOwn(languageList, 'zh-Hant'), true)
  assert.equal(Object.hasOwn(languageList, 'id'), true)
  assert.equal(Object.hasOwn(languageList, 'zh'), false)
  assert.equal(Object.hasOwn(languageList, 'zhHant'), false)
  assert.equal(Object.hasOwn(languageList, 'in'), false)
})

test('Chinese entries preserve explicit script-specific names', () => {
  assert.equal(languageList['zh-Hans'].name, 'Simplified Chinese')
  assert.equal(languageList['zh-Hans'].native, '简体中文')
  assert.equal(languageList['zh-Hant'].name, 'Traditional Chinese')
  assert.equal(languageList['zh-Hant'].native, '正體中文')
})

test('resolves regional locales to supported language keys', () => {
  assert.equal(resolveLanguageKey('en-US'), 'en')
  assert.equal(resolveLanguageKey('fr-CA'), 'fr')
  assert.equal(resolveLanguageKey('ja-JP'), 'ja')
  assert.equal(resolveLanguageKey('id-ID'), 'id')
})

test('trims surrounding whitespace before resolving locales', () => {
  assert.equal(resolveLanguageKey('  en-US  '), 'en')
  assert.equal(resolveLanguageKey('  zh-TW  '), 'zh-Hant')
  assert.equal(resolveLanguageKey('  zh-CHS  '), 'zh-Hans')
  assert.equal(resolveLanguageKey('  zh-CHT  '), 'zh-Hant')
})

test('resolves Simplified Chinese locales to zh-Hans', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) {
    assert.equal(resolveLanguageKey(locale), 'zh-Hans', locale)
  }
})

test('resolves Traditional Chinese locales to zh-Hant', () => {
  for (const locale of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'ZH-tW']) {
    assert.equal(resolveLanguageKey(locale), 'zh-Hant', locale)
  }
})

test('preserves legacy Chinese browser locale compatibility', () => {
  assert.equal(resolveLanguageKey('zh-CHS'), 'zh-Hans')
  assert.equal(resolveLanguageKey('zh-CHT'), 'zh-Hant')
})

test('canonicalizes deprecated BCP 47 language aliases through Intl.Locale', () => {
  assert.equal(resolveLanguageKey('in-ID'), 'id')
})

test('falls back to English for invalid or unsupported locales', () => {
  assert.equal(resolveLanguageKey('not_a_locale'), 'en')
  assert.equal(resolveLanguageKey('fil-PH'), 'en')
  assert.equal(resolveLanguageKey(''), 'en')
})

test('does not truncate unsupported three-letter language subtags', () => {
  assert.notEqual(resolveLanguageKey('fil-PH'), 'fi')
})

test('validates supported language-list keys and rejects obsolete aliases', () => {
  for (const key of ['auto', 'en', 'fr', 'id', 'zh-Hans', 'zh-Hant']) {
    assert.equal(isValidLanguageKey(key), true, key)
  }
  for (const key of ['zh', 'zhHant', 'in', 'fil', '', null]) {
    assert.equal(isValidLanguageKey(key), false, String(key))
  }
})

test('falls back invalid preferred-language keys to the resolved user language', () => {
  assert.equal(resolvePreferredLanguageKey('fr', 'zh-Hant'), 'fr')
  assert.equal(resolvePreferredLanguageKey('auto', 'zh-Hant'), 'auto')
  assert.equal(resolvePreferredLanguageKey('zhHant', 'zh-Hant'), 'zh-Hant')
  assert.equal(resolvePreferredLanguageKey('zh', 'zh-Hant'), 'zh-Hant')
  assert.equal(resolvePreferredLanguageKey('in', 'id'), 'id')
})

test('getNavigatorLanguage resolves the current browser locale', () => {
  setNavigatorLanguage('zh-TW')
  assert.equal(getNavigatorLanguage(), 'zh-Hant')
})
