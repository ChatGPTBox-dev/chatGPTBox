import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStructuredSummaryResult } from '../../../src/video-summary/result-builder.mjs'
import { formatVideoOffset } from '../../../src/video-summary/time.mjs'

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

test('preserves unanchored free-text entries without inventing timestamps', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's3',
        localSummary: 'local',
        keyPoints: ['local point'],
        candidates: [],
      },
    ],
    synthesisResult: {
      overview: 'final',
      rawText: 'raw private answer',
      keyPoints: ['point'],
      chapters: [
        { segmentId: 's1', title: 'Anchored', summary: 'a', anchored: true },
        { segmentId: null, title: 'Unanchored', summary: 'b', anchored: false },
      ],
      keyMoments: [
        { segmentId: 's2', point: 'Jump', anchored: true },
        { segmentId: null, point: 'Read only', anchored: false },
      ],
    },
    failedRanges: [],
  })

  assert.equal(result.rawSummaryText, 'raw private answer')
  assert.equal(result.warnings.includes('VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE'), true)
  assert.deepEqual(result.chapters[1], {
    startSegmentId: null,
    endSegmentId: null,
    startMs: null,
    endMs: null,
    title: 'Unanchored',
    summary: 'b',
  })
  assert.deepEqual(result.keyMoments[1], {
    segmentId: null,
    startMs: null,
    point: 'Read only',
  })
})

test('omits obsolete final key points', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's4',
        localSummary: 'local',
        keyPoints: ['local point'],
        candidates: [{ segmentId: 's2', text: 'candidate', anchored: true }],
      },
    ],
    synthesisResult: {
      overview: 'final',
      keyPoints: [
        { segmentId: 's2', point: 'Anchored point', anchored: true },
        { segmentId: null, point: 'Invalid point', anchored: false },
      ],
      chapters: [],
      keyMoments: [],
    },
    failedRanges: [],
  })

  assert.equal('keyPoints' in result, false)
})

test('uses local summaries and candidates when final output is absent', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's2',
        localSummary: 'first local',
        keyPoints: ['local point'],
        candidates: [{ segmentId: 's2', text: 'local candidate', anchored: true }],
      },
      {
        primaryStartSegmentId: 's3',
        primaryEndSegmentId: 's4',
        localSummary: 'second local',
        keyPoints: ['another point'],
        candidates: [{ segmentId: null, text: 'unanchored candidate', anchored: false }],
      },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.equal(result.rawSummaryText, '')
  assert.equal(result.overview, 'first local\n\nsecond local')
  assert.equal('keyPoints' in result, false)
  assert.deepEqual(result.keyMoments, [
    { segmentId: 's2', startMs: 1000, point: 'local candidate' },
    { segmentId: null, startMs: null, point: 'unanchored candidate' },
  ])
})

test('invalid and unanchored locations do not change complete status to partial', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's4',
        localSummary: 'local',
        keyPoints: [],
        candidates: [],
      },
    ],
    synthesisResult: {
      overview: 'final',
      keyPoints: [],
      chapters: [
        { segmentId: 'missing', title: 'Missing', summary: 'ignored', anchored: true },
        { segmentId: null, title: 'Unanchored', summary: 'kept', anchored: false },
      ],
      keyMoments: [
        { segmentId: 'missing', point: 'ignored', anchored: true },
        { segmentId: null, point: 'kept', anchored: false },
      ],
    },
    failedRanges: [],
  })

  assert.equal(result.status, 'complete')
  assert.deepEqual(result.chapters, [
    {
      startSegmentId: null,
      endSegmentId: null,
      startMs: null,
      endMs: null,
      title: 'Unanchored',
      summary: 'kept',
    },
  ])
  assert.deepEqual(result.keyMoments, [{ segmentId: null, startMs: null, point: 'kept' }])
})

test('raw summary text falls back to an empty string', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's1',
        localSummary: 'local',
        keyPoints: [],
        candidates: [],
      },
    ],
    synthesisResult: { overview: 'final', keyPoints: [], chapters: [], keyMoments: [] },
    failedRanges: [],
  })

  assert.equal(result.rawSummaryText, '')
})

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
  assert.equal('keyPoints' in result, false)
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
        { segmentId: 's2', point: '  Opening   Moment  ' },
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

