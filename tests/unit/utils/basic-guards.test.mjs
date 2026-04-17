import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endsWithQuestionMark } from '../../../src/utils/ends-with-question-mark.mjs'
import { getConversationPairs } from '../../../src/utils/get-conversation-pairs.mjs'
import { parseFloatWithClamp } from '../../../src/utils/parse-float-with-clamp.mjs'
import { parseIntWithClamp } from '../../../src/utils/parse-int-with-clamp.mjs'

const PARSE_INT_DEFAULT = 5
const PARSE_INT_MIN = 1
const PARSE_INT_MAX = 10

const parseIntWithDefaultRange = (value) =>
  parseIntWithClamp(value, PARSE_INT_DEFAULT, PARSE_INT_MIN, PARSE_INT_MAX)

test('parseIntWithClamp returns default value for non-numeric input', () => {
  assert.equal(parseIntWithDefaultRange('abc'), PARSE_INT_DEFAULT)
})

test('parseIntWithClamp clamps values outside the default range', () => {
  assert.equal(parseIntWithDefaultRange('99'), PARSE_INT_MAX)
  assert.equal(parseIntWithDefaultRange('-2'), PARSE_INT_MIN)
})

test('parseIntWithClamp keeps in-range integer values unchanged', () => {
  assert.equal(parseIntWithDefaultRange('7'), 7)
})

test('parseIntWithClamp truncates decimal strings before clamping', () => {
  assert.equal(parseIntWithClamp('42.99', PARSE_INT_DEFAULT, 1, 100), 42)
  assert.equal(parseIntWithClamp('-42.99', PARSE_INT_DEFAULT, -100, -1), -42)
})

test('parseIntWithClamp returns the fixed bound when min equals max', () => {
  const fixedBound = 50

  assert.equal(parseIntWithClamp('40', PARSE_INT_DEFAULT, fixedBound, fixedBound), fixedBound)
  assert.equal(parseIntWithClamp('60', PARSE_INT_DEFAULT, fixedBound, fixedBound), fixedBound)
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

test('getConversationPairs returns empty outputs for empty records', () => {
  assert.equal(getConversationPairs([], true), '')
  assert.deepEqual(getConversationPairs([], false), [])
})

test('getConversationPairs defaults to chat-message output when isCompletion is omitted', () => {
  const records = [{ question: 'Q1', answer: 'A1' }]

  assert.deepEqual(getConversationPairs(records), [
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
  ])
})

test('getConversationPairs keeps empty question and answer strings unchanged', () => {
  const records = [
    { question: '', answer: 'A1' },
    { question: 'Q2', answer: '' },
  ]

  assert.equal(getConversationPairs(records, true), 'Human: \nAI: A1\nHuman: Q2\nAI: \n')
  assert.deepEqual(getConversationPairs(records, false), [
    { role: 'user', content: '' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: '' },
  ])
})
