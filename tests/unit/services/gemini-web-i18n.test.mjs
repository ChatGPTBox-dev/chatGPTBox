import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import i18next from 'i18next'
import { handlePortError } from '../../../src/services/wrappers.mjs'
import { createFakePort } from '../helpers/port.mjs'

const geminiErrorKeys = [
  'Gemini Web: Invalid response format. The website protocol may have changed.',
  'Gemini Web: Invalid response frame length.',
  'Gemini Web: Truncated response frame.',
  'Gemini Web: Invalid response envelope.',
  'Gemini Web: Invalid conversation identifier.',
  'Gemini Web: Conversation identifiers changed during generation.',
  'Gemini Web: The website rejected the request. Check Gemini in your browser.',
  'Gemini Web: The website rejected the request ({{code}}). Check Gemini in your browser.',
  'Gemini Web: Invalid response payload.',
  'Gemini Web: Invalid candidate identifier.',
  'Gemini Web: Candidate changed during generation.',
  'Gemini Web: Invalid text candidate.',
  'Gemini Web: No text answer was received. Check Gemini in your browser.',
  'Gemini Web: Could not confirm that the answer finished generating.',
  'Gemini Web: The answer was interrupted before completion. Check Gemini before retrying.',
  'Gemini Web: Missing conversation identifiers.',
  'Gemini Web: Invalid Google account route. Start a new conversation.',
  'Gemini Web: Invalid website session data.',
  'Gemini Web: HTTP {{status}}. Check your login and limits on Gemini.',
  'Gemini Web: Sign in to Gemini in this browser profile before trying again.',
  'Gemini Web: Empty website response.',
  'Gemini Web: Website response is too large.',
  'Gemini Web: The Google account route changed. Start a new conversation.',
  'Gemini Web: The selected model is not available for this Google account.',
  'Gemini Web: Invalid Gemini Web model selection.',
  'Gemini Web: Gemini could not load the available models for this account.',
  'Gemini Web: Invalid Gemini model discovery response.',
  'Gemini Web: Gemini returned no available model information.',
  'Gemini Web: This Google account cannot select models ({{status}}).',
  'Gemini Web: Invalid conversation state. Start a new conversation.',
  'Gemini Web: This conversation has no stored Google account route. Start a new conversation.',
  'Gemini Web: Empty question.',
  'Gemini Web: Request timed out. Check Gemini before retrying.',
]

async function loadLocale(language) {
  return JSON.parse(
    await readFile(new URL(`../../../src/_locales/${language}/main.json`, import.meta.url), 'utf8'),
  )
}

async function createTranslator(language, translation) {
  const i18n = i18next.createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: false,
    resources: { [language]: { translation } },
  })
  return i18n.t.bind(i18n)
}

test('Gemini Web errors are registered in English and Traditional Chinese locales', async () => {
  const [en, zhHant] = await Promise.all([loadLocale('en'), loadLocale('zh-hant')])

  for (const key of geminiErrorKeys) {
    assert.equal(en[key], key)
    assert.equal(typeof zhHant[key], 'string')
    assert.notEqual(zhHant[key], key)
  }
})

test('handlePortError localizes static and dynamic Gemini Web errors', async (t) => {
  t.mock.method(console, 'error', () => {})
  const zhHant = await loadLocale('zh-hant')
  const translate = await createTranslator('zh-Hant', zhHant)

  for (const [message, expected] of [
    [
      'Gemini Web: The selected model is not available for this Google account.',
      'Google Gemini 網頁版：此 Google 帳戶無法使用所選模型。',
    ],
    [
      'Gemini Web: HTTP 429. Check your login and limits on Gemini.',
      'Google Gemini 網頁版：HTTP 429。請確認 Gemini 的登入狀態與使用限制。',
    ],
    [
      'Gemini Web: The website rejected the request (1037). Check Gemini in your browser.',
      'Google Gemini 網頁版：網站拒絕此要求（1037）。請在瀏覽器中檢查 Gemini。',
    ],
  ]) {
    const port = createFakePort()
    handlePortError(
      { modelName: 'bardWebFree' },
      port,
      Object.assign(new Error(message), { code: 'GEMINI_WEB_PROTOCOL_ERROR' }),
      translate,
    )
    assert.deepEqual(port.postedMessages, [{ error: expected }])
  }
})
