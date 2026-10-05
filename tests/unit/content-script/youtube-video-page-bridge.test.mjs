import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createYouTubeVideoPageBridge,
  resolveYouTubeSourceSnapshot,
} from '../../../src/content-script/site-adapters/youtube/video-page-bridge.mjs'

const fixtureUrl = (name) => new URL(`../../fixtures/youtube/${name}`, import.meta.url)
const loadJson = async (name) => JSON.parse(await readFile(fixtureUrl(name), 'utf8'))
const loadText = (name) => readFile(fixtureUrl(name), 'utf8')
const videoId = 'SYNTHVID001'
const pageUrl = `https://www.youtube.com/watch?v=${videoId}`

function integrityEntries(pot = 'observed-integrity') {
  return [
    {
      name: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&pot=${pot}`,
    },
  ]
}

test('resolves page player data and preserves caption query while reusing observed integrity', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  const captionRequests = []
  const snapshot = await resolveYouTubeSourceSnapshot({
    url: pageUrl,
    playerResponse,
    getPerformanceEntries: () => integrityEntries(),
    loadCaption: async (url) => {
      captionRequests.push(new URL(url))
      return timedText
    },
  })

  assert.equal(snapshot.platform, 'youtube')
  assert.equal(snapshot.videoId, videoId)
  assert.equal(snapshot.pageId, videoId)
  assert.equal(snapshot.title, 'Synthetic {title} with "quotes"')
  assert.equal(snapshot.durationMs, 12000)
  assert.equal(snapshot.nativeSubtitleTracks.length, 2)
  assert.equal(snapshot.nativeSubtitleTracks[0].cues.length, 2)
  assert.equal(snapshot.subtitleDiscovery.status, 'available')
  assert.equal(snapshot.mediaCandidates.length, 1)
  assert.equal(captionRequests[0].searchParams.get('v'), videoId)
  assert.equal(captionRequests[0].searchParams.get('lang'), 'en')
  assert.equal(captionRequests[0].searchParams.get('expire'), '4102444800')
  assert.equal(captionRequests[0].searchParams.get('pot'), 'observed-integrity')
  assert.equal(captionRequests[1].searchParams.get('kind'), 'asr')
  assert.doesNotThrow(() => structuredClone(snapshot))
})

test('copies runtime caption client parameters from the latest matching language request', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  const requested = []
  const snapshot = await resolveYouTubeSourceSnapshot({
    url: pageUrl,
    playerResponse,
    getPerformanceEntries: () => [
      {
        name: `https://www.youtube.com/api/timedtext?v=OTHERID001&lang=en&c=OTHER&cplayer=OTHER`,
      },
      {
        name: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&c=WEB&cver=old&cplayer=UNIPLAYER`,
      },
      {
        name: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=fr&c=WEB&cver=fallback&cplayer=UNIPLAYER&xorb=2`,
      },
      {
        name: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&c=WEB&cver=current&cplayer=UNIPLAYER&xorb=2&xobt=3&xovt=3&signature=observed-signature`,
      },
      {
        name: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3&pot=extension-integrity`,
      },
    ],
    loadCaption: async (url) => {
      requested.push(new URL(url))
      return timedText
    },
  })

  assert.equal(snapshot.subtitleDiscovery.status, 'available')
  assert.equal(requested[0].searchParams.get('c'), 'WEB')
  assert.equal(requested[0].searchParams.get('cver'), 'current')
  assert.equal(requested[0].searchParams.get('cplayer'), 'UNIPLAYER')
  assert.equal(requested[0].searchParams.get('xorb'), '2')
  assert.equal(requested[0].searchParams.get('xobt'), '3')
  assert.equal(requested[0].searchParams.get('xovt'), '3')
  assert.notEqual(requested[0].searchParams.get('signature'), 'observed-signature')
})

