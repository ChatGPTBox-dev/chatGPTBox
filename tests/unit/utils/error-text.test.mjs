import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import i18next from 'i18next'
import {
  formatErrorMessage,
  formatErrorText,
  getDisplayErrorText,
} from '../../../src/utils/error-text.mjs'

function getNodeTypes(node) {
  return [node.type, ...(node.children ?? []).flatMap(getNodeTypes)]
}

test('formats multiline rich error text as an inert fenced code block', () => {
  const message = '<img src=x>\n\n![track](https://attacker.example/pixel)'
  const tree = unified().use(remarkParse).use(remarkGfm).parse(formatErrorText(message))

  assert.deepEqual(getNodeTypes(tree), ['root', 'code'])
  assert.equal(tree.children[0].value, message)
  assert.equal(tree.children[0].lang, 'diagnostic')
})

test('uses a delimiter longer than backticks in the error text', () => {
  const message = 'Provider returned `code`\n\nand ```details```'
  const tree = unified().use(remarkParse).use(remarkGfm).parse(formatErrorText(message))

  assert.deepEqual(getNodeTypes(tree), ['root', 'code'])
  assert.equal(tree.children[0].value, message)
  assert.equal(tree.children[0].lang, 'diagnostic')
})

test('preserves protocol error messages for ConversationCard handling', () => {
  assert.equal(formatErrorText('UNAUTHORIZED'), 'UNAUTHORIZED')
  assert.equal(formatErrorText('CLOUDFLARE'), 'CLOUDFLARE')
})

test('keeps plain error messages available for display translation', () => {
  const message =
    'moonshot token required, please login at https://kimi.com first, and then click the retry button'

  assert.equal(formatErrorMessage(message), message)
  assert.equal(
    getDisplayErrorText(formatErrorMessage(message), (key) => `translated: ${key}`),
    `translated: ${message}`,
  )
})

test('keeps translated instructions as regular Markdown text', () => {
  const message =
    "Failed to get arkose token.\n\nPlease keep https://chatgpt.com open and try again. If it still doesn't work, type some characters in the input box."

  assert.equal(formatErrorMessage(message), message)
})

test('formats rich error messages as inert diagnostics', () => {
  const message = '<img src=x onerror=alert(1)> ![track](https://attacker.example/pixel)'

  assert.equal(formatErrorMessage(message), formatErrorText(message))
})

test('pretty-prints JSON error messages before fencing them', () => {
  const message = '{"error":{"message":"Invalid"}}'
  const formatted = formatErrorMessage(message)
  const tree = unified().use(remarkParse).use(remarkGfm).parse(formatted)

  assert.deepEqual(getNodeTypes(tree), ['root', 'code'])
  assert.equal(tree.children[0].value, JSON.stringify(JSON.parse(message), null, 2))
  assert.equal(tree.children[0].lang, 'json')
})

test('keeps formatted diagnostics inert after display translation', async () => {
  const i18n = i18next.createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: {} } } })

  for (const message of [
    'https://evil.example/<img src=x onerror=alert(1)>',
    JSON.stringify({ error: { message: 'Invalid' } }),
  ]) {
    const formatted = formatErrorText(message)
    const displayed = getDisplayErrorText(formatted, i18n.t.bind(i18n))
    const tree = unified().use(remarkParse).use(remarkGfm).parse(displayed)

    assert.notEqual(i18n.t(formatted), formatted)
    assert.equal(displayed, formatted)
    assert.deepEqual(getNodeTypes(tree), ['root', 'code'])
    assert.equal(tree.children[0].value, message)
  }
})

test('translates unformatted error keys', () => {
  assert.equal(
    getDisplayErrorText('Unknown model configuration', (key) => `translated: ${key}`),
    'translated: Unknown model configuration',
  )
})

test('preserves legacy unlabelled fenced diagnostics after display translation', () => {
  const message = '```\nlegacy diagnostic\n```'

  assert.equal(
    getDisplayErrorText(message, (key) => `translated: ${key}`),
    message,
  )
})
