import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validateChunkSummaryOutput,
  validateFinalSummaryOutput,
} from '../../../src/video-summary/output-validity.mjs'

test('chunk output validity requires meaningful non-truncated content', () => {
  const cases = [
    [{ localSummary: '', keyPoints: [], candidates: [] }, 'stop', 'MODEL_OUTPUT_EMPTY'],
    [
      { localSummary: 'usable', keyPoints: [], candidates: [] },
      'length',
      'MODEL_OUTPUT_INCOMPLETE',
    ],
    [{ localSummary: '', keyPoints: ['usable'], candidates: [] }, 'stop', null],
  ]

  for (const [parsed, finishReason, reason] of cases) {
    assert.equal(validateChunkSummaryOutput({ parsed, finishReason }).reason, reason)
  }
})

test('final output validity checks every semantic field and truncation', () => {
  const meaningfulOutputs = [
    { overview: ' overview ' },
    { chapters: [{ title: ' title ' }] },
    { chapters: [{ summary: ' summary ' }] },
    { keyMoments: [{ point: ' moment ' }] },
  ]

  assert.deepEqual(validateFinalSummaryOutput({ parsed: {}, finishReason: 'stop' }), {
    valid: false,
    reason: 'MODEL_OUTPUT_EMPTY',
  })
  for (const parsed of meaningfulOutputs) {
    assert.deepEqual(validateFinalSummaryOutput({ parsed, finishReason: 'stop' }), {
      valid: true,
      reason: null,
    })
  }
  assert.deepEqual(
    validateFinalSummaryOutput({
      parsed: { keyPoints: [{ point: 'obsolete' }] },
      finishReason: 'stop',
    }),
    { valid: false, reason: 'MODEL_OUTPUT_EMPTY' },
  )
  assert.deepEqual(
    validateFinalSummaryOutput({ parsed: { overview: 'usable' }, finishReason: 'length' }),
    { valid: false, reason: 'MODEL_OUTPUT_INCOMPLETE' },
  )
})