test('uses integrity already present on caption URLs without observed entries', async () => {
  const playerResponse = structuredClone(await loadJson('player-response-authored-auto.json'))
  const timedText = await loadJson('timed-text-events.json')
  for (const track of playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) {
    track.baseUrl += '&pot=response-integrity'
  }
  const requested = []
  const snapshot = await resolveYouTubeSourceSnapshot({
    url: pageUrl,
    playerResponse,
    getPerformanceEntries: () => [],
    loadCaption: async (url) => {
      requested.push(new URL(url))
      return timedText
    },
  })

  assert.equal(snapshot.nativeSubtitleTracks.length, 2)
  assert.equal(
    requested.every((url) => url.searchParams.get('pot') === 'response-integrity'),
    true,
  )
})

test('uses the transcript panel once before native, Innertube, or replay', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const calls = []
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getPlayerResponse: () => playerResponse,
    captureCaption: async (request) => {
      calls.push(request)
      return {
        videoId,
        language: 'und',
        label: 'Transcript',
        segments: [{ startMs: 1000, endMs: 2500, text: 'Panel transcript' }],
      }
    },
    fetchImpl: async () => {
      throw new Error('caption URL should not be replayed')
    },
  })

  const snapshot = await bridge.getSnapshot()

  assert.deepEqual(calls, [{ expectedVideoId: videoId, mode: 'panelOnly' }])
  assert.equal(snapshot.nativeSubtitleTracks.length, 1)
  assert.equal(snapshot.nativeSubtitleTracks[0].sourceKind, 'unknown')
  assert.deepEqual(snapshot.nativeSubtitleTracks[0].cues, [
    { startMs: 1000, endMs: 2500, text: 'Panel transcript' },
  ])
})

test('falls back in exact native track, Innertube once, then URL replay order', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  const calls = []
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getPlayerResponse: () => playerResponse,
    captureCaption: async ({ mode, language, sourceKind, vssId }) => {
      calls.push(mode === 'nativeOnly' ? `${mode}:${language}:${sourceKind}:${vssId}` : mode)
      return null
    },
    fetchImpl: async (url) => {
      calls.push(
        `replay:${
          new URL(url).searchParams.get('vssId') ||
          new URL(url).searchParams.get('kind') ||
          'author'
        }`,
      )
      return { ok: true, text: async () => JSON.stringify(timedText) }
    },
  })

  const snapshot = await bridge.getSnapshot()

  assert.deepEqual(calls, [
    'panelOnly',
    'nativeOnly:en:author:.en',
    'nativeOnly:en:automatic:a.en',
    'innertubeOnly',
    'replay:author',
    'replay:asr',
  ])
  assert.equal(snapshot.nativeSubtitleTracks.length, 2)
})

test('uses Innertube once after native failures and before replay', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const modes = []
  let replayCount = 0
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getPlayerResponse: () => playerResponse,
    captureCaption: async ({ mode }) => {
      modes.push(mode)
      if (mode !== 'innertubeOnly') return null
      return {
        videoId,
        segments: [{ startMs: 1000, endMs: 2500, text: 'Innertube transcript' }],
      }
    },
    fetchImpl: async () => {
      replayCount += 1
      throw new Error('caption URL should not be replayed')
    },
  })

  const snapshot = await bridge.getSnapshot()
  assert.deepEqual(modes, ['panelOnly', 'nativeOnly', 'nativeOnly', 'innertubeOnly'])
  assert.equal(replayCount, 0)
  assert.deepEqual(snapshot.nativeSubtitleTracks[0].cues, [
    { startMs: 1000, endMs: 2500, text: 'Innertube transcript' },
  ])
})

test('rejects oversized replay responses instead of accepting caption data', async () => {
  const playerResponse = structuredClone(await loadJson('player-response-authored-auto.json'))
  playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks.splice(1)
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getPlayerResponse: () => playerResponse,
    captureCaption: async () => null,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(6 * 1024 * 1024) },
      json: async () => ({
        events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'oversized' }] }],
      }),
    }),
  })

  const snapshot = await bridge.getSnapshot()
  assert.deepEqual(snapshot.nativeSubtitleTracks, [])
  assert.deepEqual(snapshot.subtitleDiscovery, {
    status: 'unavailable',
    unavailableTrackCount: 1,
    reason: 'caption-load-failed',
  })
})

