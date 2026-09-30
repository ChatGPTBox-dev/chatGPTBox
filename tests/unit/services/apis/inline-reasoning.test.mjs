import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitInlineReasoning } from '../../../../src/services/apis/inline-reasoning.mjs'

test('a leading thinking block is split off the answer', () => {
  assert.deepEqual(splitInlineReasoning('<think>weighing options</think>\n\nThe answer.'), {
    reasoning: 'weighing options',
    answer: 'The answer.',
    unclosed: false,
  })
})

test('an unclosed thinking block is still arriving', () => {
  assert.deepEqual(splitInlineReasoning('\n<think>weighing options'), {
    reasoning: 'weighing options',
    answer: '',
    unclosed: true,
  })
})

test('the tag name and its attributes do not matter', () => {
  assert.deepEqual(splitInlineReasoning('<thinking id="1">why</thinking>Answer'), {
    reasoning: 'why',
    answer: 'Answer',
    unclosed: false,
  })
  assert.deepEqual(splitInlineReasoning('<reasoning>why</reasoning>Answer'), {
    reasoning: 'why',
    answer: 'Answer',
    unclosed: false,
  })
})

test('an answer without such a block is left alone', () => {
  assert.deepEqual(splitInlineReasoning('Just an answer.'), {
    reasoning: '',
    answer: 'Just an answer.',
    unclosed: false,
  })
})

test('prose and code that mention a tag keep their text', () => {
  const prose = 'Use <think> tags like this for reasoning.'
  assert.deepEqual(splitInlineReasoning(prose), {
    reasoning: '',
    answer: prose,
    unclosed: false,
  })

  const fence = 'Example:\n\n```html\n<think>example</think>\n```\n\nDone.'
  assert.deepEqual(splitInlineReasoning(fence), { reasoning: '', answer: fence, unclosed: false })
})

test('a block that only appears later in the answer is left in place', () => {
  const answer = 'The answer.\n\n<think>later</think>'
  assert.deepEqual(splitInlineReasoning(answer), { reasoning: '', answer, unclosed: false })
})
