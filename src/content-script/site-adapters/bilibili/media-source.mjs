export function getBilibiliVideoIdentity(input) {
  const url = new URL(input)
  const videoId = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/)?.[1] || ''
  const pageNumber = Math.max(1, Number.parseInt(url.searchParams.get('p') || '1', 10) || 1)
  return { videoId, pageNumber }
}

export function extractBilibiliPlayInfo(html) {
  return extractEmbeddedJsonScript({
    html,
    marker: 'window.__playinfo__=',
    notFoundError: 'BILIBILI_PLAYINFO_NOT_FOUND',
    incompleteError: 'BILIBILI_PLAYINFO_SCRIPT_INCOMPLETE',
  })
}

export function extractBilibiliInitialState(html) {
  return extractEmbeddedJsonScript({
    html,
    marker: 'window.__INITIAL_STATE__=',
    notFoundError: 'BILIBILI_INITIAL_STATE_NOT_FOUND',
    incompleteError: 'BILIBILI_INITIAL_STATE_SCRIPT_INCOMPLETE',
  })
}

function extractEmbeddedJsonScript({ html, marker, notFoundError, incompleteError }) {
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(notFoundError)
  const scriptEnd = html.indexOf('</script>', start)
  if (scriptEnd === -1) throw new Error(incompleteError)
  const json = extractFirstBalancedJsonObject({
    source: html.slice(start + marker.length, scriptEnd),
    incompleteError,
  })
  return JSON.parse(json)
}

function extractFirstBalancedJsonObject({ source, incompleteError }) {
  let objectStart = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; ++index) {
    const char = source[index]

    if (objectStart === -1) {
      if (/\s/.test(char)) continue
      if (char !== '{') {
        throw new SyntaxError('BILIBILI_EMBEDDED_JSON_MALFORMED')
      }
      objectStart = index
      depth = 1
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(objectStart, index + 1)
      }
    }
  }

  throw new Error(incompleteError)
}

function readField(value, camelName, snakeName) {
  return value?.[camelName] ?? value?.[snakeName]
}

function parseExpiry(url) {
  const value = Number.parseInt(new URL(url).searchParams.get('deadline') || '', 10)
  return Number.isFinite(value) ? value * 1000 : null
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function durationToMs(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
}

export function resolveBilibiliSelectedPageMetadata({ url, initialState }) {
  const identity = getBilibiliVideoIdentity(url)
  const videoData = initialState?.videoData
  if (!videoData || typeof videoData !== 'object') {
    throw new Error('BILIBILI_INITIAL_STATE_VIDEO_DATA_INVALID')
  }

  const bvid = String(videoData.bvid || '')
  if (!bvid) throw new Error('BILIBILI_INITIAL_STATE_VIDEO_DATA_INVALID')
  if (identity.videoId && bvid !== identity.videoId) {
    throw new Error('BILIBILI_INITIAL_STATE_IDENTITY_MISMATCH')
  }

  const pages = Array.isArray(videoData.pages) ? videoData.pages : []
  const selectedPage =
    identity.pageNumber > 1
      ? pages.find((page) => parsePositiveInteger(page?.page) === identity.pageNumber) || null
      : pages.find((page) => parsePositiveInteger(page?.page) === 1) || pages[0] || null

  if (identity.pageNumber > 1 && !selectedPage) {
    throw new Error('BILIBILI_INITIAL_STATE_PAGE_NOT_FOUND')
  }

  const cid = parsePositiveInteger(selectedPage?.cid ?? videoData.cid)
  if (!cid) throw new Error('BILIBILI_INITIAL_STATE_VIDEO_DATA_INVALID')

  return {
    videoId: identity.videoId || bvid,
    pageNumber: identity.pageNumber,
    bvid,
    cid,
    durationMs: durationToMs(selectedPage?.duration ?? videoData.duration),
  }
}

export function normalizeBilibiliAudioCandidates(playInfo) {
  const durationMs = Math.round(Number(playInfo?.data?.dash?.duration || 0) * 1000)
  return (playInfo?.data?.dash?.audio || [])
    .map((audio) => {
      const primaryUrl = readField(audio, 'baseUrl', 'base_url')
      const backupUrls = readField(audio, 'backupUrl', 'backup_url') || []
      if (!primaryUrl || new URL(primaryUrl).protocol !== 'https:') return null
      return {
        id: String(audio.id),
        mediaMetadata: {
          kind: 'audio',
          container: readField(audio, 'mimeType', 'mime_type') || '',
          codec: audio.codecs || '',
          contentLength: null,
          durationMs,
          bandwidth: Number(audio.bandwidth) || null,
        },
        remoteCandidate: { url: primaryUrl, expiresAt: parseExpiry(primaryUrl) },
        localFetchRecipe: {
          primaryUrl,
          backupUrls: backupUrls.filter((url) => new URL(url).protocol === 'https:'),
          expiresAt: parseExpiry(primaryUrl),
          credentialMode: 'include',
          rangeSupported: null,
          requiredRequestOrigin: 'https://www.bilibili.com/',
        },
      }
    })
    .filter(Boolean)
}

export function assertBilibiliPlayurlResponse({ playInfo, pageMetadata }) {
  if (Number(playInfo?.code) !== 0) {
    throw new Error('BILIBILI_PLAYURL_API_ERROR')
  }

  const responseBvid = playInfo?.data?.bvid
  const responseCid = playInfo?.data?.cid
  if (
    (responseBvid && String(responseBvid) !== pageMetadata.bvid) ||
    (responseCid && Number(responseCid) !== pageMetadata.cid)
  ) {
    throw new Error('BILIBILI_PLAYURL_IDENTITY_MISMATCH')
  }
}

function normalizeSubtitleUrl(value) {
  const raw = String(value || '')
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('http://')) return `https://${raw.slice('http://'.length)}`
  if (raw.startsWith('https://')) return raw
  return `https://${raw.replace(/^\/+/, '')}`
}

function normalizeSubtitleCues(body) {
  if (!Array.isArray(body)) return []
  return body
    .map((item) => {
      const startMs = durationToMs(item?.from)
      const endMs = durationToMs(item?.to)
      const text = typeof item?.content === 'string' ? item.content : ''
      if (!text) return null
      return { startMs, endMs, text }
    })
    .filter(Boolean)
}

export async function normalizeSubtitleTracks(playInfo, loadSubtitleBody) {
  const subtitles = playInfo?.data?.subtitle?.subtitles
  const tracks = Array.isArray(subtitles) ? subtitles : []

  if (typeof loadSubtitleBody !== 'function') return []

  const resolved = []
  for (const [index, track] of tracks.entries()) {
    const subtitleUrl = normalizeSubtitleUrl(track?.subtitle_url || track?.subtitleUrl)
    if (!subtitleUrl) continue
    const bodyResponse = await loadSubtitleBody(subtitleUrl)
    const cues = normalizeSubtitleCues(bodyResponse?.body)
    if (cues.length === 0) continue
    resolved.push({
      id: String(track?.id ?? index),
      language: String(track?.lan || ''),
      label: String(track?.lan_doc || track?.lan || ''),
      cues,
    })
  }

  return resolved
}
