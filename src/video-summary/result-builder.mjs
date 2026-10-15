const UNANCHORED_LOCATION_WARNING = 'VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE'

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

function buildCoveredSegmentIndexes(localChunkResults, segmentIndex, coveredSegmentIds) {
  if (coveredSegmentIds !== undefined) {
    return new Set(
      Array.from(coveredSegmentIds)
        .map((id) => segmentIndex.get(id)?.index)
        .filter(Number.isInteger),
    )
  }

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

function calculateCoverage({ transcription, coveredIndexes }) {
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : []
  const totalDurationMs =
    Number.isFinite(transcription?.durationMs) && transcription.durationMs > 0
      ? transcription.durationMs
      : 0
  if (totalDurationMs === 0) return { coveredDurationMs: 0, totalDurationMs: 0, ratio: 0 }

  const intervals = Array.from(coveredIndexes)
    .map((index) => segments[index])
    .filter((segment) => Number.isFinite(segment?.startMs) && Number.isFinite(segment?.endMs))
    .map((segment) => [
      Math.max(0, Math.min(totalDurationMs, segment.startMs)),
      Math.max(0, Math.min(totalDurationMs, segment.endMs)),
    ])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])

  const merged = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (!previous || interval[0] > previous[1]) merged.push(interval)
    else previous[1] = Math.max(previous[1], interval[1])
  }

  const coveredDurationMs = Math.min(
    totalDurationMs,
    merged.reduce((total, [start, end]) => total + end - start, 0),
  )
  return {
    coveredDurationMs,
    totalDurationMs,
    ratio: Number(Math.max(0, Math.min(1, coveredDurationMs / totalDurationMs)).toFixed(4)),
  }
}

function getChapterCandidates(localChunkResults, synthesisResult) {
  if (Array.isArray(synthesisResult?.chapters)) return synthesisResult.chapters
  if (Array.isArray(synthesisResult?.chapterStarts)) return synthesisResult.chapterStarts

  return (Array.isArray(localChunkResults) ? localChunkResults : []).flatMap((chunkResult) =>
    Array.isArray(chunkResult?.chapterStarts) ? chunkResult.chapterStarts : [],
  )
}

