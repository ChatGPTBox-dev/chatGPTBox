export const EVIDENCE_LEDGER_LIMITS = Object.freeze({
  topicCount: 24,
  topicCharacters: 160,
  narrativeCount: 80,
  narrativeCharacters: 240,
  evidenceCount: 120,
  evidenceCharacters: 240,
  chapterCount: 30,
  chapterTitleCharacters: 100,
  chapterDescriptionCharacters: 240,
  pendingCount: 30,
  pendingCharacters: 180,
  totalCharacters: 16_000,
})

const HEADINGS = new Map([
  ['主题与人物', 'topics'],
  ['叙事与论证', 'narrative'],
  ['事实与证据', 'evidence'],
  ['章节候选', 'chapterCandidates'],
  ['待补信息', 'pending'],
  ['覆盖位置', 'coveredThroughSegmentId'],
])
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+/
const SEGMENT_MARKER = /\[segment:([^\]\s]+)\]/i

function clampText(value, maximum) {
  return Array.from(String(value || '').trim())
    .slice(0, maximum)
    .join('')
}

function normalizedText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function splitSections(text) {
  const sections = new Map()
  let section = null
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      section = HEADINGS.get(heading[1].trim()) || null
      if (section && !sections.has(section)) sections.set(section, [])
    } else if (section) {
      sections.get(section).push(line)
    }
  }
  return sections
}

function sectionItems(lines = []) {
  const items = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (LIST_PREFIX.test(line) || !/^\s/.test(line) || items.length === 0) {
      items.push(line.replace(LIST_PREFIX, '').trim())
    } else {
      items[items.length - 1] += `\n${line.trim()}`
    }
  }
  return items
}

function deduplicate(items, maximum, textOf) {
  const seenIds = new Set()
  const seenText = new Set()
  const result = []
  for (const item of items) {
    const text = normalizedText(textOf(item))
    if (!text || seenText.has(text) || (item.segmentId && seenIds.has(item.segmentId))) continue
    seenText.add(text)
    if (item.segmentId) seenIds.add(item.segmentId)
    result.push(item)
    if (result.length === maximum) break
  }
  return result
}

function resolveAnchor(line, allowedSegmentIds) {
  const candidate = line.match(SEGMENT_MARKER)?.[1] || null
  return {
    segmentId: candidate && allowedSegmentIds.has(candidate) ? candidate : null,
    text: line.replace(SEGMENT_MARKER, '').trim(),
  }
}

function parseTextItems(lines, count, characters) {
  return deduplicate(
    sectionItems(lines).map((item) => clampText(item.replace(/\s+/g, ' '), characters)),
    count,
    (item) => item,
  )
}

function parseAnchoredItems(lines, allowedSegmentIds, count, characters) {
  return deduplicate(
    sectionItems(lines).map((line) => {
      const { segmentId, text } = resolveAnchor(line, allowedSegmentIds)
      return { segmentId, text: clampText(text.replace(/\s+/g, ' '), characters) }
    }),
    count,
    ({ text }) => text,
  )
}

function parseChapterCandidates(lines, allowedSegmentIds) {
  return deduplicate(
    sectionItems(lines).map((line) => {
      const { segmentId, text } = resolveAnchor(line, allowedSegmentIds)
      const separator = text.search(/[—\-:：\n]/)
      return {
        segmentId,
        title: clampText(
          separator < 0 ? text : text.slice(0, separator),
          EVIDENCE_LEDGER_LIMITS.chapterTitleCharacters,
        ),
        summary: clampText(
          separator < 0 ? '' : text.slice(separator + 1).replace(/\s+/g, ' '),
          EVIDENCE_LEDGER_LIMITS.chapterDescriptionCharacters,
        ),
      }
    }),
    EVIDENCE_LEDGER_LIMITS.chapterCount,
    ({ title, summary }) => (title ? `${title} ${summary}` : ''),
  )
}

function parseCoveredThrough(lines, allowedSegmentIds) {
  const value = lines.join('\n').trim()
  const candidate = value.match(SEGMENT_MARKER)?.[1] || value.match(/^([^\s]+)$/)?.[1] || null
  return candidate && allowedSegmentIds.has(candidate) ? candidate : null
}

export function parseEvidenceLedgerMarkdown(text, { allowedSegmentIds = new Set() } = {}) {
  const rawText = String(text || '')
  if (Array.from(rawText).length > EVIDENCE_LEDGER_LIMITS.totalCharacters) {
    const error = new Error('MODEL_EVIDENCE_LEDGER_LIMIT_EXCEEDED')
    error.code = 'MODEL_EVIDENCE_LEDGER_LIMIT_EXCEEDED'
    throw error
  }
  const sections = splitSections(rawText)
  return {
    topics: parseTextItems(
      sections.get('topics'),
      EVIDENCE_LEDGER_LIMITS.topicCount,
      EVIDENCE_LEDGER_LIMITS.topicCharacters,
    ),
    narrative: parseAnchoredItems(
      sections.get('narrative'),
      allowedSegmentIds,
      EVIDENCE_LEDGER_LIMITS.narrativeCount,
      EVIDENCE_LEDGER_LIMITS.narrativeCharacters,
    ),
    evidence: parseAnchoredItems(
      sections.get('evidence'),
      allowedSegmentIds,
      EVIDENCE_LEDGER_LIMITS.evidenceCount,
      EVIDENCE_LEDGER_LIMITS.evidenceCharacters,
    ),
    chapterCandidates: parseChapterCandidates(sections.get('chapterCandidates'), allowedSegmentIds),
    pending: parseTextItems(
      sections.get('pending'),
      EVIDENCE_LEDGER_LIMITS.pendingCount,
      EVIDENCE_LEDGER_LIMITS.pendingCharacters,
    ),
    coveredThroughSegmentId: parseCoveredThrough(
      sections.get('coveredThroughSegmentId') || [],
      allowedSegmentIds,
    ),
    rawText,
  }
}

export function splitTranscriptRange(range) {
  const startIndex = Number.isInteger(range?.startIndex) ? range.startIndex : 0
  const endIndex = Number.isInteger(range?.endIndex) ? range.endIndex : startIndex
  if (endIndex - startIndex <= 1) return []
  const midpoint = startIndex + Math.floor((endIndex - startIndex) / 2)
  return [
    { startIndex, endIndex: midpoint },
    { startIndex: midpoint, endIndex },
  ]
}
