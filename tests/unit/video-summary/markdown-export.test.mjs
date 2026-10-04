import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoSummaryMarkdown } from '../../../src/video-summary/markdown-export.mjs'

test('markdown export renders video-relative offsets instead of Asia/Shanghai wall-clock dates', () => {
  const markdown = buildVideoSummaryMarkdown({
    title: 'Offset Video',
    preferredLanguage: 'en',
    result: {
      status: 'complete',
      overview: 'Overview',
      keyPoints: ['Point A'],
      keyMoments: [{ startMs: 0, point: 'Start here' }],
      chapters: [{ startMs: 0, endMs: 3_723_000, title: 'Opening', summary: 'Summary' }],
      transcriptSegments: [
        { id: 's1', startMs: 0, endMs: 1_000, speaker: 'Host', text: 'Welcome' },
        { id: 's2', startMs: -50, endMs: 59_999, speaker: null, text: 'Negative clamped' },
      ],
    },
  })

  assert.equal(markdown.includes('1970-01-01 08:00:00 Asia/Shanghai'), false)
  assert.equal(markdown.includes('00:00: Start here'), true)
  assert.equal(markdown.includes('00:00 - 01:02:03'), true)
  assert.equal(markdown.includes('- 00:00 Host: Welcome'), true)
  assert.equal(markdown.includes('- 00:00 Negative clamped'), true)
})

test('markdown export preserves anchored and unanchored free-text results without raw markers', () => {
  const markdown = buildVideoSummaryMarkdown({
    title: 'Tolerant Video',
    preferredLanguage: 'en',
    result: {
      status: 'partial',
      overview: 'Parsed overview',
      rawSummaryText: '[segment:secret] Raw model response',
      keyPoints: [
        { segmentId: 's1', startMs: 1_000, point: 'Anchored point' },
        { segmentId: null, startMs: null, point: 'Unanchored point' },
      ],
      keyMoments: [
        { startMs: 1_000, point: 'Anchored moment' },
        { startMs: null, point: 'Unanchored moment' },
      ],
      chapters: [
        {
          startMs: 2_000,
          endMs: 3_000,
          title: 'Anchored chapter',
          summary: 'Anchored chapter summary',
        },
        {
          startMs: null,
          endMs: null,
          title: 'Unanchored chapter',
          summary: 'Unanchored chapter summary',
        },
      ],
      transcriptSegments: [],
    },
  })

  assert.match(markdown, /Anchored/)
  assert.match(markdown, /Unanchored/)
  assert.match(markdown, /- 00:01: Anchored point/)
  assert.match(markdown, /- Unanchored point/)
  assert.match(markdown, /- Unanchored moment/)
  assert.doesNotMatch(markdown, /Unknown - Unknown/)
  assert.doesNotMatch(markdown, /NaN|segment:/)
})

test('markdown export uses raw summary text only when parsed overview is empty', () => {
  const markdown = buildVideoSummaryMarkdown({
    title: 'Raw Video',
    preferredLanguage: 'en',
    result: {
      status: 'partial',
      overview: '',
      rawSummaryText: 'Only available free-text summary',
      keyPoints: [],
      keyMoments: [],
      chapters: [],
      transcriptSegments: [],
    },
  })

  assert.match(markdown, /Only available free-text summary/)
})
