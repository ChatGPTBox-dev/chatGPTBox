function getDateTimeParts(value) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

  const parts = new Map(
    formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  )

  return {
    year: parts.get('year'),
    month: parts.get('month'),
    day: parts.get('day'),
    hour: parts.get('hour'),
    minute: parts.get('minute'),
    second: parts.get('second'),
  }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

export function formatShanghaiTimestamp(value) {
  if (!Number.isFinite(value)) return null

  const parts = getDateTimeParts(value)
  if (!parts.year || !parts.month || !parts.day) return null

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Asia/Shanghai`
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
