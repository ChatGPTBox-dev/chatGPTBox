import { createPageIdentity } from '../../../video-summary/protocol.mjs'

const PLAYER_RESPONSE_MARKER = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/g
const YOUTUBE_ORIGIN = 'https://www.youtube.com/'

export function getYouTubeWatchIdentity(input) {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.pathname !== '/watch') return { supported: false, pageIdentity: null }
  const videoId = url.searchParams.get('v') || ''
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { supported: false, pageIdentity: null }
  return {
    supported: true,
    pageIdentity: createPageIdentity({ platform: 'youtube', videoId, mediaId: videoId }),
  }
}

function extractBalancedObject(source, start, end) {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < end; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }

  throw new Error('YOUTUBE_PLAYER_RESPONSE_INCOMPLETE')
}

export function extractYouTubePlayerResponse(html) {
  const source = String(html)
  PLAYER_RESPONSE_MARKER.lastIndex = 0
  const marker = PLAYER_RESPONSE_MARKER.exec(source)
  if (!marker) throw new Error('YOUTUBE_PLAYER_RESPONSE_NOT_FOUND')

  const scriptEnd = source.indexOf('</script>', marker.index + marker[0].length)
  if (scriptEnd === -1) throw new Error('YOUTUBE_PLAYER_RESPONSE_INCOMPLETE')

  let objectStart = marker.index + marker[0].length
  while (objectStart < scriptEnd && /\s/.test(source[objectStart])) objectStart += 1
  if (source[objectStart] !== '{') throw new Error('YOUTUBE_PLAYER_RESPONSE_MALFORMED')

  const json = extractBalancedObject(source, objectStart, scriptEnd)
  try {
    return JSON.parse(json)
  } catch {
    throw new Error('YOUTUBE_PLAYER_RESPONSE_MALFORMED')
  }
}

export function assertYouTubePlayerResponseIdentity(input, expectedVideoId) {
  const playerResponse = input?.playerResponse ?? input
  const expected = input?.expectedVideoId ?? expectedVideoId
  const actual = playerResponse?.videoDetails?.videoId
  if (typeof actual !== 'string' || !actual) {
    throw new Error('YOUTUBE_PLAYER_RESPONSE_IDENTITY_INVALID')
  }
  if (actual !== expected) throw new Error('YOUTUBE_PLAYER_RESPONSE_IDENTITY_MISMATCH')
}

export function assertYouTubePlayability(playerResponse) {
  const status = playerResponse?.playabilityStatus?.status
  const isLive =
    playerResponse?.videoDetails?.isLiveContent === true ||
    playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow ===
      true ||
    status === 'LIVE_STREAM_OFFLINE'
  if (isLive) throw new Error('YOUTUBE_LIVE_UNSUPPORTED')
  if (status !== 'OK') throw new Error('YOUTUBE_VIDEO_UNPLAYABLE')
}

function readText(value) {
  if (typeof value?.simpleText === 'string') return value.simpleText
  if (!Array.isArray(value?.runs)) return ''
  return value.runs.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('')
}

function asHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function stableIdPart(value, fallback) {
  const normalized = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

export function normalizeYouTubeCaptionTracks(playerResponse) {
  const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer
  const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : []
  const translationLanguages = (
    Array.isArray(renderer?.translationLanguages) ? renderer.translationLanguages : []
  )
    .map((entry) => ({
      language: String(entry?.languageCode || ''),
      label: readText(entry?.languageName),
    }))
    .filter(({ language, label }) => language && label)

  return tracks
    .map((track, index) => {
      const baseUrl = asHttpsUrl(track?.baseUrl)
      if (!baseUrl) return null
      const sourceKind =
        track?.kind === 'asr' || String(track?.vssId || '').startsWith('a.')
          ? 'automatic'
          : 'author'
      const language = String(track?.languageCode || '')
      const discriminator = stableIdPart(track?.vssId, String(index))
      return {
        id: `youtube-caption-${sourceKind}-${stableIdPart(language, 'und')}-${discriminator}`,
        language,
        label: readText(track?.name) || language,
        sourceKind,
        vssId: String(track?.vssId || ''),
        baseUrl: baseUrl.href,
        isTranslatable: track?.isTranslatable === true,
        translationLanguages,
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      const sourceOrder = { author: 0, automatic: 1 }
      return sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind]
    })
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos);/giu, (match, entity) => {
    const lower = entity.toLowerCase()
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (named[lower]) return named[lower]
    const radix = lower.startsWith('#x') ? 16 : 10
    const digits = lower.slice(radix === 16 ? 2 : 1)
    const codePoint = Number.parseInt(digits, radix)
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return match
    }
  })
}

export function parseYouTubeTimedText(payload) {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new Error('YOUTUBE_TIMED_TEXT_MALFORMED')
    }
  }

  const events = Array.isArray(parsed?.events) ? parsed.events : []
  const seen = new Set()
  return events
    .map((event) => {
      const startMs = Number(event?.tStartMs)
      const durationMs = Number(event?.dDurationMs)
      const text = decodeEntities(
        (Array.isArray(event?.segs) ? event.segs : [])
          .map((segment) => (typeof segment?.utf8 === 'string' ? segment.utf8 : ''))
          .join(''),
      )
        .replace(/\s+/g, ' ')
        .trim()
      if (
        !Number.isFinite(startMs) ||
        startMs < 0 ||
        !Number.isFinite(durationMs) ||
        durationMs <= 0 ||
        !text
      ) {
        return null
      }
      return { startMs: Math.round(startMs), endMs: Math.round(startMs + durationMs), text }
    })
    .filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    .filter((cue) => {
      const key = `${cue.startMs}:${cue.endMs}:${cue.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function parsePositiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function parseMimeType(value) {
  const [container = '', ...parameters] = String(value || '').split(';')
  const codec = parameters.join(';').match(/codecs="([^"]+)"/)?.[1] || ''
  return { container: container.trim(), codec }
}

function parseExpiry(url) {
  const seconds = Number.parseInt(url.searchParams.get('expire') || '', 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

export function normalizeYouTubeAudioCandidates(playerResponse) {
  const formats = playerResponse?.streamingData?.adaptiveFormats
  return (Array.isArray(formats) ? formats : [])
    .map((format) => {
      const primaryUrl = asHttpsUrl(format?.url)
      const { container, codec } = parseMimeType(format?.mimeType)
      if (!primaryUrl || !container.startsWith('audio/')) return null
      const expiresAt = parseExpiry(primaryUrl)
      const backupUrls = (Array.isArray(format?.backupUrls) ? format.backupUrls : [])
        .map((url) => asHttpsUrl(url)?.href || null)
        .filter(Boolean)
      return {
        id: String(format?.itag ?? ''),
        mediaMetadata: {
          kind: 'audio',
          container,
          codec,
          contentLength: parsePositiveNumber(format?.contentLength),
          durationMs: parsePositiveNumber(format?.approxDurationMs) || 0,
          bandwidth: parsePositiveNumber(format?.bitrate),
        },
        remoteCandidate: { url: primaryUrl.href, expiresAt },
        localFetchRecipe: {
          primaryUrl: primaryUrl.href,
          backupUrls,
          credentialMode: 'include',
          requiredRequestOrigin: YOUTUBE_ORIGIN,
        },
      }
    })
    .filter(Boolean)
}
