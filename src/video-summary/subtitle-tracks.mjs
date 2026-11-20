const SOURCE_WEIGHT = Object.freeze({
  author: 0,
  automatic: 1,
  'bilibili-ai': 2,
  unknown: 3,
})

function normalizeLanguage(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function getBaseLanguage(value) {
  return normalizeLanguage(value).split('-')[0]
}

function getSourceWeight(track) {
  return SOURCE_WEIGHT[track?.sourceKind] ?? SOURCE_WEIGHT.unknown
}

export function orderSubtitleTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track?.id && Array.isArray(track.cues) && track.cues.length > 0)
    .map((track, index) => ({ track, index }))
    .sort(
      (left, right) =>
        getSourceWeight(left.track) - getSourceWeight(right.track) || left.index - right.index,
    )
    .map(({ track }) => track)
}

export function selectPreferredSubtitleTrack(tracks, preferredLanguage) {
  const ordered = orderSubtitleTracks(tracks)
  const preferred = normalizeLanguage(preferredLanguage)
  const preferredBase = getBaseLanguage(preferred)

  for (const sourceWeight of Object.values(SOURCE_WEIGHT)) {
    const sourceTracks = ordered.filter((track) => getSourceWeight(track) === sourceWeight)
    if (sourceTracks.length === 0) continue

    const exactMatch = preferred
      ? sourceTracks.find((track) => normalizeLanguage(track.language) === preferred)
      : null
    if (exactMatch) return exactMatch

    const baseMatch = preferredBase
      ? sourceTracks.find((track) => getBaseLanguage(track.language) === preferredBase)
      : null
    if (baseMatch) return baseMatch

    return sourceTracks[0]
  }

  return null
}
