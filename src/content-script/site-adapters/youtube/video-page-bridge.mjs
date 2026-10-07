import { pageIdentitiesEqual } from '../../../video-summary/protocol.mjs'
import {
  assertYouTubePlayability,
  assertYouTubePlayerResponseIdentity,
  extractYouTubePlayerResponse,
  getYouTubeWatchIdentity,
  normalizeYouTubeAudioCandidates,
  normalizeYouTubeCaptionTracks,
  parseYouTubeTimedText,
} from './media-source.mjs'

const OBSERVED_CAPTION_PARAMETERS = [
  'pot',
  'xorb',
  'xobt',
  'xovt',
  'cbrand',
  'cbr',
  'cbrver',
  'c',
  'cver',
  'cplayer',
  'cos',
  'cosver',
  'cplatform',
]

function readWatchIdentity(href) {
  try {
    return getYouTubeWatchIdentity(href)
  } catch {
    return { supported: false, pageIdentity: null }
  }
}

function readObservedCaptionRequests(entries, videoId) {
  const requests = []
  for (const entry of Array.from(entries || [])) {
    try {
      const url = new URL(String(entry?.name || ''))
      if (
        url.pathname === '/api/timedtext' &&
        url.searchParams.get('v') === videoId &&
        OBSERVED_CAPTION_PARAMETERS.some((parameter) => url.searchParams.has(parameter))
      ) {
        requests.push(url)
      }
    } catch {
      continue
    }
  }
  return requests
}

function createCaptionUrl(baseUrl, observedRequests) {
  const url = new URL(baseUrl)
  const language = url.searchParams.get('lang')
  url.searchParams.set('fmt', 'json3')
  for (const parameter of OBSERVED_CAPTION_PARAMETERS) {
    const observedUrl =
      observedRequests.findLast(
        (request) =>
          request.searchParams.get('lang') === language && request.searchParams.has(parameter),
      ) || observedRequests.findLast((request) => request.searchParams.has(parameter))
    const value = observedUrl?.searchParams.get(parameter)
    if (value && !url.searchParams.has(parameter)) url.searchParams.set(parameter, value)
  }
  return url
}

function normalizeDurationMs(playerResponse) {
  const seconds = Number(playerResponse?.videoDetails?.lengthSeconds)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
}

