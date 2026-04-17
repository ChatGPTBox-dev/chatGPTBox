/* eslint-disable no-undef */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { afterEach, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

// Register JSX/CJS loader hooks so the selection-tools module can be imported.
register('./tests/setup/jsx-loader-hooks.mjs', pathToFileURL(process.cwd() + '/').href)

let config

before(async () => {
  const m = await import('../../../src/content-script/selection-tools/index.mjs')
  config = m.config
})

afterEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

// ── helpers ──────────────────────────────────────────────────────────

const wrappedBlock = (text) => `\n'''\n${text}\n'''`

// ── basic genPrompt output for every tool ────────────────────────────

describe('selection-tools genPrompt', () => {
  test('explain includes language prefix and explanation instruction', async () => {
    const result = await config.explain.genPrompt('some concept')
    assert.ok(result.startsWith('Reply in English.'))
    assert.ok(result.includes('Explain the following content'))
    assert.ok(result.endsWith(wrappedBlock('some concept')))
  })

  test('translate produces translation prompt with preferred language', async () => {
    const result = await config.translate.genPrompt('bonjour')
    assert.ok(result.includes('Translate the following text into English'))
    assert.ok(result.endsWith(wrappedBlock('bonjour')))
    // translate has no language prefix
    assert.ok(!result.startsWith('Reply in'))
  })

  test('translateToEn always targets English regardless of preference', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'ja' })
    const result = await config.translateToEn.genPrompt('hola')
    assert.ok(result.includes('Translate the following text into English'))
    assert.ok(result.endsWith(wrappedBlock('hola')))
  })

  test('translateToZh always targets Chinese', async () => {
    const result = await config.translateToZh.genPrompt('hello')
    assert.ok(result.includes('Translate the following text into Chinese'))
    assert.ok(result.endsWith(wrappedBlock('hello')))
  })

  test('translateBidi includes bidirectional fallback instruction', async () => {
    const result = await config.translateBidi.genPrompt('hello')
    assert.ok(result.includes('Translate the following text into English'))
    assert.ok(result.includes('translate it into English instead'))
    assert.ok(result.endsWith(wrappedBlock('hello')))
  })

  test('summary includes summarization instruction with language prefix', async () => {
    const result = await config.summary.genPrompt('long article')
    assert.ok(result.startsWith('Reply in English.'))
    assert.ok(result.includes('Summarize the following content'))
    assert.ok(result.endsWith(wrappedBlock('long article')))
  })

  test('polish has no language prefix', async () => {
    const result = await config.polish.genPrompt('bad grammer')
    assert.ok(!result.startsWith('Reply in'))
    assert.ok(result.includes('Correct grammar'))
    assert.ok(result.endsWith(wrappedBlock('bad grammer')))
  })

  test('sentiment includes language prefix and analysis instruction', async () => {
    const result = await config.sentiment.genPrompt('I love this')
    assert.ok(result.startsWith('Reply in English.'))
    assert.ok(result.includes('sentiment analysis'))
    assert.ok(result.endsWith(wrappedBlock('I love this')))
  })

  test('divide has no language prefix', async () => {
    const result = await config.divide.genPrompt('wall of text')
    assert.ok(!result.startsWith('Reply in'))
    assert.ok(result.includes('Divide the following text'))
    assert.ok(result.endsWith(wrappedBlock('wall of text')))
  })

  test('code includes language prefix and code explanation instruction', async () => {
    const result = await config.code.genPrompt('const x = 1')
    assert.ok(result.startsWith('Reply in English.'))
    assert.ok(result.includes('Break down the following code'))
    assert.ok(result.endsWith(wrappedBlock('const x = 1')))
  })

  test('ask includes language prefix', async () => {
    const result = await config.ask.genPrompt('why is the sky blue?')
    assert.ok(result.startsWith('Reply in English.'))
    assert.ok(result.includes('Analyze the following content'))
    assert.ok(result.endsWith(wrappedBlock('why is the sky blue?')))
  })
})

// ── translation tools honour language parameter ──────────────────────

describe('translation tools respect language settings', () => {
  test('translate uses preferred language from config', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'ja' })
    const result = await config.translate.genPrompt('hello')
    assert.ok(result.includes('Translate the following text into Japanese'))
  })

  test('translate falls back to navigator language when preference is auto', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'auto' })
    const result = await config.translate.genPrompt('hello')
    // navigator.language is 'en-US' via browser shim → userLanguage 'en' → English
    assert.ok(result.includes('Translate the following text into English'))
  })

  test('translateToEn ignores preferred language', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'fr' })
    const result = await config.translateToEn.genPrompt('hello')
    assert.ok(result.includes('into English'))
    assert.ok(!result.includes('into French'))
  })

  test('translateToZh ignores preferred language', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'de' })
    const result = await config.translateToZh.genPrompt('hello')
    assert.ok(result.includes('into Chinese'))
    assert.ok(!result.includes('into German'))
  })

  test('explain language prefix reflects preferred language', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'fr' })
    const result = await config.explain.genPrompt('text')
    assert.ok(result.startsWith('Reply in French.'))
  })
})

// ── bidirectional translation toggle ─────────────────────────────────

describe('bidirectional translation toggle', () => {
  test('translateBidi includes bidirectional instruction', async () => {
    const result = await config.translateBidi.genPrompt('text')
    assert.ok(result.includes('If the text is already in'))
    assert.ok(result.includes('translate it into English instead'))
  })

  test('translate does NOT include bidirectional instruction', async () => {
    const result = await config.translate.genPrompt('text')
    assert.ok(!result.includes('If the text is already in'))
  })

  test('translateToEn does NOT include bidirectional instruction', async () => {
    const result = await config.translateToEn.genPrompt('text')
    assert.ok(!result.includes('If the text is already in'))
  })

  test('translateBidi uses preferred language in bidirectional clause', async () => {
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ preferredLanguage: 'ja' })
    const result = await config.translateBidi.genPrompt('text')
    assert.ok(result.includes('into Japanese'))
    assert.ok(result.includes('If the text is already in Japanese'))
  })
})

// ── empty selection ──────────────────────────────────────────────────

describe('empty selection handled gracefully', () => {
  test('explain with empty string still produces valid prompt', async () => {
    const result = await config.explain.genPrompt('')
    assert.ok(result.includes("'''"))
    assert.ok(result.endsWith(wrappedBlock('')))
  })

  test('translate with empty string still produces valid prompt', async () => {
    const result = await config.translate.genPrompt('')
    assert.ok(result.includes('Translate the following text'))
    assert.ok(result.endsWith(wrappedBlock('')))
  })

  test('polish with empty string still produces valid prompt', async () => {
    const result = await config.polish.genPrompt('')
    assert.ok(result.endsWith(wrappedBlock('')))
  })
})
