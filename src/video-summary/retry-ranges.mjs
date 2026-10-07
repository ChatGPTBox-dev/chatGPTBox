function intervalFor(range, indexById, startKey, endKey) {
  const start = indexById.get(range?.[startKey])
  const end = indexById.get(range?.[endKey])
  return Number.isInteger(start) && Number.isInteger(end) && start <= end ? [start, end] : null
}

function intersects([leftStart, leftEnd], [rightStart, rightEnd]) {
  return leftStart <= rightEnd && rightStart <= leftEnd
}

function segmentIndex(transcription) {
  return new Map((transcription?.segments || []).map((segment, index) => [segment.id, index]))
}

function selectedIntervals(transcription, selectedChunks) {
  const indexById = segmentIndex(transcription)
  return {
    indexById,
    intervals: (selectedChunks || [])
      .map((chunk) => intervalFor(chunk, indexById, 'primaryStartSegmentId', 'primaryEndSegmentId'))
      .filter(Boolean),
  }
}

export function selectRetryChunks({ transcription, chunks, failedRanges }) {
  const indexById = segmentIndex(transcription)
  const failed = (failedRanges || [])
    .map((range) => intervalFor(range, indexById, 'startSegmentId', 'endSegmentId'))
    .filter(Boolean)
  return (chunks || [])
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => {
      const interval = intervalFor(chunk, indexById, 'primaryStartSegmentId', 'primaryEndSegmentId')
      return interval && failed.some((range) => intersects(interval, range))
    })
}

export function successfulResultsOutsideRetry({
  transcription,
  successfulChunkResults,
  selectedChunks,
}) {
  const { indexById, intervals } = selectedIntervals(transcription, selectedChunks)
  return (successfulChunkResults || []).filter((result) => {
    const interval = intervalFor(result, indexById, 'primaryStartSegmentId', 'primaryEndSegmentId')
    return !interval || !intervals.some((selected) => intersects(interval, selected))
  })
}

export function failedRangesOutsideRetry({ transcription, failedRanges, selectedChunks }) {
  const { indexById, intervals } = selectedIntervals(transcription, selectedChunks)
  return (failedRanges || []).filter((range) => {
    const interval = intervalFor(range, indexById, 'startSegmentId', 'endSegmentId')
    return !interval || !intervals.some((selected) => intersects(interval, selected))
  })
}
