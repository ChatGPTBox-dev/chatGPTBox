function pad2(value) {
  return String(value).padStart(2, '0')
}

export function formatVideoOffset(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null

  const clampedMs = Math.max(0, milliseconds)
  const totalSeconds = Math.floor(clampedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
  }

  return `${pad2(minutes)}:${pad2(seconds)}`
}