export async function resolveYouTubeSourceSnapshot({
  url,
  html,
  playerResponse,
  loadCaption,
  replayCaption,
  loadPanelTranscript,
  loadInnertubeTranscript,
  getPerformanceEntries = () => [],
  expectedVideoId,
  assertIdentity = () => {},
}) {
  const identity = readWatchIdentity(url)
  if (!identity.supported) throw new Error('YOUTUBE_WATCH_PAGE_UNSUPPORTED')
  const pageIdentity = identity.pageIdentity
  const snapshotVideoId = expectedVideoId || pageIdentity.videoId
  if (pageIdentity.videoId !== snapshotVideoId) throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
  const resolvedPlayerResponse = playerResponse || extractYouTubePlayerResponse(html)
  assertYouTubePlayerResponseIdentity(resolvedPlayerResponse, snapshotVideoId)
  assertIdentity(resolvedPlayerResponse)
  assertYouTubePlayability(resolvedPlayerResponse)

  const captionDescriptors = normalizeYouTubeCaptionTracks(resolvedPlayerResponse)
  const observedCaptionRequests = readObservedCaptionRequests(
    getPerformanceEntries(),
    pageIdentity.videoId,
  )
  const nativeSubtitleTracks = []
  let unavailableTrackCount = 0

  if (typeof loadPanelTranscript === 'function') {
    try {
      const panel = await loadPanelTranscript(snapshotVideoId)
      assertIdentity(resolvedPlayerResponse)
      const cues = parseYouTubeTimedText(panel?.timedText || panel)
      if (cues.length > 0) {
        return {
          pageIdentity,
          title: String(resolvedPlayerResponse?.videoDetails?.title || ''),
          durationMs: normalizeDurationMs(resolvedPlayerResponse),
          nativeSubtitleTracks: [
            {
              id: `youtube-transcript-${snapshotVideoId}`,
              language: panel?.language || 'und',
              label: panel?.label || 'Transcript',
              sourceKind: 'unknown',
              isTranslatable: false,
              translationLanguages: [],
              cues,
            },
          ],
          subtitleDiscovery: { status: 'available' },
          mediaCandidates: normalizeYouTubeAudioCandidates(resolvedPlayerResponse),
        }
      }
    } catch (error) {
      if (error?.message === 'VIDEO_SOURCE_IDENTITY_CHANGED') throw error
    }
  }

  for (const descriptor of captionDescriptors) {
    const captionUrl = createCaptionUrl(descriptor.baseUrl, observedCaptionRequests)
    if (typeof loadCaption !== 'function') {
      unavailableTrackCount += 1
      continue
    }
    try {
      const payload = await loadCaption(captionUrl, descriptor, snapshotVideoId)
      assertIdentity(resolvedPlayerResponse)
      const cues = parseYouTubeTimedText(payload)
      if (cues.length === 0) {
        unavailableTrackCount += 1
        continue
      }
      nativeSubtitleTracks.push({
        id: descriptor.id,
        language: descriptor.language,
        label: descriptor.label,
        sourceKind: descriptor.sourceKind,
        isTranslatable: descriptor.isTranslatable,
        translationLanguages: descriptor.translationLanguages,
        cues,
      })
    } catch (error) {
      if (error?.message === 'VIDEO_SOURCE_IDENTITY_CHANGED') throw error
      unavailableTrackCount += 1
    }
  }

  if (nativeSubtitleTracks.length === 0 && typeof loadInnertubeTranscript === 'function') {
    try {
      const transcript = await loadInnertubeTranscript(snapshotVideoId)
      assertIdentity(resolvedPlayerResponse)
      const cues = parseYouTubeTimedText(transcript?.timedText || transcript)
      if (cues.length > 0) {
        nativeSubtitleTracks.push({
          id: `youtube-transcript-${snapshotVideoId}`,
          language: transcript?.language || 'und',
          label: transcript?.label || 'Transcript',
          sourceKind: 'unknown',
          isTranslatable: false,
          translationLanguages: [],
          cues,
        })
      }
    } catch (error) {
      if (error?.message === 'VIDEO_SOURCE_IDENTITY_CHANGED') throw error
    }
  }

  if (nativeSubtitleTracks.length === 0 && typeof replayCaption === 'function') {
    unavailableTrackCount = 0
    for (const descriptor of captionDescriptors) {
      try {
        const captionUrl = createCaptionUrl(descriptor.baseUrl, observedCaptionRequests)
        const cues = parseYouTubeTimedText(await replayCaption(captionUrl, snapshotVideoId))
        assertIdentity(resolvedPlayerResponse)
        if (cues.length === 0) {
          unavailableTrackCount += 1
          continue
        }
        nativeSubtitleTracks.push({
          id: descriptor.id,
          language: descriptor.language,
          label: descriptor.label,
          sourceKind: descriptor.sourceKind,
          isTranslatable: descriptor.isTranslatable,
          translationLanguages: descriptor.translationLanguages,
          cues,
        })
      } catch (error) {
        if (error?.message === 'VIDEO_SOURCE_IDENTITY_CHANGED') throw error
        unavailableTrackCount += 1
      }
    }
  }

  const subtitleDiscovery =
    nativeSubtitleTracks.length > 0
      ? {
          status: 'available',
          ...(unavailableTrackCount > 0 ? { unavailableTrackCount } : {}),
        }
      : captionDescriptors.length === 0
      ? { status: 'not-found', unavailableTrackCount: 0 }
      : {
          status: 'unavailable',
          unavailableTrackCount,
          reason: 'caption-load-failed',
        }

  assertIdentity(resolvedPlayerResponse)
  return {
    pageIdentity,
    title: String(resolvedPlayerResponse?.videoDetails?.title || ''),
    durationMs: normalizeDurationMs(resolvedPlayerResponse),
    nativeSubtitleTracks,
    subtitleDiscovery,
    mediaCandidates: normalizeYouTubeAudioCandidates(resolvedPlayerResponse),
  }
}

