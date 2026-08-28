import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const locales = [
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

const usageKeys = [
  'Input tokens',
  'Output tokens',
  'Total tokens',
  'Cached input tokens',
  'Cache write tokens',
  'Selected model',
  'Reported model',
  'Model',
  'Models',
  'Turns',
  'Reported usage',
]

test('all locales include the model and token usage labels', async () => {
  for (const locale of locales) {
    const localeUrl = new URL(`../../../src/_locales/${locale}/main.json`, import.meta.url)
    const translations = JSON.parse(await readFile(localeUrl, 'utf8'))

    for (const key of usageKeys) {
      assert.equal(
        typeof translations[key],
        'string',
        `${locale} is missing the ${JSON.stringify(key)} translation`,
      )
      assert.notEqual(translations[key].trim(), '')
    }
  }
})
