import { formatShanghaiTimestamp, formatVideoOffset } from './time.mjs'

function dedupeStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)))
}

function buildSegmentIndex(segments) {
  return new Map(segments.map((segment, index) => [segment.id, { segment, index }]))
}

function normalizeFailedRanges(failedRanges) {
  return (Array.isArray(failedRanges) ? failedRanges : [])
    .filter((range) => range?.startSegmentId && range?.endSegmentId)
    .map((range) => ({
      startSegmentId: range.startSegmentId,
      endSegmentId: range.endSegmentId,
      reason: range.reason ?? 'SUMMARY_RANGE_FAILED',
    }))
}

function buildCoveredSegmentIndexes(localChunkResults, segmentIndex) {
  const coveredIndexes = new Set()
  for (const chunkResult of Array.isArray(localChunkResults) ? localChunkResults : []) {
    const start = segmentIndex.get(chunkResult?.primaryStartSegmentId)?.index
    const end = segmentIndex.get(chunkResult?.primaryEndSegmentId)?.index
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) continue
    for (let index = start; index <= end; index += 1) coveredIndexes.add(index)
  }
  return coveredIndexes
}

function removeFailedIndexes(coveredIndexes, failedRanges, segmentIndex) {
  for (const range of failedRanges) {
    const start = segmentIndex.get(range.startSegmentId)?.index
    const end = segmentIndex.get(range.endSegmentId)?.index
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) continue
    for (let index = start; index <= end; index += 1) coveredIndexes.delete(index)
  }
}

function indexesToDuration(indexes, segments) {
  let total = 0
  for (const index of indexes) {
    const segment = segments[index]
    if (!segment) continue
    total += Math.max(0, (segment.endMs ?? 0) - (segment.startMs ?? 0))
  }
  return total
}

function getChapterCandidates(localChunkResults, synthesisResult) {
  if (Array.isArray(synthesisResult?.chapterStarts)) return synthesisResult.chapterStarts

  return (Array.isArray(localChunkResults) ? localChunkResults : []).flatMap((chunkResult) =>
    Array.isArray(chunkResult?.chapterStarts) ? chunkResult.chapterStarts : [],
  )
}

function getOrderedCoveredIndexes(coveredIndexes) {
  return Array.from(coveredIndexes).sort((left, right) => left - right)
}

function getLastCoveredIndexBefore(orderedCoveredIndexes, nextIndex) {
  let candidate = null
  for (const index of orderedCoveredIndexes) {
    if (index >= nextIndex) break
    candidate = index
  }
  return candidate
}

function buildChapters({
  segments,
  localChunkResults,
  synthesisResult,
  coveredIndexes,
  segmentIndex,
}) {
  const orderedCoveredIndexes = getOrderedCoveredIndexes(coveredIndexes)
  if (orderedCoveredIndexes.length === 0) return []

  const candidates = getChapterCandidates(localChunkResults, synthesisResult)
  const filteredStarts = []
  const seenIndexes = new Set()

  for (const candidate of candidates) {
    const info = segmentIndex.get(candidate?.segmentId)
    if (!info || !coveredIndexes.has(info.index) || seenIndexes.has(info.index)) continue
    seenIndexes.add(info.index)
    filteredStarts.push({
      index: info.index,
      segmentId: candidate.segmentId,
      title: String(candidate?.title || '').trim() || 'Chapter',
      summary: String(candidate?.summary || '').trim(),
    })
  }

  filteredStarts.sort((left, right) => left.index - right.index)

  if (filteredStarts.length === 0) {
    const firstIndex = orderedCoveredIndexes[0]
    const lastIndex = orderedCoveredIndexes.at(-1)
    return [
      {
        startSegmentId: segments[firstIndex].id,
        endSegmentId: segments[lastIndex].id,
        startMs: segments[firstIndex].startMs,
        endMs: segments[lastIndex].endMs,
        title: 'Summary',
        summary:
          (Array.isArray(localChunkResults) ? localChunkResults : [])
            .map((chunkResult) => String(chunkResult?.localSummary || '').trim())
            .filter(Boolean)
            .join('\n\n') || 'Summary unavailable.',
      },
    ]
  }

  filteredStarts[0].index = orderedCoveredIndexes[0]
  filteredStarts[0].segmentId = segments[orderedCoveredIndexes[0]].id

  return filteredStarts.map((start, index) => {
    const nextStart = filteredStarts[index + 1]
    const endIndex = nextStart
      ? getLastCoveredIndexBefore(orderedCoveredIndexes, nextStart.index)
      : orderedCoveredIndexes.at(-1)

    return {
      startSegmentId: segments[start.index].id,
      endSegmentId: segments[endIndex].id,
      startMs: segments[start.index].startMs,
      endMs: segments[endIndex].endMs,
      title: start.title,
      summary: start.summary,
    }
  })
}