export function createYouTubeVideoPageBridge({
  fetchImpl = fetch,
  getLocationHref,
  getPlayerResponse = () => null,
  getPageHtml = () => '',
  captureCaption,
  getVideoElement,
  getPerformanceEntries = () => globalThis.performance?.getEntriesByType?.('resource') || [],
}) {
  if (typeof getLocationHref !== 'function') throw new Error('YOUTUBE_LOCATION_PROVIDER_REQUIRED')

  const getCurrentPageIdentity = () => readWatchIdentity(getLocationHref()).pageIdentity

  const segmentsToTimedText = (segments) => ({
    events: segments.map((segment) => ({
      tStartMs: segment.startMs,
      dDurationMs: Math.max(1, Number(segment.endMs) - Number(segment.startMs)),
      segs: [{ utf8: String(segment.text || '') }],
    })),
  })

  const loadCaption = async (_url, descriptor, expectedVideoId) => {
    if (typeof captureCaption !== 'function') return null
    const captured = await captureCaption({
      expectedVideoId,
      language: descriptor.language,
      sourceKind: descriptor.sourceKind,
      vssId: descriptor.vssId,
      mode: 'nativeOnly',
    })
    if (
      captured?.videoId === expectedVideoId &&
      getCurrentPageIdentity()?.videoId === expectedVideoId &&
      String(captured.body || '').trim()
    ) {
      return captured.body
    }
    return null
  }

  const replayCaption = async (url, expectedVideoId) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetchImpl(url, {
        credentials: 'include',
        signal: controller.signal,
      })
      if (!response?.ok) throw new Error('YOUTUBE_TIMED_TEXT_HTTP_ERROR')
      const length = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(length) && length > 5 * 1024 * 1024) {
        throw new Error('YOUTUBE_TIMED_TEXT_RESPONSE_TOO_LARGE')
      }
      const payload =
        typeof response.text === 'function'
          ? await response.text()
          : JSON.stringify(await response.json())
      const size = new TextEncoder().encode(payload).byteLength
      if (!payload.trim()) throw new Error('YOUTUBE_TIMED_TEXT_EMPTY')
      if (size > 5 * 1024 * 1024) throw new Error('YOUTUBE_TIMED_TEXT_RESPONSE_TOO_LARGE')
      if (getCurrentPageIdentity()?.videoId !== expectedVideoId) {
        throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
      }
      return JSON.parse(payload)
    } finally {
      clearTimeout(timeout)
    }
  }

  const loadStructuredTranscript = async (expectedVideoId, mode) => {
    if (typeof captureCaption !== 'function') return null
    const captured = await captureCaption({ expectedVideoId, mode })
    if (
      captured?.videoId !== expectedVideoId ||
      getCurrentPageIdentity()?.videoId !== expectedVideoId ||
      !Array.isArray(captured.segments) ||
      captured.segments.length === 0
    ) {
      return null
    }
    return {
      timedText: segmentsToTimedText(captured.segments),
      language: captured.language || 'und',
      label: captured.label || 'Transcript',
    }
  }

  const loadHtml = async (href) => {
    const response = await fetchImpl(href, { credentials: 'include' })
    if (!response?.ok) throw new Error('YOUTUBE_PAGE_LOAD_FAILED')
    return response.text()
  }

  const getSnapshot = async () => {
    const href = getLocationHref()
    const identity = readWatchIdentity(href)
    if (!identity.supported) throw new Error('YOUTUBE_WATCH_PAGE_UNSUPPORTED')
    const expectedPageIdentity = identity.pageIdentity
    const expectedVideoId = expectedPageIdentity.videoId
    const assertIdentity = (playerResponse) => {
      if (!pageIdentitiesEqual(expectedPageIdentity, getCurrentPageIdentity())) {
        throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
      }
      assertYouTubePlayerResponseIdentity(playerResponse, expectedVideoId)
    }
    const pagePlayerResponse = await getPlayerResponse(expectedVideoId)
    if (pagePlayerResponse) assertIdentity(pagePlayerResponse)
    else if (!pageIdentitiesEqual(expectedPageIdentity, getCurrentPageIdentity())) {
      throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    }
    const pageHtml = pagePlayerResponse ? '' : String(await getPageHtml())
    if (
      !pagePlayerResponse &&
      !pageIdentitiesEqual(expectedPageIdentity, getCurrentPageIdentity())
    ) {
      throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    }
    const html = pagePlayerResponse ? undefined : pageHtml || (await loadHtml(href))
    if (!pageIdentitiesEqual(expectedPageIdentity, getCurrentPageIdentity())) {
      throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    }
    return resolveYouTubeSourceSnapshot({
      url: href,
      html,
      playerResponse: pagePlayerResponse,
      loadCaption,
      replayCaption,
      loadPanelTranscript: (videoId) => loadStructuredTranscript(videoId, 'panelOnly'),
      loadInnertubeTranscript: (videoId) => loadStructuredTranscript(videoId, 'innertubeOnly'),
      getPerformanceEntries,
      expectedVideoId,
      assertIdentity,
    })
  }

  return {
    getSnapshot,
    async refreshSnapshot(options) {
      const { expectedPageIdentity, pageGeneration, expectedPlatform, expectedVideoId } = options
      const currentPageIdentity = getCurrentPageIdentity()
      if (expectedPageIdentity) {
        if (!pageIdentitiesEqual(expectedPageIdentity, currentPageIdentity)) {
          throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
        }
      } else if (
        expectedPlatform !== 'youtube' ||
        currentPageIdentity?.videoId !== expectedVideoId
      ) {
        throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
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
      if (!video) throw new Error('YOUTUBE_VIDEO_ELEMENT_NOT_FOUND')
      video.currentTime = Math.max(0, Number(startMs) / 1000 || 0)
      video.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    getCurrentPageIdentity,
  }
}
