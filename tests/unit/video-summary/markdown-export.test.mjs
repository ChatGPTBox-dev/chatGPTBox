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