function buildKeyMoments({ localChunkResults, synthesisResult, coveredIndexes, segmentIndex }) {
  const sourceMoments = Array.isArray(synthesisResult?.keyMoments)
    ? synthesisResult.keyMoments
    : (Array.isArray(localChunkResults) ? localChunkResults : []).flatMap((chunkResult) =>
        Array.isArray(chunkResult?.keyMoments) ? chunkResult.keyMoments : [],
      )

  const seen = new Set()
  const moments = []

  for (const moment of sourceMoments) {
    const info = segmentIndex.get(moment?.segmentId)
    if (!info || !coveredIndexes.has(info.index) || seen.has(info.segment.id)) continue
    seen.add(info.segment.id)
    moments.push({
      segmentId: info.segment.id,
      startMs: info.segment.startMs,
      point: String(moment?.point || '').trim(),
    })
  }

  moments.sort((left, right) => left.startMs - right.startMs)
  return moments.filter((moment) => moment.point)
}

function buildOverview(localChunkResults, synthesisResult) {
  if (typeof synthesisResult?.overview === 'string' && synthesisResult.overview.trim()) {
    return synthesisResult.overview.trim()
  }

  return (Array.isArray(localChunkResults) ? localChunkResults : [])
    .map((chunkResult) => String(chunkResult?.localSummary || '').trim())
    .filter(Boolean)
    .join('\n\n')
}

function buildWarnings(status, failedRanges, synthesisResult, localChunkResults) {
  const warnings = []
  if (failedRanges.length > 0) warnings.push('Some transcript ranges could not be summarized.')
  if (!synthesisResult && (Array.isArray(localChunkResults) ? localChunkResults.length : 0) > 0) {
    warnings.push('Summary synthesis was unavailable; local summaries were used instead.')
  }
  if (status === 'degraded' && warnings.length === 0) {
    warnings.push('Structured summary data is incomplete.')
  }
  return warnings
}

export function buildStructuredSummaryResult({
  transcription,
  localChunkResults,
  synthesisResult,
  failedRanges,
}) {
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : []
  const segmentIndex = buildSegmentIndex(segments)
  const normalizedFailedRanges = normalizeFailedRanges(failedRanges)
  const coveredIndexes = buildCoveredSegmentIndexes(localChunkResults, segmentIndex)

  removeFailedIndexes(coveredIndexes, normalizedFailedRanges, segmentIndex)

  const totalDurationMs = Number.isFinite(transcription?.durationMs)
    ? transcription.durationMs
    : indexesToDuration(
        segments.map((_, index) => index),
        segments,
      )
  const coveredDurationMs = indexesToDuration(coveredIndexes, segments)
  const hasLocalSummaries = (Array.isArray(localChunkResults) ? localChunkResults.length : 0) > 0
  const status = synthesisResult
    ? normalizedFailedRanges.length > 0
      ? 'partial'
      : 'complete'
    : hasLocalSummaries
    ? 'degraded'
    : 'degraded'

  return {
    status,
    overview: buildOverview(localChunkResults, synthesisResult),
    keyPoints: dedupeStrings(
      Array.isArray(synthesisResult?.keyPoints)
        ? synthesisResult.keyPoints
        : (Array.isArray(localChunkResults) ? localChunkResults : []).flatMap((chunkResult) =>
            Array.isArray(chunkResult?.keyPoints) ? chunkResult.keyPoints : [],
          ),
    ),
    keyMoments: buildKeyMoments({
      localChunkResults,
      synthesisResult,
      coveredIndexes,
      segmentIndex,
    }),
    chapters: buildChapters({
      segments,
      localChunkResults,
      synthesisResult,
      coveredIndexes,
      segmentIndex,
    }),
    transcriptSegments: segments.map((segment) => ({ ...segment })),
    coverage: {
      coveredDurationMs,
      totalDurationMs,
      ratio: totalDurationMs > 0 ? Number((coveredDurationMs / totalDurationMs).toFixed(4)) : 0,
    },
    warnings: buildWarnings(status, normalizedFailedRanges, synthesisResult, localChunkResults),
    failedRanges: normalizedFailedRanges,
  }
}

export { formatShanghaiTimestamp, formatVideoOffset }
