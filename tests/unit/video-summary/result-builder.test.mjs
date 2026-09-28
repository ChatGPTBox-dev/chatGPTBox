import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildStructuredSummaryResult,
  formatVideoOffset,
  formatShanghaiTimestamp,
} from '../../../src/video-summary/result-builder.mjs'

function createTranscription() {
  return {
    durationMs: 4000,
    segments: [
      { id: 's1', startMs: 0, endMs: 1000, text: 'intro', speaker: null, confidence: null },
      { id: 's2', startMs: 1000, endMs: 2000, text: 'topic a', speaker: null, confidence: null },
      { id: 's3', startMs: 2000, endMs: 3000, text: 'topic b', speaker: null, confidence: null },
      { id: 's4', startMs: 3000, endMs: 4000, text: 'wrap', speaker: null, confidence: null },
    ],
  }
}

test('result builder emits degraded output when synthesis fails but local summaries exist', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's2',
        localSummary: 'overview',
        chapterStarts: [],
        keyMoments: [],
        keyPoints: ['point'],
      },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.equal(result.status, 'degraded')
  assert.equal(result.transcriptSegments.length, 4)
  assert.equal(result.overview.includes('overview'), true)
  assert.deepEqual(result.keyPoints, ['point'])
})

test('result builder emits partial output with deterministic chapters and failed-range coverage', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's2',
        localSummary: 'first half',
        chapterStarts: [{ segmentId: 's2', title: 'ignored local', summary: 'ignored' }],
        keyMoments: [{ segmentId: 's2', point: 'moment from chunk' }],
        keyPoints: ['keep'],
      },
      {
        primaryStartSegmentId: 's4',
        primaryEndSegmentId: 's4',
        localSummary: 'ending',
        chapterStarts: [{ segmentId: 's4', title: 'ending', summary: 'ending summary' }],
        keyMoments: [{ segmentId: 's4', point: 'ending moment' }],
        keyPoints: ['keep', 'ending'],
      },
    ],
    synthesisResult: {
      overview: 'final overview',
      keyPoints: ['keep', 'final'],
      chapterStarts: [
        { segmentId: 'missing', title: 'bad', summary: 'bad' },
        { segmentId: 's4', title: 'Ending', summary: 'end summary' },
        { segmentId: 's1', title: 'Opening', summary: 'open summary' },
        { segmentId: 's4', title: 'Duplicate', summary: 'duplicate' },
      ],
      keyMoments: [
        { segmentId: 's4', point: 'ending moment' },
        { segmentId: 'missing', point: 'invalid' },
        { segmentId: 's1', point: 'opening moment' },
      ],
    },
    failedRanges: [{ startSegmentId: 's3', endSegmentId: 's3', reason: 'CHUNK_FAILED' }],
  })

  assert.equal(result.status, 'partial')
  assert.equal(result.coverage.coveredDurationMs, 3000)
  assert.equal(result.coverage.totalDurationMs, 4000)
  assert.equal(result.coverage.ratio, 0.75)
  assert.deepEqual(result.failedRanges, [
    { startSegmentId: 's3', endSegmentId: 's3', reason: 'CHUNK_FAILED' },
  ])
  assert.deepEqual(
    result.chapters.map((chapter) => ({
      startSegmentId: chapter.startSegmentId,
      endSegmentId: chapter.endSegmentId,
      title: chapter.title,
    })),
    [
      { startSegmentId: 's1', endSegmentId: 's2', title: 'Opening' },
      { startSegmentId: 's4', endSegmentId: 's4', title: 'Ending' },
    ],
  )
  assert.deepEqual(result.keyMoments, [
    { segmentId: 's1', startMs: 0, point: 'opening moment' },
    { segmentId: 's4', startMs: 3000, point: 'ending moment' },
  ])
})

test('wall-clock timestamps still render in Asia/Shanghai', () => {
  assert.equal(formatShanghaiTimestamp(0), '1970-01-01 08:00:00 Asia/Shanghai')
  assert.equal(formatShanghaiTimestamp(null), null)
})

test('video offsets render deterministic elapsed labels', () => {
  assert.equal(formatVideoOffset(0), '00:00')
  assert.equal(formatVideoOffset(59_999), '00:59')
  assert.equal(formatVideoOffset(3_600_000), '01:00:00')
  assert.equal(formatVideoOffset(Number.NaN), null)
  assert.equal(formatVideoOffset(-1), '00:00')
})
