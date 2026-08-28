import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import Browser from 'webextension-polyfill'
import { getPreferredLanguageKey, getUserConfig } from '../../../src/config/index.mjs'
import { getPreferredLanguage } from '../../../src/config/language.mjs'

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigatorLanguage(language) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language },
    configurable: true,
  })
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  setNavigatorLanguage('en-US')
})

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
  } else {
    delete globalThis.navigator
  }
})

test('repairs obsolete Traditional Chinese keys from the browser locale', async () => {
  setNavigatorLanguage('zh-TW')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'zhHant',
    userLanguage: 'zhHant',
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.preferredLanguage, 'zh-Hant')
  assert.equal(config.userLanguage, 'zh-Hant')
  assert.equal(storage.preferredLanguage, 'zh-Hant')
  assert.equal(storage.userLanguage, 'zh-Hant')
})

test('repairs obsolete Simplified Chinese keys from the browser locale', async () => {
  setNavigatorLanguage('zh-CN')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'zh',
    userLanguage: 'zh',
  })

  const config = await getUserConfig()

  assert.equal(config.preferredLanguage, 'zh-Hans')
  assert.equal(config.userLanguage, 'zh-Hans')
})

test('repairs obsolete Indonesian keys from the browser locale', async () => {
  setNavigatorLanguage('id-ID')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'in',
    userLanguage: 'in',
  })

  const config = await getUserConfig()

  assert.equal(config.preferredLanguage, 'id')
  assert.equal(config.userLanguage, 'id')
})

test('preserves a valid manual preference while refreshing userLanguage', async () => {
  setNavigatorLanguage('zh-TW')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'fr',
    userLanguage: 'en',
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.preferredLanguage, 'fr')
  assert.equal(config.userLanguage, 'zh-Hant')
  assert.equal(storage.preferredLanguage, 'fr')
  assert.equal(storage.userLanguage, 'zh-Hant')
})

test('auto resolves through the refreshed browser language', async () => {
  setNavigatorLanguage('zh-TW')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'auto',
    userLanguage: 'en',
  })

  const config = await getUserConfig()

  assert.equal(config.preferredLanguage, 'auto')
  assert.equal(config.userLanguage, 'zh-Hant')
  assert.equal(await getPreferredLanguageKey(), 'zh-Hant')
})

test('formats preferred language with native name and canonical tag for prompts', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({ preferredLanguage: 'zh-Hant' })

  assert.equal(
    await getPreferredLanguage(),
    'Traditional Chinese (正體中文; zh-Hant)',
  )
})

test('does not duplicate a native name that matches the English name', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({ preferredLanguage: 'en' })

  assert.equal(await getPreferredLanguage(), 'English (en)')
})

test('formats auto preferred language from the current browser language', async () => {
  setNavigatorLanguage('ja-JP')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'auto',
    userLanguage: 'en',
  })

  assert.equal(await getPreferredLanguage(), 'Japanese (日本語; ja)')
})

test('falls back arbitrary invalid preferences to the browser language', async () => {
  setNavigatorLanguage('ja-JP')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'invalid-language',
    userLanguage: 'en',
  })

  const config = await getUserConfig()

  assert.equal(config.preferredLanguage, 'ja')
  assert.equal(config.userLanguage, 'ja')
})

test('returns repaired language values even if storage persistence fails', async (t) => {
  setNavigatorLanguage('zh-TW')
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    preferredLanguage: 'zhHant',
    userLanguage: 'zhHant',
  })
  t.mock.method(Browser.storage.local, 'set', async () => {
    throw new Error('storage unavailable')
  })

  const config = await getUserConfig()
  const storage = globalThis.__TEST_BROWSER_SHIM__.getStorage()

  assert.equal(config.preferredLanguage, 'zh-Hant')
  assert.equal(config.userLanguage, 'zh-Hant')
  assert.equal(storage.preferredLanguage, 'zhHant')
  assert.equal(storage.userLanguage, 'zhHant')
})
