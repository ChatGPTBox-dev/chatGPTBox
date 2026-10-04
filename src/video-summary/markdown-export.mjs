import { formatVideoOffset } from './time.mjs'

function renderList(title, items) {
  if (!Array.isArray(items) || items.length === 0) return ''
  return `## ${title}\n\n${items.map((item) => `- ${item}`).join('\n')}\n`
}

function renderKeyMoments(keyMoments) {
  if (!Array.isArray(keyMoments) || keyMoments.length === 0) return ''
  return `## Key Moments\n\n${keyMoments
    .map((moment) => {
      if (!Number.isFinite(moment.startMs)) return `- ${moment.point}`
      return `- ${formatVideoOffset(moment.startMs) || 'Unknown'}: ${moment.point}`
    })
    .join('\n')}\n`
}

function renderChapters(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) return ''
  return `## Chapters\n\n${chapters
    .map((chapter) => {
      const range = Number.isFinite(chapter.startMs)
        ? `\n${formatVideoOffset(chapter.startMs) || 'Unknown'} - ${
            formatVideoOffset(chapter.endMs) || 'Unknown'
          }`
        : ''
      return `### ${chapter.title}${range}\n\n${chapter.summary || ''}`
    })
    .join('\n\n')}\n`
}

function renderTranscript(transcriptSegments) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) return ''
  return `## Transcript\n\n${transcriptSegments
    .map((segment) => {
      const speaker = segment.speaker ? `${segment.speaker}: ` : ''
      return `- ${formatVideoOffset(segment.startMs) || 'Unknown'} ${speaker}${segment.text}`
    })
    .join('\n')}\n`
}

export function buildVideoSummaryMarkdown({ title, result, preferredLanguage }) {
  const lines = [
    `# ${String(title || 'Video Summary').trim() || 'Video Summary'}`,
    '',
    `- Status: ${result?.status || 'unknown'}`,
    `- Preferred Language: ${preferredLanguage || 'default'}`,
    '',
  ]

  const overview = result?.overview || result?.rawSummaryText
  if (overview) {
    lines.push('## Overview', '', overview, '')
  }

  const sections = [
    renderList('Key Points', result?.keyPoints),
    renderKeyMoments(result?.keyMoments),
    renderChapters(result?.chapters),
    renderTranscript(result?.transcriptSegments),
  ].filter(Boolean)

  return `${lines.join('\n')}${sections.join('\n')}`.trim()
}
