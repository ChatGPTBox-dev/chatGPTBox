import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeReasoningTags } from '../../../src/components/MarkdownRender/special-tags.mjs'

test('reasoning tags in plain text are shown as written', () => {
  assert.equal(
    escapeReasoningTags('Use <think> and </think> to wrap thinking.'),
    'Use &lt;think> and &lt;/think> to wrap thinking.',
  )
})

test('the tag name case and attributes do not matter', () => {
  assert.equal(
    escapeReasoningTags('<THINKING level="2">x</Thinking>'),
    '&lt;THINKING level="2">x&lt;/Thinking>',
  )
  assert.equal(
    escapeReasoningTags('<reasoning>why</reasoning>'),
    '&lt;reasoning>why&lt;/reasoning>',
  )
})

test('other tags and autolinks are left alone', () => {
  const text = 'See <https://example.com> and <div class="x">html</div>.'
  assert.equal(escapeReasoningTags(text), text)
})

test('a leading reasoning block is escaped, so it cannot open one', () => {
  const answer = '<think>secret</think>\n\nThe answer.'
  assert.equal(escapeReasoningTags(answer), '&lt;think>secret&lt;/think>\n\nThe answer.')
})

test('fenced code and inline code keep their text untouched', () => {
  const fenced = 'Example:\n\n```html\n<think>example</think>\n```\n'
  assert.equal(escapeReasoningTags(fenced), fenced)

  const inline = 'Write `<think>text</think>` to wrap it.'
  assert.equal(escapeReasoningTags(inline), inline)
})

test('prose around code is still escaped', () => {
  assert.equal(
    escapeReasoningTags('`<think>` means <think>thinking</think>.'),
    '`<think>` means &lt;think>thinking&lt;/think>.',
  )
})