function getMomentCandidates(localChunkResults, synthesisResult) {
  if (Array.isArray(synthesisResult?.keyMoments)) return synthesisResult.keyMoments

  return (Array.isArray(localChunkResults) ? localChunkResults : []).flatMap((chunkResult) => {
    if (Array.isArray(chunkResult?.candidates)) return chunkResult.candidates
    return Array.isArray(chunkResult?.keyMoments) ? chunkResult.keyMoments : []
  })
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

function isUnanchoredCandidate(candidate) {
  return candidate?.anchored === false && !candidate?.segmentId
}

function buildFallbackChapter({ segments, localChunkResults, orderedCoveredIndexes }) {
  if (orderedCoveredIndexes.length === 0) return []

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

function buildChapters({
  segments,
  localChunkResults,
  synthesisResult,
  coveredIndexes,
  segmentIndex,
}) {
  const orderedCoveredIndexes = getOrderedCoveredIndexes(coveredIndexes)
  const candidates = getChapterCandidates(localChunkResults, synthesisResult)
  const anchored = []
  const unanchored = []
  const seenIndexes = new Set()

  for (const candidate of candidates) {
    if (isUnanchoredCandidate(candidate)) {
      const title = String(candidate?.title || '').trim()
      const summary = String(candidate?.summary || '').trim()
      if (!title && !summary) continue
      unanchored.push({
        startSegmentId: null,
        endSegmentId: null,
        startMs: null,
        endMs: null,
        title: title || 'Chapter',
        summary,
      })
      continue
    }

    const info = segmentIndex.get(candidate?.segmentId)
    if (!info || !coveredIndexes.has(info.index) || seenIndexes.has(info.index)) continue

    const title = String(candidate?.title || '').trim()
    const summary = String(candidate?.summary || '').trim()
    if (!title && !summary) continue

    seenIndexes.add(info.index)
    anchored.push({
      index: info.index,
      title: title || 'Chapter',
      summary,
    })
  }

  anchored.sort((left, right) => left.index - right.index)

  const anchoredChapters = anchored.map((start, index) => {
    const nextStart = anchored[index + 1]
    const endIndex = nextStart
      ? getLastCoveredIndexBefore(orderedCoveredIndexes, nextStart.index) ?? start.index
      : orderedCoveredIndexes.at(-1) ?? start.index

    return {
      startSegmentId: segments[start.index].id,
      endSegmentId: segments[endIndex].id,
      startMs: segments[start.index].startMs,
      endMs: segments[endIndex].endMs,
      title: start.title,
      summary: start.summary,
    }
  })

  if (anchoredChapters.length === 0 && unanchored.length === 0 && candidates.length === 0) {
    return buildFallbackChapter({ segments, localChunkResults, orderedCoveredIndexes })
  }

  return [...anchoredChapters, ...unanchored]
}

function buildKeyMoments({ localChunkResults, synthesisResult, coveredIndexes, segmentIndex }) {
  const sourceMoments = getMomentCandidates(localChunkResults, synthesisResult)
  const anchored = []
  const unanchored = []
  const seenSegmentIds = new Set()
  const seenPoints = new Set()

  for (const moment of sourceMoments) {
    const point = String(moment?.point ?? moment?.text ?? '').trim()
    const normalizedPoint = point.replace(/\s+/g, ' ').toLowerCase()
    if (!point || seenPoints.has(normalizedPoint)) continue

    if (isUnanchoredCandidate(moment)) {
      seenPoints.add(normalizedPoint)
      unanchored.push({
        segmentId: null,
        startMs: null,
        point,
      })
      continue
    }

    const info = segmentIndex.get(moment?.segmentId)
    if (!info || !coveredIndexes.has(info.index) || seenSegmentIds.has(info.segment.id)) continue

    seenSegmentIds.add(info.segment.id)
    seenPoints.add(normalizedPoint)
    anchored.push({
      segmentId: info.segment.id,
      startMs: info.segment.startMs,
      point,
    })
  }

  anchored.sort((left, right) => left.startMs - right.startMs)
  return [...anchored, ...unanchored]
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

function hasUnanchoredLocations(chapters, keyMoments) {
  return (
    chapters.some((chapter) => chapter.startSegmentId === null || chapter.endSegmentId === null) ||
    keyMoments.some((moment) => moment.segmentId === null)
  )
}

function buildWarnings({
  status,
  failedRanges,
  synthesisResult,
  localChunkResults,
  hasUnanchoredSummaryLocations,
}) {
  const warnings = []
  if (failedRanges.length > 0) warnings.push('Some transcript ranges could not be summarized.')
  if (!synthesisResult && (Array.isArray(localChunkResults) ? localChunkResults.length : 0) > 0) {
    warnings.push('Summary synthesis was unavailable; local summaries were used instead.')
  }
  if (hasUnanchoredSummaryLocations) warnings.push(UNANCHORED_LOCATION_WARNING)
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
  coveredSegmentIds,
}) {
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : []
  const segmentIndex = buildSegmentIndex(segments)
  const normalizedFailedRanges = normalizeFailedRanges(failedRanges)
  const coveredIndexes = buildCoveredSegmentIndexes(
    localChunkResults,
    segmentIndex,
    coveredSegmentIds,
  )

  removeFailedIndexes(coveredIndexes, normalizedFailedRanges, segmentIndex)

  const coverage = calculateCoverage({ transcription, coveredIndexes })
  const status = synthesisResult
    ? normalizedFailedRanges.length > 0
      ? 'partial'
      : 'complete'
    : 'degraded'
  const keyMoments = buildKeyMoments({
    localChunkResults,
    synthesisResult,
    coveredIndexes,
    segmentIndex,
  })
  const chapters = buildChapters({
    segments,
    localChunkResults,
    synthesisResult,
    coveredIndexes,
    segmentIndex,
  })
  const warnings = buildWarnings({
    status,
    failedRanges: normalizedFailedRanges,
    synthesisResult,
    localChunkResults,
    hasUnanchoredSummaryLocations: hasUnanchoredLocations(chapters, keyMoments),
  })
  const overview = buildOverview(localChunkResults, synthesisResult)

  return {
    status,
    overview,
    rawSummaryText: String(synthesisResult?.rawText || '').trim(),
    keyMoments,
    chapters,
    transcriptSegments: segments.map((segment) => ({ ...segment })),
    coverage,
    warnings,
    failedRanges: normalizedFailedRanges,
  }
}