test('loads player data from the active document before fetching watch HTML', async () => {
  const html = await loadText('watch-authored-and-auto.html')
  const timedText = await loadJson('timed-text-events.json')
  let htmlLoads = 0
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getPlayerResponse: () => null,
    getPageHtml: () => html,
    getPerformanceEntries: () => [],
    fetchImpl: async (url) => {
      if (String(url).includes('/api/timedtext')) {
        return { ok: true, json: async () => timedText }
      }
      htmlLoads += 1
      throw new Error('active document should be used')
    },
  })

  const snapshot = await bridge.getSnapshot()
  assert.equal(htmlLoads, 0)
  assert.equal(snapshot.videoId, videoId)
  assert.equal(snapshot.nativeSubtitleTracks.length, 2)
})

test('loads fetched watch HTML when page player data is absent', async () => {
  const html = await loadText('watch-authored-and-auto.html')
  const timedText = await loadJson('timed-text-events.json')
  let htmlLoads = 0
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getPlayerResponse: () => null,
    getPerformanceEntries: () => integrityEntries(),
    fetchImpl: async (url) => {
      if (String(url).includes('/api/timedtext')) {
        return { ok: true, json: async () => timedText }
      }
      htmlLoads += 1
      return { ok: true, text: async () => html }
    },
  })

  const snapshot = await bridge.getSnapshot()
  assert.equal(htmlLoads, 1)
  assert.equal(snapshot.videoId, videoId)
  assert.equal(snapshot.nativeSubtitleTracks.length, 2)
})

test('rejects mismatched page player data without falling back to fetched HTML', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  let fetchCount = 0
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => `https://www.youtube.com/watch?v=OTHERID0001`,
    getPlayerResponse: () => playerResponse,
    getPerformanceEntries: () => integrityEntries(),
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error('unexpected fetch')
    },
  })

  await assert.rejects(() => bridge.getSnapshot(), {
    message: 'YOUTUBE_PLAYER_RESPONSE_IDENTITY_MISMATCH',
  })
  assert.equal(fetchCount, 0)
})

test('pins snapshot identity before async caption work and rejects an A to B navigation', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  let currentUrl = pageUrl
  const requestedVideoIds = []
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => currentUrl,
    getPlayerResponse: (expectedVideoId) => {
      assert.equal(expectedVideoId, videoId)
      return playerResponse
    },
    captureCaption: async ({ expectedVideoId }) => {
      requestedVideoIds.push(expectedVideoId)
      currentUrl = 'https://www.youtube.com/watch?v=OTHERID0001'
      return { body: JSON.stringify(timedText), videoId: 'OTHERID0001' }
    },
    fetchImpl: async () => {
      throw new Error('stale snapshot must not continue to replay')
    },
  })

  await assert.rejects(() => bridge.getSnapshot(), {
    message: 'VIDEO_SOURCE_IDENTITY_CHANGED',
  })
  assert.deepEqual(requestedVideoIds, [videoId])
})

test('loads signed caption URLs without requiring observed integrity data', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  const requested = []
  const snapshot = await resolveYouTubeSourceSnapshot({
    url: pageUrl,
    playerResponse,
    getPerformanceEntries: () => [],
    loadCaption: async (url) => {
      requested.push(new URL(url))
      return timedText
    },
  })

  assert.equal(snapshot.nativeSubtitleTracks.length, 2)
  assert.equal(snapshot.subtitleDiscovery.status, 'available')
  assert.equal(requested.length, 2)
  assert.equal(
    requested.every((url) => !url.searchParams.has('pot')),
    true,
  )
  assert.equal(snapshot.mediaCandidates.length, 1)
})

