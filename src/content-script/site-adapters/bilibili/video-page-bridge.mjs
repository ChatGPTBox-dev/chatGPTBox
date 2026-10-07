import { pageIdentitiesEqual } from '../../../video-summary/protocol.mjs'
import {
  assertBilibiliPlayurlResponse,
  extractBilibiliInitialState,
  getBilibiliVideoIdentity,
  normalizeBilibiliAiConclusion,
  normalizeBilibiliAudioCandidates,
  normalizeSubtitleTracks,
  resolveBilibiliSelectedPageMetadata,
} from './media-source.mjs'
import { deriveBilibiliWbiMixinKey, signBilibiliWbiParams } from './wbi-signature.mjs'

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

function createNavEndpoint() {
  return new URL('https://api.bilibili.com/x/web-interface/nav')
}

function createConclusionEndpoint(query) {
  return new URL(`https://api.bilibili.com/x/web-interface/view/conclusion/get?${query}`)
}

export async function resolveBilibiliSourceSnapshot({
  url,
  html,
  loadPlayurl,
  loadPlayerInfo,
  loadSubtitleBody,
  loadAiConclusion,
  assertIdentity = () => {},
}) {
  const initialState = extractBilibiliInitialState(html)
  const pageMetadata = resolveBilibiliSelectedPageMetadata({ url, initialState })
  const { pageIdentity } = pageMetadata
  assertIdentity(pageIdentity)
  const playInfo = await loadPlayurl(pageMetadata)
  assertIdentity(pageIdentity)
  assertBilibiliPlayurlResponse({ playInfo, pageMetadata })
  const mediaCandidates = normalizeBilibiliAudioCandidates(playInfo)
  if (mediaCandidates.length === 0) throw new Error('BILIBILI_PLAYURL_AUDIO_NOT_FOUND')
  const playerInfo =
    typeof loadPlayerInfo === 'function' ? await loadPlayerInfo(pageMetadata) : playInfo
  assertIdentity(pageIdentity)
  const playerSubtitleTracks = await normalizeSubtitleTracks(playerInfo, async (subtitleUrl) => {
    const result = await loadSubtitleBody(subtitleUrl, pageIdentity)
    assertIdentity(pageIdentity)
    return result
  })
  assertIdentity(pageIdentity)
  let conclusionResult = { status: 'not-needed', tracks: [] }
  if (playerSubtitleTracks.length === 0 && typeof loadAiConclusion === 'function') {
    try {
      conclusionResult = await loadAiConclusion(pageMetadata)
      assertIdentity(pageIdentity)
    } catch (error) {
      if (error?.message === 'VIDEO_SOURCE_IDENTITY_CHANGED') throw error
      conclusionResult = { status: 'unavailable', tracks: [] }
    }
  }

  return {
    pageIdentity,
    title: String(initialState?.videoData?.title || ''),
    durationMs: pageMetadata.durationMs,
    nativeSubtitleTracks:
      playerSubtitleTracks.length > 0 ? playerSubtitleTracks : conclusionResult.tracks || [],
    subtitleDiscovery: {
      conclusionStatus: playerSubtitleTracks.length > 0 ? 'not-needed' : conclusionResult.status,
    },
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
  now = () => Date.now(),
}) {
  if (typeof getLocationHref !== 'function') {
    throw new Error('BILIBILI_LOCATION_PROVIDER_REQUIRED')
  }

  let cachedWbiMixinKey = null
  let cachedInitialState = null

  const scheduleInterval =
    typeof globalThis?.setInterval === 'function'
      ? globalThis.setInterval.bind(globalThis)
      : (fn, ms) => setInterval(fn, ms)
  const cancelInterval =
    typeof globalThis?.clearInterval === 'function'
      ? globalThis.clearInterval.bind(globalThis)
      : (id) => clearInterval(id)

  const getCurrentPageIdentity = () => {
    if (!cachedInitialState) return null
    try {
      return resolveBilibiliSelectedPageMetadata({
        url: getLocationHref(),
        initialState: cachedInitialState,
      }).pageIdentity
    } catch {
      return null
    }
  }

  const assertCurrentPageIdentity = (expectedPageIdentity) => {
    if (!pageIdentitiesEqual(expectedPageIdentity, getCurrentPageIdentity())) {
      throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    }
  }

  const loadHtml = async (href) => {
    const expectedPageKey = readPageKey(href)
    const response = await fetchImpl(href, { credentials: 'include' })
    if (readPageKey(getLocationHref()) !== expectedPageKey) {
      throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    }
    if (!response?.ok) throw new Error('BILIBILI_PAGE_LOAD_FAILED')
    const html = await response.text()
    if (readPageKey(getLocationHref()) !== expectedPageKey) {
      throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    }
    cachedInitialState = extractBilibiliInitialState(html)
    return html
  }

  const loadPlayurl = async ({ bvid, cid, pageIdentity }) => {
    const response = await fetchImpl(createPlayurlEndpoint({ bvid, cid }), {
      credentials: 'include',
    })
    assertCurrentPageIdentity(pageIdentity)
    if (!response?.ok) throw new Error('BILIBILI_PLAYURL_HTTP_ERROR')
    const playInfo = await response.json()
    assertCurrentPageIdentity(pageIdentity)
    return playInfo
  }

  const loadPlayerInfo = async ({ bvid, cid, pageIdentity }) => {
    const response = await fetchImpl(createPlayerInfoEndpoint({ bvid, cid }), {
      credentials: 'include',
    })
    assertCurrentPageIdentity(pageIdentity)
    if (!response?.ok) throw new Error('BILIBILI_PLAYER_INFO_HTTP_ERROR')
    const playerInfo = await response.json()
    assertCurrentPageIdentity(pageIdentity)
    if (Number(playerInfo?.code) !== 0) throw new Error('BILIBILI_PLAYER_INFO_API_ERROR')
    return playerInfo
  }

  const loadSubtitleBody = async (subtitleUrl, pageIdentity) => {
    const response = await fetchImpl(subtitleUrl, { credentials: 'omit' })
    assertCurrentPageIdentity(pageIdentity)
    if (!response?.ok) throw new Error('BILIBILI_SUBTITLE_HTTP_ERROR')
    const body = await response.json()
    assertCurrentPageIdentity(pageIdentity)
    return body
  }

  const loadWbiMixinKey = async ({ refresh = false } = {}) => {
    if (cachedWbiMixinKey && !refresh) return cachedWbiMixinKey
    const response = await fetchImpl(createNavEndpoint(), { credentials: 'include' })
    if (!response?.ok) throw new Error('BILIBILI_WBI_NAV_HTTP_ERROR')
    const body = await response.json()
    if (Number(body?.code) !== 0) throw new Error('BILIBILI_WBI_NAV_API_ERROR')
    cachedWbiMixinKey = deriveBilibiliWbiMixinKey(body?.data?.wbi_img)
    return cachedWbiMixinKey
  }

  const loadAiConclusion = async ({ bvid, cid, upMid, pageIdentity }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const mixinKey = await loadWbiMixinKey({ refresh: attempt > 0 })
        assertCurrentPageIdentity(pageIdentity)
        const query = signBilibiliWbiParams({
          params: {
            bvid,
            cid: String(cid),
            ...(upMid ? { up_mid: String(upMid) } : {}),
          },
          mixinKey,
          nowSeconds: Math.floor(now() / 1000),
        })
        const response = await fetchImpl(createConclusionEndpoint(query), {
          credentials: 'include',
        })
        assertCurrentPageIdentity(pageIdentity)
        if (!response?.ok) return { status: 'unavailable', tracks: [] }
        const body = await response.json()
        assertCurrentPageIdentity(pageIdentity)
        if (Number(body?.code) === -101) return { status: 'login-required', tracks: [] }
        if (Number(body?.code) === -403 && attempt === 0) {
          cachedWbiMixinKey = null
          continue
        }
        if (Number(body?.code) !== 0) return { status: 'unavailable', tracks: [] }
        const tracks = normalizeBilibiliAiConclusion(body)
        return { status: tracks.length > 0 ? 'available' : 'not-found', tracks }
      } catch (error) {
        if (error?.message === 'VIDEO_SOURCE_IDENTITY_CHANGED') throw error
        return { status: 'unavailable', tracks: [] }
      }
    }
    return { status: 'unavailable', tracks: [] }
  }

  const resolveCurrentPageIdentity = async () => {
    const href = getLocationHref()
    await loadHtml(href)
    return resolveBilibiliSelectedPageMetadata({
      url: href,
      initialState: cachedInitialState,
    }).pageIdentity
  }

  const getSnapshot = async () => {
    const href = getLocationHref()
    const html = await loadHtml(href)
    const pageMetadata = resolveBilibiliSelectedPageMetadata({
      url: href,
      initialState: cachedInitialState,
    })
    const expectedPageIdentity = pageMetadata.pageIdentity
    assertCurrentPageIdentity(expectedPageIdentity)
    const snapshot = await resolveBilibiliSourceSnapshot({
      url: href,
      html,
      loadPlayurl,
      loadPlayerInfo,
      loadSubtitleBody,
      loadAiConclusion,
      assertIdentity: assertCurrentPageIdentity,
    })
    assertCurrentPageIdentity(expectedPageIdentity)
    return snapshot
  }

  return {
    getSnapshot,
    resolveCurrentPageIdentity,
    async refreshSnapshot(options) {
      const { expectedPageIdentity, pageGeneration, expectedPlatform, expectedVideoId } = options
      const currentPageIdentity = getCurrentPageIdentity()
      if (expectedPageIdentity) {
        if (!pageIdentitiesEqual(expectedPageIdentity, currentPageIdentity)) {
          throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
        }
      } else {
        const currentVideoId = getBilibiliVideoIdentity(getLocationHref()).videoId
        if (expectedPlatform !== 'bilibili' || currentVideoId !== expectedVideoId) {
          throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
        }
      }
      const snapshot = await getSnapshot()
      if (
        expectedPageIdentity
          ? !pageIdentitiesEqual(expectedPageIdentity, snapshot.pageIdentity)
          : snapshot.pageIdentity.videoId !== expectedVideoId
      ) {
        throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
      }
      return pageGeneration === undefined ? snapshot : { ...snapshot, pageGeneration }
    },
    seekTo(startMs) {
      const video = getVideoElement?.()
      if (!video) throw new Error('BILIBILI_VIDEO_ELEMENT_NOT_FOUND')
      video.currentTime = Math.max(0, startMs / 1000)
      video.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    getCurrentPageIdentity,
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
        listener(getCurrentPageIdentity())
      }, 250)

      return () => cancelInterval(timer)
    },
  }
}
