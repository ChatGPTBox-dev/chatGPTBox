import assert from 'node:assert/strict'
import test from 'node:test'

import {
  selectRetryChunks,
  successfulResultsOutsideRetry,
} from '../../../src/video-summary/retry-ranges.mjs'

const transcription = {
  segments: Array.from({ length: 8 }, (_, index) => ({ id: `s${index + 1}` })),
}

const chunks = [
  { primaryStartSegmentId: 's1', primaryEndSegmentId: 's3' },
  { primaryStartSegmentId: 's4', primaryEndSegmentId: 's6' },
  { primaryStartSegmentId: 's7', primaryEndSegmentId: 's8' },
]

test('selects every new chunk intersecting a failed segment interval', () => {
  assert.deepEqual(
    selectRetryChunks({
      transcription,
      chunks,
      failedRanges: [{ startSegmentId: 's3', endSegmentId: 's4' }],
    }),
    [
      { chunk: chunks[0], index: 0 },
      { chunk: chunks[1], index: 1 },
    ],
  )
})

test('ignores unknown and reversed failed ranges', () => {
  assert.deepEqual(
    selectRetryChunks({
      transcription,
      chunks,
      failedRanges: [
        { startSegmentId: 'missing', endSegmentId: 's4' },
        { startSegmentId: 's6', endSegmentId: 's2' },
      ],
    }),
    [],
  )
})

test('removes old successful results overlapping selected new chunks', () => {
  const overlapping = { primaryStartSegmentId: 's1', primaryEndSegmentId: 's2' }
  const unaffected = { primaryStartSegmentId: 's7', primaryEndSegmentId: 's8' }

  assert.deepEqual(
    successfulResultsOutsideRetry({
      transcription,
      successfulChunkResults: [overlapping, unaffected],
      selectedChunks: [chunks[0]],
    }),
    [unaffected],
  )
})

test('ignores selected chunks with unknown or reversed ranges', () => {
  const results = [
    { primaryStartSegmentId: 's1', primaryEndSegmentId: 's2' },
    { primaryStartSegmentId: 's7', primaryEndSegmentId: 's8' },
  ]

  assert.deepEqual(
    successfulResultsOutsideRetry({
      transcription,
      successfulChunkResults: results,
      selectedChunks: [
        { primaryStartSegmentId: 'missing', primaryEndSegmentId: 's2' },
        { primaryStartSegmentId: 's8', primaryEndSegmentId: 's3' },
      ],
    }),
    results,
  )
})