test('reports caption load failure when a signed URL without pot is rejected', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  let fetchCount = 0
  const snapshot = await resolveYouTubeSourceSnapshot({
    url: pageUrl,
    playerResponse,
    getPerformanceEntries: () => [],
    loadCaption: async () => {
      fetchCount += 1
      throw new Error('request rejected')
    },
  })

  assert.deepEqual(snapshot.nativeSubtitleTracks, [])
  assert.deepEqual(snapshot.subtitleDiscovery, {
    status: 'unavailable',
    unavailableTrackCount: 2,
    reason: 'caption-load-failed',
  })
  assert.equal(fetchCount, 2)
})

test('refresh validates full identity before loading and supports unbound invocation', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  let currentUrl = pageUrl
  let playerLoads = 0
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => currentUrl,
    getPlayerResponse: () => {
      playerLoads += 1
      return playerResponse
    },
    getPerformanceEntries: () => integrityEntries(),
    fetchImpl: async () => ({ ok: true, json: async () => timedText }),
  })
  const { refreshSnapshot } = bridge

  await assert.rejects(
    () => refreshSnapshot({ expectedPlatform: 'bilibili', expectedVideoId: videoId }),
    { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' },
  )
  currentUrl = 'https://www.youtube.com/watch?v=OTHERID0001'
  await assert.rejects(
    () => refreshSnapshot({ expectedPlatform: 'youtube', expectedVideoId: videoId }),
    { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' },
  )
  assert.equal(playerLoads, 0)
  currentUrl = pageUrl
  const snapshot = await refreshSnapshot({ expectedPlatform: 'youtube', expectedVideoId: videoId })
  assert.equal(snapshot.videoId, videoId)
})

test('seek updates currentTime and scrolls the active video into view', () => {
  const calls = []
  const video = { currentTime: 0, scrollIntoView: (options) => calls.push(options) }
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => pageUrl,
    getVideoElement: () => video,
  })

  bridge.seekTo(1234)
  assert.equal(video.currentTime, 1.234)
  assert.deepEqual(calls, [{ block: 'center', behavior: 'smooth' }])
})

test('navigation emits only normalized watch identity changes and stops after disposal', () => {
  let currentUrl = `${pageUrl}&t=2&list=playlist`
  let tick
  let cleared = null
  const events = []
  const bridge = createYouTubeVideoPageBridge({
    getLocationHref: () => currentUrl,
    setIntervalImpl: (listener) => {
      tick = listener
      return 42
    },
    clearIntervalImpl: (id) => {
      cleared = id
    },
  })
  const dispose = bridge.subscribeToVideoChanges((event) => events.push(event))

  currentUrl = `${pageUrl}&t=99&utm_source=test`
  tick()
  assert.deepEqual(events, [])
  currentUrl = 'https://www.youtube.com/'
  tick()
  assert.deepEqual(events, [{ supported: false, videoId: null }])
  currentUrl = 'https://www.youtube.com/watch?v=OTHERID0001'
  tick()
  assert.deepEqual(events[1], { supported: true, videoId: 'OTHERID0001' })
  dispose()
  assert.equal(cleared, 42)
})

test('bridge never logs sensitive player, caption, or media data', async () => {
  const playerResponse = await loadJson('player-response-authored-auto.json')
  const timedText = await loadJson('timed-text-events.json')
  const originalMethods = {}
  const calls = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originalMethods[method] = console[method]
    console[method] = (...args) => calls.push([method, ...args])
  }
  try {
    await resolveYouTubeSourceSnapshot({
      url: pageUrl,
      playerResponse,
      getPerformanceEntries: () => integrityEntries('secret-pot'),
      loadCaption: async () => timedText,
    })
  } finally {
    for (const [method, value] of Object.entries(originalMethods)) console[method] = value
  }
  assert.deepEqual(calls, [])
})
