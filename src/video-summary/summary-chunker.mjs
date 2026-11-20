const OVERLAP_SEGMENT_COUNT = 2
const MIN_PRIMARY_SEGMENTS = 5

function estimateSegmentTokens(segment) {
  return Math.max(1, Math.ceil(String(segment?.text || '').length / 4))
}

function estimateRangeTokens(segments, startIndex, endIndex) {
  let total = 0
  for (let index = startIndex; index < endIndex; index += 1) {
    total += estimateSegmentTokens(segments[index])
  }
  return total
}

function buildPrimaryRanges(segments, startIndex, endIndex, inputTokenBudget, ranges) {
  const length = endIndex - startIndex
  const estimatedTokens = estimateRangeTokens(segments, startIndex, endIndex)

  if (length <= 0) return

  if (estimatedTokens <= inputTokenBudget || length <= MIN_PRIMARY_SEGMENTS) {
    ranges.push({ startIndex, endIndex })
    return
  }

  const midpoint = startIndex + Math.ceil(length / 2)
  buildPrimaryRanges(segments, startIndex, midpoint, inputTokenBudget, ranges)
  buildPrimaryRanges(segments, midpoint, endIndex, inputTokenBudget, ranges)
}

export function chunkTranscriptForSummary({ transcription, inputTokenBudget }) {
  const segments = Array.isArray(transcription?.segments) ? transcription.segments : []
  if (segments.length === 0) return []

  const primaryRanges = []
  buildPrimaryRanges(
    segments,
    0,
    segments.length,
    Math.max(1, inputTokenBudget || 1),
    primaryRanges,
  )

  return primaryRanges.map(({ startIndex, endIndex }) => ({
    primarySegmentIds: segments.slice(startIndex, endIndex).map((segment) => segment.id),
    contextBeforeSegmentIds: segments
      .slice(Math.max(0, startIndex - OVERLAP_SEGMENT_COUNT), startIndex)
      .map((segment) => segment.id),
    contextAfterSegmentIds: segments
      .slice(endIndex, Math.min(segments.length, endIndex + OVERLAP_SEGMENT_COUNT))
      .map((segment) => segment.id),
    primaryStartSegmentId: segments[startIndex]?.id ?? null,
    primaryEndSegmentId: segments[endIndex - 1]?.id ?? null,
  }))
}
