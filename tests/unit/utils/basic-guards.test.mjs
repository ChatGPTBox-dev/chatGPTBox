import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endsWithQuestionMark } from '../../../src/utils/ends-with-question-mark.mjs'
import { getConversationPairs } from '../../../src/utils/get-conversation-pairs.mjs'
import { parseFloatWithClamp } from '../../../src/utils/parse-float-with-clamp.mjs'
import { parseIntWithClamp } from '../../../src/utils/parse-int-with-clamp.mjs'

test('parseIntWithClamp handles NaN and boundaries', () => {
  assert.equal(parseIntWithClamp('abc', 5, 1, 10), 5)
  assert.equal(parseIntWithClamp('99', 5, 1, 10), 10)
  assert.equal(parseIntWithClamp('-2', 5, 1, 10), 1)
  assert.equal(parseIntWithClamp('7', 5, 1, 10), 7)
})

test('parseFloatWithClamp handles NaN and boundaries', () => {
  assert.equal(parseFloatWithClamp('abc', 1.5, 0.5, 3.5), 1.5)
  assert.equal(parseFloatWithClamp('8.8', 1.5, 0.5, 3.5), 3.5)
  assert.equal(parseFloatWithClamp('0.1', 1.5, 0.5, 3.5), 0.5)
  assert.equal(parseFloatWithClamp('2.2', 1.5, 0.5, 3.5), 2.2)
})

test('endsWithQuestionMark supports multiple question-mark styles', () => {
  assert.equal(endsWithQuestionMark('How are you?'), true)
  assert.equal(endsWithQuestionMark('你今天好嗎？'), true)
  assert.equal(endsWithQuestionMark('هل أنت بخير؟'), true)
  assert.equal(endsWithQuestionMark('reversed question⸮'), true)
  assert.equal(endsWithQuestionMark('No punctuation'), false)
})

test('getConversationPairs returns completion prompt string when completion mode', () => {
  const records = [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ]

  const text = getConversationPairs(records, true)

  assert.equal(text, 'Human: Q1\nAI: A1\nHuman: Q2\nAI: A2\n')
})

test('getConversationPairs returns chat messages when not completion mode', () => {
  const records = [{ question: 'Q1', answer: 'A1' }]

  const messages = getConversationPairs(records, false)

  assert.deepEqual(messages, [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
  ])
})
