import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignAutomaticSessionTitle,
  createSessionTitleFromQuestion,
  formatSessionTimestamp,
  getSessionDisplayName,
  truncateSessionTitle,
} from '../../../src/services/session-title.mjs'

test('createSessionTitleFromQuestion uses the first meaningful line', () => {
  assert.equal(
    createSessionTitleFromQuestion('\n```\n##   ChatGPTBox   title generation?\nMore detail'),
    'ChatGPTBox title generation',
  )
})

test('createSessionTitleFromQuestion removes common Markdown prefixes', () => {
  assert.equal(
    createSessionTitleFromQuestion('- Review this pull request!'),
    'Review this pull request',
  )
  assert.equal(createSessionTitleFromQuestion('1. Explain this code?'), 'Explain this code')
})

test('createSessionTitleFromQuestion creates a useful title for a URL-only question', () => {
  assert.equal(
    createSessionTitleFromQuestion('https://github.com/ChatGPTBox-dev/chatGPTBox/'),
    'chatGPTBox',
  )
})

test('truncateSessionTitle truncates by grapheme without splitting emoji', () => {
  assert.equal(
    truncateSessionTitle('A👨‍👩‍👧‍👦BCD', 4),
    'A👨‍👩‍👧‍👦B…',
  )
})

test('assignAutomaticSessionTitle uses the first stored question', () => {
  const session = {
    sessionName: null,
    sessionNameSource: null,
    question: 'Current question',
    conversationRecords: [{ question: 'First saved question?', answer: 'Answer' }],
  }

  assert.equal(assignAutomaticSessionTitle(session), session)
  assert.equal(session.sessionName, 'First saved question')
  assert.equal(session.sessionNameSource, 'heuristic')
})

test('assignAutomaticSessionTitle preserves an existing title', () => {
  const session = {
    sessionName: 'Manual title',
    sessionNameSource: 'manual',
    conversationRecords: [{ question: 'Should not replace this?', answer: 'Answer' }],
  }

  assignAutomaticSessionTitle(session)
  assert.equal(session.sessionName, 'Manual title')
  assert.equal(session.sessionNameSource, 'manual')
})

test('formatSessionTimestamp uses a stable numeric representation', () => {
  const date = new Date(2026, 7, 6, 3, 9)
  assert.equal(formatSessionTimestamp(date.toISOString()), '2026-08-06 03:09')
})

test('getSessionDisplayName falls back to label and creation time', () => {
  const date = new Date(2026, 7, 6, 3, 9)
  assert.equal(
    getSessionDisplayName({ sessionName: null, createdAt: date.toISOString() }, 'New Chat'),
    'New Chat · 2026-08-06 03:09',
  )
})
