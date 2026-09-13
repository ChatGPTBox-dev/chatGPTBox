import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const localeNames = [
  'de',
  'en',
  'es',
  'fr',
  'id',
  'it',
  'ja',
  'ko',
  'pt',
  'ru',
  'tr',
  'zh-hans',
  'zh-hant',
]

const conversationTitleKeys = [
  'Automatically generate conversation titles',
  'Conversation title model',
  'Select a model',
  'Choose a fast, low-cost OpenAI-compatible chat model.',
  'The first completed exchange is sent once per conversation.',
]

async function loadLocale(localeName) {
  const localeUrl = new URL(`../../../src/_locales/${localeName}/main.json`, import.meta.url)
  return JSON.parse(await readFile(localeUrl, 'utf8'))
}

test('conversation title controls are translated in every runtime locale', async () => {
  for (const localeName of localeNames) {
    const translation = await loadLocale(localeName)
    for (const key of conversationTitleKeys) {
      const value = translation[key]
      assert.equal(typeof value, 'string', `${localeName} is missing ${key}`)
      assert.ok(value.trim(), `${localeName} has an empty translation for ${key}`)
      if (localeName !== 'en') {
        assert.notEqual(value, key, `${localeName} still uses the English source text for ${key}`)
      }
    }
  }
})
