import {
  assertBilibiliPlayurlResponse,
  extractBilibiliInitialState,
  getBilibiliVideoIdentity,
  normalizeBilibiliAudioCandidates,
  normalizeSubtitleTracks,
  resolveBilibiliSelectedPageMetadata,
} from './media-source.mjs'

function createPlayurlEndpoint({ bvid, cid }) {
  const endpoint = new URL('https://api.bilibili.com/x/player/playurl')
  endpoint.searchParams.set('bvid', bvid)
  endpoint.searchParams.set('cid', String(cid))
  endpoint.searchParams.set('fnval', '4048')
  endpoint.searchParams.set('fnver', '0')
  endpoint.searchParams.set('fourk', '1')
  return endpoint
}

function createPlayerInfoEndpoint({ bvid, cid }) {
  const endpoint = new URL('https://api.bilibili.com/x/player/wbi/v2')
  endpoint.searchParams.set('bvid', bvid)
  endpoint.searchParams.set('cid', String(cid))
  return endpoint
}

export async function resolveBilibiliSourceSnapshot({
  url,
  html,
  loadPlayurl,
  loadPlayerInfo,
  loadSubtitleBody,
}) {
  const initialState = extractBilibiliInitialState(html)
  const pageMetadata = resolveBilibiliSelectedPageMetadata({ url, initialState })
  const playInfo = await loadPlayurl(pageMetadata)
  assertBilibiliPlayurlResponse({ playInfo, pageMetadata })
  const mediaCandidates = normalizeBilibiliAudioCandidates(playInfo)
  if (mediaCandidates.length === 0) throw new Error('BILIBILI_PLAYURL_AUDIO_NOT_FOUND')
  const playerInfo =
    typeof loadPlayerInfo === 'function' ? await loadPlayerInfo(pageMetadata) : playInfo

  return {
    platform: 'bilibili',
    videoId: pageMetadata.videoId,
    pageId: String(pageMetadata.cid),
    title: String(initialState?.videoData?.title || ''),
    durationMs: pageMetadata.durationMs,
    nativeSubtitleTracks: await normalizeSubtitleTracks(playerInfo, loadSubtitleBody),
    mediaCandidates,
  }
}

function readPageKey(href) {
  const url = new URL(href)
  const pageNumber = Math.max(1, Number.parseInt(url.searchParams.get('p') || '1', 10) || 1)
  return `${url.pathname}?p=${pageNumber}`
}

export function createBilibiliVideoPageBridge({
  fetchImpl = fetch,
  getLocationHref,
  getVideoElement,
}) {
  if (typeof getLocationHref !== 'function') {
    throw new Error('BILIBILI_LOCATION_PROVIDER_REQUIRED')
  }

  const scheduleInterval =
    typeof globalThis?.setInterval === 'function'
      ? globalThis.setInterval.bind(globalThis)
      : (fn, ms) => setInterval(fn, ms)
  const cancelInterval =
    typeof globalThis?.clearInterval === 'function'
      ? globalThis.clearInterval.bind(globalThis)
      : (id) => clearInterval(id)

  const loadHtml = async (href) => {
    const response = await fetchImpl(href, { credentials: 'include' })
    if (!response?.ok) throw new Error('BILIBILI_PAGE_LOAD_FAILED')
    return response.text()
  }

  const loadPlayurl = async ({ bvid, cid }) => {
    const response = await fetchImpl(createPlayurlEndpoint({ bvid, cid }), {
      credentials: 'include',
    })
    if (!response?.ok) throw new Error('BILIBILI_PLAYURL_HTTP_ERROR')
    return response.json()
  }

  const loadPlayerInfo = async ({ bvid, cid }) => {
    const response = await fetchImpl(createPlayerInfoEndpoint({ bvid, cid }), {
      credentials: 'include',
    })
    if (!response?.ok) throw new Error('BILIBILI_PLAYER_INFO_HTTP_ERROR')
    const playerInfo = await response.json()
    if (Number(playerInfo?.code) !== 0) throw new Error('BILIBILI_PLAYER_INFO_API_ERROR')
    return playerInfo
  }

  const loadSubtitleBody = async (subtitleUrl) => {
    const response = await fetchImpl(subtitleUrl, { credentials: 'omit' })
    if (!response?.ok) throw new Error('BILIBILI_SUBTITLE_HTTP_ERROR')
    return response.json()
  }

  const getSnapshot = async () => {
    const href = getLocationHref()
    const html = await loadHtml(href)
    return resolveBilibiliSourceSnapshot({
      url: href,
      html,
      loadPlayurl,
      loadPlayerInfo,
      loadSubtitleBody,
    })
  }

  return {
    getSnapshot,
    async refreshSnapshot({ expectedVideoId }) {
      const currentVideoId = getBilibiliVideoIdentity(getLocationHref()).videoId
      if (expectedVideoId && currentVideoId && expectedVideoId !== currentVideoId) {
        throw new Error('BILIBILI_VIDEO_IDENTITY_CHANGED')
      }
      return getSnapshot()
    },
    seekTo(startMs) {
      const video = getVideoElement?.()
      if (!video) throw new Error('BILIBILI_VIDEO_ELEMENT_NOT_FOUND')
      video.currentTime = Math.max(0, startMs / 1000)
      video.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    getCurrentVideoId() {
      return getBilibiliVideoIdentity(getLocationHref()).videoId
    },
    subscribeToVideoChanges(listener) {
      if (typeof listener !== 'function') return () => {}
      let lastKey = readPageKey(getLocationHref())
      const timer = scheduleInterval(() => {
        const currentKey = readPageKey(getLocationHref())
        if (currentKey === lastKey) return
        lastKey = currentKey
        const { videoId, pageNumber } = getBilibiliVideoIdentity(getLocationHref())
        listener({ videoId, pageNumber })
      }, 250)

      return () => cancelInterval(timer)
    },
  }
}