test('explicit segment IDs provide full direct coverage and valid anchors without chunk results', () => {
  const transcription = createTranscription()
  const result = buildStructuredSummaryResult({
    transcription,
    localChunkResults: [],
    synthesisResult: {
      overview: 'direct summary',
      chapters: [{ segmentId: 's1', title: 'Opening', summary: 'Summary' }],
      keyMoments: [{ segmentId: 's1', point: 'Opening moment' }],
    },
    failedRanges: [],
    coveredSegmentIds: transcription.segments.map(({ id }) => id),
  })

  assert.equal(result.coverage.ratio, 1)
  assert.equal(result.keyMoments[0].startMs, transcription.segments[0].startMs)
  assert.equal(result.chapters[0].startSegmentId, 's1')
  assert.equal(result.chapters[0].endSegmentId, 's4')
})

test('explicit segment ID prefixes limit coverage and valid anchors', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [],
    synthesisResult: {
      overview: 'rolling summary',
      chapters: [
        { segmentId: 's1', title: 'Opening', summary: 'Summary' },
        { segmentId: 's3', title: 'Outside prefix', summary: 'Ignored' },
      ],
      keyMoments: [
        { segmentId: 's2', point: 'Covered moment' },
        { segmentId: 's3', point: 'Outside prefix' },
      ],
    },
    failedRanges: [],
    coveredSegmentIds: ['s1', 's2'],
  })

  assert.equal(result.coverage.ratio, 0.5)
  assert.deepEqual(
    result.chapters.map(({ startSegmentId, endSegmentId }) => ({ startSegmentId, endSegmentId })),
    [{ startSegmentId: 's1', endSegmentId: 's2' }],
  )
  assert.deepEqual(result.keyMoments, [{ segmentId: 's2', startMs: 1000, point: 'Covered moment' }])
})

test('explicit coverage ignores invalid segment IDs', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [],
    synthesisResult: {
      overview: 'direct summary',
      chapters: [],
      keyMoments: [
        { segmentId: 'missing', point: 'Invalid' },
        { segmentId: 's2', point: 'Valid' },
      ],
    },
    failedRanges: [],
    coveredSegmentIds: new Set(['missing', 's2']),
  })

  assert.equal(result.coverage.ratio, 0.25)
  assert.deepEqual(result.keyMoments, [{ segmentId: 's2', startMs: 1000, point: 'Valid' }])
})

test('failed ranges subtract from explicit coverage', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [],
    synthesisResult: {
      overview: 'rolling summary',
      chapters: [],
      keyMoments: [
        { segmentId: 's2', point: 'Failed' },
        { segmentId: 's3', point: 'Covered' },
      ],
    },
    failedRanges: [{ startSegmentId: 's2', endSegmentId: 's2', reason: 'CHUNK_FAILED' }],
    coveredSegmentIds: ['s1', 's2', 's3'],
  })

  assert.equal(result.coverage.ratio, 0.5)
  assert.deepEqual(result.keyMoments, [{ segmentId: 's3', startMs: 2000, point: 'Covered' }])
})

