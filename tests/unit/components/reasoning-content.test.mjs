import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStreamedContent } from '../../../src/components/MarkdownRender/reasoning-content.mjs'

const LOADING = '<p class="gpt-loading">Waiting for response...</p>'

test('the answer alone is handed over unchanged when there is no reasoning', () => {
  assert.equal(buildStreamedContent('Answer', '', false), 'Answer')
  assert.equal(buildStreamedContent(LOADING, '', false), LOADING)
})

test('reasoning stays open while the answer has not started', () => {
  assert.equal(buildStreamedContent('', 'thinking', false), '<think>\nthinking')
})

test('the loading placeholder does not count as a started answer', () => {
  // The block stays open, so the renderer keeps it expanded with the timer running.
  assert.equal(buildStreamedContent(LOADING, 'thinking', false), '<think>\nthinking')
})

test('the reasoning block closes once the answer starts', () => {
  assert.equal(
    buildStreamedContent('Answer', 'thinking', false),
    '<think>\nthinking\n</think>\n\nAnswer',
  )
})

test('the reasoning block closes when the stream ends without an answer', () => {
  assert.equal(buildStreamedContent('', 'thinking', true), '<think>\nthinking\n</think>\n\n')
  assert.equal(buildStreamedContent(LOADING, 'thinking', true), '<think>\nthinking\n</think>\n\n')
})

test('a growing reasoning snapshot extends the still-open block', () => {
  const first = buildStreamedContent(LOADING, 'thin', false)
  const second = buildStreamedContent(LOADING, 'thinking', false)
  assert.equal(second.startsWith(first), true)
})
