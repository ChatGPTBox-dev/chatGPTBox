import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { cropText } from '../../../src/utils/crop-text.mjs'

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('cropText returns text unchanged when shorter than limit', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    maxResponseTokenLength: 200,
  })

  const short = 'Hello world'
  const result = await cropText(short, 8000, 800, 600, false)

  assert.equal(result, short)
})

test('cropText returns text unchanged when cropText config is disabled', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: false,
  })

  const text = 'This should be returned as-is regardless of length'
  const result = await cropText(text, 10, 2, 2, false)

  assert.equal(result, text)
})

test('cropText correctly splits on punctuation characters', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    maxResponseTokenLength: 200,
    modelName: 'claude2WebFree',
    apiMode: null,
    customModelName: '',
  })

  // Build text with comma-separated segments that exceed maxLength (~7700 chars)
  const segments = []
  for (let i = 0; i < 2000; i++) {
    segments.push(`segment${String(i).padStart(4, '0')}`)
  }
  const text = segments.join(',')

  const result = await cropText(text, 8000, 800, 600, false)

  // Result should be shorter than original since cropping happened
  assert.ok(result.length < text.length, 'cropped text should be shorter than original')
  // Result should still contain commas from splitting/reassembly
  assert.ok(result.includes(','), 'result should contain commas from reassembly')
})

test('cropText preserves start and end portions of long text', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    maxResponseTokenLength: 200,
    modelName: 'claude2WebFree',
    apiMode: null,
    customModelName: '',
  })

  // Create text with identifiable start/end markers separated by punctuation
  const startPart = 'START'
  const endPart = 'ENDMARKER'
  const middleParts = []
  for (let i = 0; i < 2000; i++) {
    middleParts.push(`middle${String(i).padStart(4, '0')}`)
  }
  const text = startPart + ',' + middleParts.join(',') + ',' + endPart

  const result = await cropText(text, 8000, 800, 600, false)

  assert.ok(result.startsWith('START,'), 'result should start with START')
  assert.ok(result.includes('ENDMARKER'), 'result should contain end marker')
})

test('cropText handles empty text input', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    maxResponseTokenLength: 100,
  })

  const result = await cropText('', 8000, 800, 600, false)

  assert.equal(result, '')
})

test('cropText respects model-specific max lengths from model description', async () => {
  // Set up config with a model whose desc contains a "128k" token size indicator
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    modelName: 'chatgptApi4_128k',
    apiMode: null,
    maxResponseTokenLength: 2000,
    customModelName: '',
  })

  // Build a very long text with punctuation separators (using char length mode)
  const segments = []
  for (let i = 0; i < 2000; i++) {
    segments.push(`word${i}`)
  }
  const longText = segments.join(',')

  const result = await cropText(longText, 8000, 800, 600, false)

  // With a 128k model, the effective maxLength should be 128000 - 100 - 2000 = 125900
  // which is far more than our text, so it should be returned as-is
  assert.equal(result, longText)
})

test('cropText uses default maxLength when model desc has no k-token', async () => {
  // claude2WebFree desc is "Claude.ai (Web)" — no Nk pattern
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    modelName: 'claude2WebFree',
    apiMode: null,
    maxResponseTokenLength: 200,
    customModelName: '',
  })

  const segments = []
  for (let i = 0; i < 500; i++) {
    segments.push(`seg${i}`)
  }
  const text = segments.join(',')

  // With default maxLength=8000, minus 100+200=300 → effective ~7700 chars
  // Our text is ~2500 chars so should be returned as-is
  const result = await cropText(text, 8000, 800, 600, false)

  assert.equal(result, text)
})

test('cropText internal clamp works at boundaries via maxResponseTokenLength', async () => {
  // clamp(maxResponseTokenLength, 1, maxLength - 2000)
  // With maxResponseTokenLength=0, clamped to 1 → maxLength = 8000 - 100 - 1 = 7899
  // With a very large maxResponseTokenLength, clamped to maxLength-2000 → smaller budget
  // We test with large maxResponseTokenLength that actually causes cropping
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    maxResponseTokenLength: 7000,
    modelName: 'claude2WebFree',
    apiMode: null,
    customModelName: '',
  })

  // Generate text long enough to trigger cropping with maxLength = 8000 - 100 - 5900 = 2000
  const segments = []
  for (let i = 0; i < 600; i++) segments.push(`word${i}`)
  const longText = segments.join(',')

  const result = await cropText(longText, 8000, 800, 600, false)
  // maxLength = 2000, text is ~3600 chars, so cropping should occur
  assert.ok(
    result.length < longText.length,
    'text should be cropped when maxResponseTokenLength is large',
  )
  assert.ok(result.length > 0, 'cropped text should not be empty')
})

test('cropText with tiktoken enabled processes text by token length', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    cropText: true,
    maxResponseTokenLength: 100,
    modelName: 'claude2WebFree',
    apiMode: null,
    customModelName: '',
  })

  // Generate long text — each segment ~10 chars but ~2 tokens
  // so token length < char length, causing different crop results
  const segments = []
  for (let i = 0; i < 2000; i++) segments.push(`segment${i}`)
  const longText = segments.join(',')

  // Use small maxLength (2000) to guarantee cropping in both modes
  // Model desc 'Claude.ai (Web)' has no "Nk" pattern, so maxLength param is used directly
  // Effective: 2000 - 100 - clamp(100,1,0) = 2000 - 100 - 1 = 1899
  const resultTiktoken = await cropText(longText, 2000, 400, 300, true)
  const resultChars = await cropText(longText, 2000, 400, 300, false)

  // Both should be cropped
  assert.ok(resultTiktoken.length < longText.length, 'tiktoken mode should crop')
  assert.ok(resultChars.length < longText.length, 'char mode should crop')
  // Token counting vs char counting should produce different results
  assert.notEqual(
    resultTiktoken.length,
    resultChars.length,
    'tiktoken and char modes should produce different crop lengths',
  )
})