test('coverage unions fully and partially overlapping canonical cue intervals', () => {
  const result = buildStructuredSummaryResult({
    transcription: {
      durationMs: 4000,
      segments: [
        { id: 's1', startMs: 0, endMs: 2000 },
        { id: 's2', startMs: 1000, endMs: 3000 },
        { id: 's3', startMs: 2500, endMs: 3500 },
      ],
    },
    localChunkResults: [
      { primaryStartSegmentId: 's1', primaryEndSegmentId: 's3', localSummary: 'covered' },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.deepEqual(result.coverage, {
    coveredDurationMs: 3500,
    totalDurationMs: 4000,
    ratio: 0.875,
  })
})

test('coverage merges adjacent canonical cue intervals', () => {
  const result = buildStructuredSummaryResult({
    transcription: {
      durationMs: 4000,
      segments: [
        { id: 's1', startMs: 0, endMs: 1000 },
        { id: 's2', startMs: 1000, endMs: 2000 },
      ],
    },
    localChunkResults: [
      { primaryStartSegmentId: 's1', primaryEndSegmentId: 's2', localSummary: 'covered' },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.deepEqual(result.coverage, {
    coveredDurationMs: 2000,
    totalDurationMs: 4000,
    ratio: 0.5,
  })
})

test('coverage clips canonical cues and ignores malformed or fully out-of-bounds intervals', () => {
  const result = buildStructuredSummaryResult({
    transcription: {
      durationMs: 4000,
      segments: [
        { id: 'negative', startMs: -500, endMs: 500 },
        { id: 'after', startMs: 3500, endMs: 5000 },
        { id: 'before', startMs: -2000, endMs: -1000 },
        { id: 'beyond', startMs: 4500, endMs: 5000 },
        { id: 'reversed', startMs: 3000, endMs: 2000 },
        { id: 'nan', startMs: Number.NaN, endMs: 1000 },
        { id: 'infinite', startMs: 1000, endMs: Number.POSITIVE_INFINITY },
      ],
    },
    localChunkResults: [
      {
        primaryStartSegmentId: 'negative',
        primaryEndSegmentId: 'infinite',
        localSummary: 'covered',
      },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.deepEqual(result.coverage, {
    coveredDurationMs: 1000,
    totalDurationMs: 4000,
    ratio: 0.25,
  })
})

test('coverage uses only successful primary ranges and excludes failed ranges', () => {
  const result = buildStructuredSummaryResult({
    transcription: {
      durationMs: 4000,
      segments: [
        { id: 's1', startMs: 0, endMs: 1000 },
        { id: 's2', startMs: 1000, endMs: 2000 },
        { id: 's3', startMs: 2000, endMs: 3000 },
        { id: 's4', startMs: 3000, endMs: 4000 },
      ],
    },
    localChunkResults: [
      { primaryStartSegmentId: 's1', primaryEndSegmentId: 's3', localSummary: 'covered' },
      { primaryStartSegmentId: 'missing', primaryEndSegmentId: 's4', localSummary: 'ignored' },
    ],
    synthesisResult: null,
    failedRanges: [{ startSegmentId: 's2', endSegmentId: 's2', reason: 'CHUNK_FAILED' }],
  })

  assert.deepEqual(result.coverage, {
    coveredDurationMs: 2000,
    totalDurationMs: 4000,
    ratio: 0.5,
  })
})

test('coverage clamps overlapping totals to the canonical transcription duration', () => {
  const result = buildStructuredSummaryResult({
    transcription: {
      durationMs: 4000,
      segments: [
        { id: 's1', startMs: -1000, endMs: 5000 },
        { id: 's2', startMs: 0, endMs: 4000 },
        { id: 's3', startMs: 1000, endMs: 3000 },
      ],
    },
    localChunkResults: [
      { primaryStartSegmentId: 's1', primaryEndSegmentId: 's3', localSummary: 'covered' },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.deepEqual(result.coverage, {
    coveredDurationMs: 4000,
    totalDurationMs: 4000,
    ratio: 1,
  })
})

test('coverage always uses canonical duration and returns finite zeroes for invalid durations', () => {
  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = buildStructuredSummaryResult({
      transcription: {
        durationMs,
        segments: [{ id: 's1', startMs: 0, endMs: 1000 }],
      },
      localChunkResults: [
        { primaryStartSegmentId: 's1', primaryEndSegmentId: 's1', localSummary: 'covered' },
      ],
      synthesisResult: null,
      failedRanges: [],
    })

    assert.deepEqual(result.coverage, {
      coveredDurationMs: 0,
      totalDurationMs: 0,
      ratio: 0,
    })
    assert.equal(Object.values(result.coverage).every(Number.isFinite), true)
  }

  const result = buildStructuredSummaryResult({
    transcription: {
      durationMs: 4000,
      segments: [{ id: 's1', startMs: 0, endMs: 1000 }],
    },
    localChunkResults: [
      { primaryStartSegmentId: 's1', primaryEndSegmentId: 's1', localSummary: 'covered' },
    ],
    synthesisResult: null,
    failedRanges: [],
  })

  assert.equal(result.coverage.totalDurationMs, 4000)
  assert.equal(result.coverage.ratio, 0.25)
})

test('video offsets render deterministic elapsed labels', () => {
  assert.equal(formatVideoOffset(0), '00:00')
  assert.equal(formatVideoOffset(59_999), '00:59')
  assert.equal(formatVideoOffset(3_600_000), '01:00:00')
  assert.equal(formatVideoOffset(Number.NaN), null)
  assert.equal(formatVideoOffset(-1), '00:00')
})
