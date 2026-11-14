import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkTranscriptForSummary } from '../../../src/video-summary/summary-chunker.mjs'

function createSegments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index + 1}`,
    startMs: index * 1000,
    endMs: index * 1000 + 1000,
    text: `segment ${index + 1}`,
  }))
}

test('chunking keeps two overlap segments on each side and splits oversized ranges recursively', () => {
  const chunks = chunkTranscriptForSummary({
    transcription: {
      segments: createSegments(12),
    },
    inputTokenBudget: 10,
  })

  assert.ok(chunks.length > 1)
  assert.equal(chunks[0].contextBeforeSegmentIds.length, 0)
  assert.equal(chunks[0].contextAfterSegmentIds.length <= 2, true)
  assert.equal(chunks.at(-1).contextAfterSegmentIds.length, 0)
  assert.equal(chunks.at(-1).contextBeforeSegmentIds.length <= 2, true)

  for (const chunk of chunks) {
    assert.equal(chunk.contextBeforeSegmentIds.length <= 2, true)
    assert.equal(chunk.contextAfterSegmentIds.length <= 2, true)
    assert.equal(chunk.primarySegmentIds.length >= 1, true)
  }

  assert.deepEqual(chunks[0].primarySegmentIds, ['s1', 's2', 's3'])
  assert.deepEqual(chunks[0].contextAfterSegmentIds, ['s4', 's5'])
  assert.deepEqual(chunks[1].contextBeforeSegmentIds, ['s2', 's3'])
})
