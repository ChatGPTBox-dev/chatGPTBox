const DEFAULT_MAX_TITLE_LENGTH = 48

function getFirstMeaningfulLine(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('```'))
}

function removeMarkdownPrefix(value) {
  return value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^`+|`+$/g, '')
    .trim()
}

function getUrlTitle(value) {
  if (!/^https?:\/\/\S+$/i.test(value)) return ''

  try {
    const url = new URL(value)
    const pathnameParts = decodeURIComponent(url.pathname)
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
    return pathnameParts[pathnameParts.length - 1] || url.hostname
  } catch {
    return ''
  }
}

function splitGraphemes(value) {
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), ({ segment }) => segment)
  }
  return Array.from(value)
}

export function truncateSessionTitle(value, maxLength = DEFAULT_MAX_TITLE_LENGTH) {
  const normalizedMaxLength = Number.isFinite(maxLength) ? Math.floor(maxLength) : 0
  if (normalizedMaxLength <= 0) return ''

  const graphemes = splitGraphemes(String(value || ''))
  if (graphemes.length <= normalizedMaxLength) return graphemes.join('')
  if (normalizedMaxLength === 1) return '…'
  return `${graphemes.slice(0, normalizedMaxLength - 1).join('')}…`
}

export function createSessionTitleFromQuestion(question, maxLength = DEFAULT_MAX_TITLE_LENGTH) {
  const firstLine = getFirstMeaningfulLine(question)
  if (!firstLine) return ''

  let title = removeMarkdownPrefix(firstLine).replace(/\s+/g, ' ').trim()
  const urlTitle = getUrlTitle(title)
  if (urlTitle) title = urlTitle

  title = title.replace(/[?？!！。]+$/u, '').trim()
  return truncateSessionTitle(title, maxLength)
}

export function assignAutomaticSessionTitle(session) {
  if (!session || typeof session !== 'object') return session
  if (typeof session.sessionName === 'string' && session.sessionName.trim()) return session

  const firstRecord = Array.isArray(session.conversationRecords)
    ? session.conversationRecords.find(
        (record) => typeof record?.question === 'string' && record.question.trim(),
      )
    : null
  const title = createSessionTitleFromQuestion(firstRecord?.question || session.question)
  if (!title) return session

  session.sessionName = title
  session.sessionNameSource = 'heuristic'
  return session
}

export function formatSessionTimestamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function getSessionDisplayName(session, fallbackLabel = 'New Chat') {
  if (typeof session?.sessionName === 'string' && session.sessionName.trim()) {
    return session.sessionName.trim()
  }

  const label = String(fallbackLabel || '').trim() || 'New Chat'
  const timestamp = formatSessionTimestamp(session?.createdAt)
  return timestamp ? `${label} · ${timestamp}` : label
}
