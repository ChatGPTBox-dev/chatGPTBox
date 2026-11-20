import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoSummaryMarkdown } from '../../../src/video-summary/markdown-export.mjs'
import {
  serializeMarkdownHeading,
  serializeMarkdownInline,
  serializeMarkdownListItem,
  serializeMarkdownParagraph,
} from '../../../src/video-summary/markdown-serializer.mjs'

const maliciousMarkdown =
  '<script>x</script> <img src=x> [link](javascript:x) https://evil.example # heading - list ``` | pipe'

test('context serializers escape structured Markdown fields and normalize line endings', () => {
  const escaped =
    '&lt;script&gt;x&lt;/script&gt; &lt;img src=x&gt; \\[link\\]\\(javascript\\:x\\) https\\:\u200b//evil\\.example \\# heading \\- list \\`\\`\\` \\| pipe'

  assert.equal(serializeMarkdownHeading(`${maliciousMarkdown}\r\nnext`), `${escaped} next`)
  assert.equal(serializeMarkdownInline(`${maliciousMarkdown}\nnext`), `${escaped} next`)
  assert.equal(serializeMarkdownListItem(`${maliciousMarkdown}\nnext`), `${escaped} next`)
  assert.equal(
    serializeMarkdownParagraph(`${maliciousMarkdown}\r\n\r\n# next`),
    `${escaped}\n\\ \n\\# next`,
  )
})

test('markdown export renders video-relative offsets instead of Asia/Shanghai wall-clock dates', () => {
  const markdown = buildVideoSummaryMarkdown({
    title: 'Offset Video',
    preferredLanguage: 'en',
    result: {
      status: 'complete',
      overview: 'Overview',
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
  assert.equal(markdown.includes('- 00:00 Host\\: Welcome'), true)
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
      keyMoments: [
        { startMs: 1_000, point: 'Anchored content' },
        { startMs: null, point: 'Unanchored content' },
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

  assert.match(markdown, /## Key Content/)
  assert.match(markdown, /Anchored/)
  assert.match(markdown, /Unanchored/)
  assert.match(markdown, /- 00:01: Anchored content/)
  assert.match(markdown, /- Unanchored content/)
  assert.doesNotMatch(markdown, /## Key Points|## Key Moments/)
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
      keyMoments: [],
      chapters: [],
      transcriptSegments: [],
    },
  })

  assert.match(markdown, /Only available free\\-text summary/)
})
