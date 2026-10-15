import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import * as youtubePageData from '../../../src/background/youtube-page-data.mjs'
import {
  captureYouTubeMainWorldCaption,
  createYouTubePageDataReader,
  readYouTubeInnertubeTranscript,
  readYouTubeMainWorldPlayerResponse,
  readYouTubeTranscriptPanel,
} from '../../../src/background/youtube-page-data.mjs'

const videoId = 'z7do1hhb6fE'

function playerResponse(id, title = id) {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: id, title },
  }
}

test('reads the current matching player response instead of stale bootstrap data', () => {
  const originalInitial = globalThis.ytInitialPlayerResponse
  const originalPlayer = globalThis.ytplayer
  const originalMoviePlayer = globalThis.movie_player
  globalThis.ytInitialPlayerResponse = playerResponse('OLDVIDEO001')
  globalThis.ytplayer = {
    bootstrapPlayerResponse: playerResponse('OLDVIDEO001'),
    config: { args: { raw_player_response: playerResponse(videoId, 'Current') } },
  }
  globalThis.movie_player = {
    getPlayerResponse: () => JSON.stringify(playerResponse(videoId, 'Player API')),
  }

  try {
    assert.deepEqual(
      readYouTubeMainWorldPlayerResponse(videoId),
      playerResponse(videoId, 'Current'),
    )
  } finally {
    globalThis.ytInitialPlayerResponse = originalInitial
    globalThis.ytplayer = originalPlayer
    globalThis.movie_player = originalMoviePlayer
  }
})

test('executes the reader in the sender top frame main world', async () => {
  const current = playerResponse(videoId)
  const calls = []
  const read = createYouTubePageDataReader({
    executeScript: async (details) => {
      calls.push(details)
      return [{ frameId: 0, result: current }]
    },
  })

  const result = await read({
    sender: {
      tab: { id: 42 },
      frameId: 0,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    },
    expectedVideoId: videoId,
  })

  assert.deepEqual(result, current)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].target, { tabId: 42, frameIds: [0] })
  assert.equal(calls[0].world, 'MAIN')
  assert.equal(calls[0].func, readYouTubeMainWorldPlayerResponse)
  assert.deepEqual(calls[0].args, [videoId])
})

test('reports sanitized execution errors for player response and caption scripts', async () => {
  const sensitiveError =
    'ReferenceError: probe https://www.youtube.com/api/timedtext?token=secret body=private'
  const read = createYouTubePageDataReader({
    executeScript: async () => [{ frameId: 0, error: sensitiveError }],
  })
  const sender = {
    tab: { id: 42 },
    frameId: 0,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  }

  for (const [operation, stage] of [
    [() => read({ sender, expectedVideoId: videoId }), 'player-response'],
    [
      () =>
        read.captureCaption({
          sender,
          expectedVideoId: videoId,
          mode: 'nativeOnly',
          language: 'en',
          sourceKind: 'automatic',
          vssId: 'a.en',
        }),
      'caption-native',
    ],
  ]) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.message, 'YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED')
      assert.equal(error.causeCode, 'ReferenceError')
      assert.equal(error.stage, stage)
      assert.equal(JSON.stringify(error).includes('secret'), false)
      assert.equal(String(error.stack).includes('secret'), false)
      return true
    })
  }
})

test('preserves explicit null script results without treating them as execution failures', async () => {
  const read = createYouTubePageDataReader({
    executeScript: async () => [{ frameId: 0, result: null }],
  })
  const sender = {
    tab: { id: 42 },
    frameId: 0,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  }

  assert.equal(await read({ sender, expectedVideoId: videoId }), null)
  assert.equal(
    await read.captureCaption({ sender, expectedVideoId: videoId, mode: 'panelOnly' }),
    null,
  )
})

test('creates successful and sanitized failed page-data response envelopes', async () => {
  assert.equal(typeof youtubePageData.createYouTubePageDataResponse, 'function')
  assert.deepEqual(
    await youtubePageData.createYouTubePageDataResponse(async () => ({ value: 1 })),
    { ok: true, data: { value: 1 } },
  )

  const error = new Error('YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED')
  error.causeCode = 'TypeError'
  error.stage = 'caption-panel'
  error.cause = new Error('token=secret body=private')
  const response = await youtubePageData.createYouTubePageDataResponse(async () => {
    throw error
  })

  assert.deepEqual(response, {
    ok: false,
    errorCode: 'YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED',
    causeCode: 'TypeError',
    stage: 'caption-panel',
  })
  assert.equal(JSON.stringify(response).includes('secret'), false)
})

test('captures a native timedtext response and restores the disabled CC state', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  let ccEnabled = false
  let selectedTrack = null
  const ccButton = {
    click() {
      ccEnabled = !ccEnabled
      if (ccEnabled) {
        void globalThis.fetch(
          `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3&pot=secret`,
        )
      }
    },
    getAttribute(name) {
      return name === 'aria-pressed' && ccEnabled ? 'true' : 'false'
    },
  }
  const fakeFetch = async () => ({
    clone: () => ({ text: async () => '{"events":[{"tStartMs":0}]}' }),
  })
  globalThis.fetch = fakeFetch
  globalThis.XMLHttpRequest = class {
    open() {}
  }
  globalThis.document = { querySelector: () => ccButton }
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.movie_player = {
    getPlayerResponse: () => playerResponse(videoId),
    loadModule() {},
    getOption: (_module, option) => (option === 'track' ? null : [{ languageCode: 'en' }]),
    setOption: (_module, _name, track) => {
      selectedTrack = track
    },
  }

  try {
    const result = await captureYouTubeMainWorldCaption(
      videoId,
      { language: 'en', sourceKind: 'author', vssId: '.en' },
      100,
    )
    assert.equal(result.videoId, videoId)
    assert.equal(result.language, 'en')
    assert.equal(result.body, '{"events":[{"tStartMs":0}]}')
    assert.equal(selectedTrack, null)
    assert.equal(ccEnabled, false)
    assert.equal(globalThis.fetch, fakeFetch)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXhr
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('captures XHR timedtext, ignores empty bodies, and restores the original track', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  const originalTrack = { languageCode: 'fr', vssId: '.fr', kind: '' }
  const selected = []
  let ccEnabled = true

  class FakeXhr {
    static instances = []

    constructor() {
      this.listeners = new Map()
      this.responseType = ''
      this.responseText = ''
      FakeXhr.instances.push(this)
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener)
    }

    open() {}

    complete(body) {
      this.responseText = body
      this.listeners.get('load')?.()
    }
  }

  const ccButton = {
    click() {
      ccEnabled = !ccEnabled
    },
    getAttribute: () => (ccEnabled ? 'true' : 'false'),
  }
  globalThis.fetch = async () => ({ clone: () => ({ text: async () => '   ' }) })
  globalThis.XMLHttpRequest = FakeXhr
  globalThis.document = { querySelector: () => ccButton }
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.movie_player = {
    getPlayerResponse: () => playerResponse(videoId),
    loadModule() {},
    getOption: (_module, option) =>
      option === 'track'
        ? originalTrack
        : [
            originalTrack,
            { languageCode: 'en', vssId: '.en', kind: '' },
            { languageCode: 'en', vssId: 'a.en', kind: 'asr' },
          ],
    setOption: (_module, _name, track) => {
      selected.push(track)
      if (track?.vssId === 'a.en') {
        ccEnabled = false
        const empty = new FakeXhr()
        empty.open('GET', `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr`)
        empty.complete('')
        const full = new FakeXhr()
        full.open('GET', `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr`)
        full.complete('{"events":[{"tStartMs":1}]}')
      }
    },
  }

  try {
    const result = await captureYouTubeMainWorldCaption(
      videoId,
      { language: 'en', sourceKind: 'automatic', vssId: 'a.en' },
      100,
    )
    assert.equal(result.body, '{"events":[{"tStartMs":1}]}')
    assert.deepEqual(selected, [{ languageCode: 'en', vssId: 'a.en', kind: 'asr' }, originalTrack])
    assert.equal(ccEnabled, true)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXhr
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('waits for tracklist and avoids clicking CC when track selection already enabled it', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  let tracksReady = false
  let ccEnabled = false
  let clickCount = 0
  const selected = []
  globalThis.fetch = async () => ({
    clone: () => ({ text: async () => '{"events":[{"tStartMs":0}]}' }),
  })
  globalThis.XMLHttpRequest = class {
    open() {}
  }
  globalThis.document = {
    querySelector: () => ({
      click() {
        clickCount += 1
        ccEnabled = !ccEnabled
      },
      getAttribute: () => (ccEnabled ? 'true' : 'false'),
    }),
  }
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.movie_player = {
    getPlayerResponse: () => playerResponse(videoId),
    loadModule() {
      setTimeout(() => {
        tracksReady = true
      }, 5)
    },
    getOption: (_module, option) =>
      option === 'track' ? null : tracksReady ? [{ languageCode: 'en', vssId: '.en' }] : [],
    setOption: (_module, _name, track) => {
      selected.push(track)
      if (track) {
        ccEnabled = true
        void globalThis.fetch(`/api/timedtext?v=${videoId}&lang=en`)
      }
    },
  }

  try {
    const result = await captureYouTubeMainWorldCaption(
      videoId,
      { language: 'en', sourceKind: 'author', vssId: '.en' },
      100,
    )
    assert.equal(result.videoId, videoId)
    assert.deepEqual(selected, [{ languageCode: 'en', vssId: '.en' }, null])
    assert.equal(clickCount, 1)
    assert.equal(ccEnabled, false)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXhr
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('times out when caption responses are empty and restores disabled CC', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  let ccEnabled = false
  const ccButton = {
    click() {
      ccEnabled = !ccEnabled
      if (ccEnabled) {
        void globalThis.fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`)
      }
    },
    getAttribute: () => (ccEnabled ? 'true' : 'false'),
  }
  globalThis.fetch = async () => ({ clone: () => ({ text: async () => '' }) })
  globalThis.XMLHttpRequest = class {
    open() {}
  }
  globalThis.document = { querySelector: () => ccButton }
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.movie_player = {
    getPlayerResponse: () => playerResponse(videoId),
    loadModule() {},
    getOption: (_module, option) => (option === 'track' ? null : [{ languageCode: 'en' }]),
    setOption() {},
  }

  try {
    await assert.rejects(
      () =>
        captureYouTubeMainWorldCaption(
          videoId,
          { language: 'en', sourceKind: 'author', vssId: '.en' },
          5,
        ),
      { message: 'YOUTUBE_TIMED_TEXT_CAPTURE_TIMEOUT' },
    )
    assert.equal(ccEnabled, false)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXhr
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('ignores oversized caption bodies and rejects stale SPA results', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  let currentId = videoId
  let href = `https://www.youtube.com/watch?v=${videoId}`
  const ccButton = {
    click() {
      if (currentId === videoId) {
        href = 'https://www.youtube.com/watch?v=OTHERID001'
        currentId = 'OTHERID001'
        void globalThis.fetch(
          `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
        )
      }
    },
    getAttribute: () => 'false',
  }
  globalThis.fetch = async () => ({
    headers: { get: () => String(6 * 1024 * 1024) },
    clone: () => ({ text: async () => '{"events":[{"tStartMs":0}]}' }),
  })
  globalThis.XMLHttpRequest = class {
    open() {}
  }
  globalThis.document = { querySelector: () => ccButton }
  globalThis.location = {
    get href() {
      return href
    },
  }
  globalThis.movie_player = {
    getPlayerResponse: () => playerResponse(currentId),
    loadModule() {},
    getOption: (_module, option) => (option === 'track' ? null : [{ languageCode: 'en' }]),
    setOption() {},
  }

  try {
    await assert.rejects(
      () =>
        captureYouTubeMainWorldCaption(
          videoId,
          { language: 'en', sourceKind: 'author', vssId: '.en' },
          5,
          5 * 1024 * 1024,
        ),
      { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' },
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXhr
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('reads structured transcript segments from same-page Innertube continuation', async () => {
  const originalYtcfg = globalThis.ytcfg
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.ytcfg = {
    get: (key) =>
      ({
        INNERTUBE_API_KEY: 'redacted-key',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
      }[key]),
  }
  globalThis.fetch = async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        actions: [
          {
            updateEngagementPanelAction: {
              content: {
                transcriptRenderer: {
                  content: {
                    transcriptSearchPanelRenderer: {
                      body: {
                        transcriptSegmentListRenderer: {
                          initialSegments: [
                            {
                              transcriptSegmentRenderer: {
                                startMs: '1000',
                                endMs: '2500',
                                snippet: { runs: [{ text: 'Hello' }, { text: ' world' }] },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      }),
  })

  try {
    const result = await readYouTubeInnertubeTranscript(videoId, 'continuation', 100, 1024)
    assert.deepEqual(result, {
      videoId,
      language: 'und',
      label: 'Transcript',
      segments: [{ startMs: 1000, endMs: 2500, text: 'Hello world' }],
    })
  } finally {
    globalThis.ytcfg = originalYtcfg
    globalThis.fetch = originalFetch
    globalThis.location = originalLocation
  }
})

test('opens the native transcript panel, reads segments, and closes only extension-opened UI', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  let opened = false
  let closed = false
  const segment = {
    querySelector(selector) {
      if (selector.includes('timestamp')) return { textContent: '1:02' }
      if (selector.includes('segment-text')) return { textContent: 'Panel text' }
      return null
    },
  }
  const panel = {
    getAttribute: (name) => (name === 'visibility' ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' : null),
    hasAttribute: () => false,
    querySelectorAll: () => [segment],
    querySelector: (selector) =>
      selector.includes('button') ? { click: () => (closed = true) } : null,
  }
  const opener = { click: () => (opened = true) }
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector.includes('ytd-engagement-panel-section-list-renderer')) {
        return opened ? [panel] : []
      }
      if (selector.includes('button')) return [opener]
      return []
    },
  }

  try {
    const result = await readYouTubeTranscriptPanel(videoId, 100)
    assert.deepEqual(result, {
      videoId,
      language: 'und',
      label: 'Transcript',
      segments: [{ startMs: 62000, endMs: 63000, text: 'Panel text' }],
    })
    assert.equal(closed, true)
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
  }
})

test('expands the description and opens English, simplified, and traditional transcript controls', async () => {
  for (const label of ['Show transcript', '显示转录稿', '顯示轉錄稿']) {
    const originalDocument = globalThis.document
    const originalLocation = globalThis.location
    const originalMutationObserver = globalThis.MutationObserver
    globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
    let expanded = false
    let opened = false
    let ready = false
    let closed = false
    let observer
    let disconnected = false
    const segment = {
      querySelector(selector) {
        if (selector.includes('timestamp')) return { textContent: '0:01' }
        if (selector.includes('segment-text')) return { textContent: 'Delayed text' }
        return null
      },
    }
    const panel = {
      getAttribute: () =>
        opened ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' : 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN',
      hasAttribute: () => false,
      querySelectorAll: () => (opened && ready ? [segment, segment] : []),
      querySelector: (selector) =>
        selector === '#visibility-button button' ? { click: () => (closed = true) } : null,
    }
    const expandButton = {
      offsetParent: {},
      disabled: false,
      click: () => (expanded = true),
    }
    const opener = {
      offsetParent: {},
      disabled: false,
      textContent: label,
      getAttribute: () => '',
      click() {
        assert.equal(expanded, true)
        opened = true
        setTimeout(() => {
          ready = true
          observer?.()
        }, 0)
      },
    }
    globalThis.MutationObserver = class {
      constructor(callback) {
        observer = callback
      }
      observe() {}
      disconnect() {
        disconnected = true
      }
    }
    globalThis.document = {
      body: {},
      querySelector(selector) {
        if (selector.includes('engagement-panel-searchable-transcript')) return panel
        if (selector.includes('#expand')) return expandButton
        return null
      },
      querySelectorAll: (selector) => {
        if (selector.includes('ytd-engagement-panel-section-list-renderer')) return [panel]
        if (selector.includes('#expand')) return [expandButton]
        return selector === 'button' ? [opener] : []
      },
    }

    try {
      const result = await readYouTubeTranscriptPanel(videoId, 100)
      assert.deepEqual(result.segments, [{ startMs: 1000, endMs: 2000, text: 'Delayed text' }])
      assert.equal(closed, true)
      assert.equal(disconnected, true)
    } finally {
      globalThis.document = originalDocument
      globalThis.location = originalLocation
      globalThis.MutationObserver = originalMutationObserver
    }
  }
})

test('waits for a delayed transcript opener, clicks it once, and parses the modern panel', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMutationObserver = globalThis.MutationObserver
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  let descriptionExpanded = false
  let openerAvailable = false
  let panelVisible = false
  let openerClicks = 0
  let observer
  let disconnected = false
  const timestamp = { textContent: '0:07', parentElement: null }
  const text = { textContent: 'Delayed modern transcript', parentElement: null }
  const segment = {
    querySelector(selector) {
      if (selector === '.ytwTranscriptSegmentViewModelTimestamp') return timestamp
      if (selector === 'span.ytAttributedStringHost[role="text"]') return text
      return null
    },
    querySelectorAll: () => [timestamp, text],
  }
  const panel = {
    getAttribute: (name) =>
      name === 'visibility' && panelVisible ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' : null,
    hasAttribute: () => false,
    querySelectorAll: () => (panelVisible ? [segment] : []),
    querySelector: () => null,
  }
  const expandButton = {
    disabled: false,
    getAttribute: () => null,
    click() {
      descriptionExpanded = true
      setTimeout(() => {
        openerAvailable = true
        observer?.()
      }, 0)
    },
  }
  const opener = {
    disabled: false,
    textContent: 'Show transcript',
    getAttribute: () => null,
    click() {
      openerClicks += 1
      panelVisible = true
      observer?.()
    },
  }
  globalThis.MutationObserver = class {
    constructor(callback) {
      observer = callback
    }
    observe() {}
    disconnect() {
      disconnected = true
    }
  }
  globalThis.document = {
    body: {},
    querySelectorAll(selector) {
      if (selector.includes('ytd-engagement-panel-section-list-renderer')) return [panel]
      if (selector.includes('#expand')) return [expandButton]
      if (selector === 'button') return openerAvailable ? [opener] : []
      return []
    },
  }

  try {
    const result = await readYouTubeTranscriptPanel(videoId, 100)
    assert.equal(descriptionExpanded, true)
    assert.equal(openerClicks, 1)
    assert.equal(disconnected, true)
    assert.deepEqual(result.segments, [
      { startMs: 7000, endMs: 8000, text: 'Delayed modern transcript' },
    ])
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.MutationObserver = originalMutationObserver
  }
})

test('rejects delayed panel segments after YouTube SPA identity changes', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMutationObserver = globalThis.MutationObserver
  let href = `https://www.youtube.com/watch?v=${videoId}`
  let observer
  let disconnected = false
  const panel = {
    getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
    hasAttribute: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  globalThis.location = {
    get href() {
      return href
    },
  }
  globalThis.MutationObserver = class {
    constructor(callback) {
      observer = callback
    }
    observe() {}
    disconnect() {
      disconnected = true
    }
  }
  globalThis.document = {
    body: {},
    querySelectorAll: (selector) =>
      selector.includes('ytd-engagement-panel-section-list-renderer') ? [panel] : [],
  }

  try {
    const result = readYouTubeTranscriptPanel(videoId, 100)
    href = 'https://www.youtube.com/watch?v=OTHERID001'
    observer()
    await assert.rejects(result, { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' })
    assert.equal(disconnected, true)
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.MutationObserver = originalMutationObserver
  }
})

test('derives panel cue ends and returns panel-owned language metadata', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  const makeSegment = (timestamp, text) => ({
    querySelector(selector) {
      if (selector.includes('timestamp')) return { textContent: timestamp }
      if (selector.includes('segment-text')) return { textContent: text }
      return null
    },
  })
  const panel = {
    getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
    hasAttribute: () => false,
    querySelectorAll: () => [makeSegment('0:01', 'First'), makeSegment('0:04', 'Second')],
    querySelector: (selector) =>
      selector.includes('language')
        ? {
            textContent: 'English (United States)',
            getAttribute: (name) => (name === 'lang' ? 'en-US' : null),
          }
        : null,
  }
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector.includes('ytd-engagement-panel-section-list-renderer') ? [panel] : [],
  }
  globalThis.movie_player = { getDuration: () => 10 }

  try {
    const result = await readYouTubeTranscriptPanel(videoId, 100)
    assert.deepEqual(result, {
      videoId,
      language: 'en-US',
      label: 'English (United States)',
      segments: [
        { startMs: 1000, endMs: 4000, text: 'First' },
        { startMs: 4000, endMs: 10000, text: 'Second' },
      ],
    })
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('rejects transcript panels exceeding segment or UTF-8 byte limits', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  const segment = (text) => ({
    querySelector(selector) {
      if (selector.includes('timestamp')) return { textContent: '0:01' }
      if (selector.includes('segment-text')) return { textContent: text }
      return null
    },
  })
  const panel = {
    getAttribute: () => 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
    hasAttribute: () => false,
    querySelectorAll: () => [segment('one'), segment('two')],
    querySelector: () => null,
  }
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector.includes('ytd-engagement-panel-section-list-renderer') ? [panel] : [],
  }

  try {
    await assert.rejects(() => readYouTubeTranscriptPanel(videoId, 100, 1024, 1), {
      message: 'YOUTUBE_TRANSCRIPT_PANEL_TOO_LARGE',
    })
    panel.querySelectorAll = () => [segment('你好')]
    await assert.rejects(() => readYouTubeTranscriptPanel(videoId, 100, 5, 10), {
      message: 'YOUTUBE_TRANSCRIPT_PANEL_TOO_LARGE',
    })
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
  }
})

test('uses a visible Chinese transcript button when the first matching control is hidden', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  let visible = false
  const segment = {
    querySelector(selector) {
      if (selector.includes('timestamp')) return { textContent: '0:02' }
      if (selector.includes('segment-text')) return { textContent: 'Visible control' }
      return null
    },
  }
  const panel = {
    getAttribute: (name) =>
      name === 'visibility'
        ? visible
          ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
          : 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'
        : null,
    hasAttribute: () => false,
    querySelectorAll: () => (visible ? [segment] : []),
    querySelector: () => null,
  }
  const hiddenButton = {
    offsetParent: null,
    disabled: false,
    hasAttribute: (name) => name === 'hidden',
    getAttribute: (name) => (name === 'aria-label' ? '内容转文字' : null),
  }
  const visibleButton = {
    offsetParent: {},
    disabled: false,
    getAttribute: (name) => (name === 'aria-label' ? '内容转文字' : null),
    click: () => (visible = true),
  }
  globalThis.document = {
    querySelector(selector) {
      if (selector.includes('engagement-panel-searchable-transcript')) return panel
      if (selector === 'ytd-video-description-transcript-section-renderer button') {
        return hiddenButton
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector.includes('ytd-engagement-panel-section-list-renderer')) return [panel]
      if (selector === 'ytd-video-description-transcript-section-renderer button') {
        return [hiddenButton, visibleButton]
      }
      if (selector === 'button') return [hiddenButton, visibleButton]
      return []
    },
  }

  try {
    const result = await readYouTubeTranscriptPanel(videoId, 100)
    assert.deepEqual(result.segments, [{ startMs: 2000, endMs: 3000, text: 'Visible control' }])
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
  }
})

test('opens and parses the expanded modern transcript panel through the second zero-size control', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  let modernVisible = false
  let firstClicks = 0
  let secondClicks = 0
  let legacyReads = 0
  const timestamp = { textContent: '1:23', parentElement: null }
  const a11yLabel = { textContent: '1 minute, 23 seconds', parentElement: null }
  const text = { textContent: 'Modern transcript text', parentElement: null }
  const segment = {
    querySelector(selector) {
      if (selector === '.ytwTranscriptSegmentViewModelTimestamp') return timestamp
      if (selector === 'span.ytAttributedStringHost[role="text"]') return text
      return null
    },
    querySelectorAll: () => [timestamp, a11yLabel, text],
  }
  const legacyPanel = {
    getAttribute: (name) => (name === 'visibility' ? 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN' : null),
    hasAttribute: (name) => name === 'hidden',
    querySelectorAll() {
      legacyReads += 1
      return []
    },
    querySelector: () => null,
  }
  const modernPanel = {
    getAttribute: (name) =>
      name === 'visibility'
        ? modernVisible
          ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
          : 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'
        : null,
    hasAttribute: () => false,
    querySelectorAll: () => (modernVisible ? [segment] : []),
    querySelector: () => null,
  }
  const firstButton = {
    offsetParent: null,
    offsetWidth: 0,
    offsetHeight: 0,
    disabled: false,
    hasAttribute: () => false,
    getAttribute: (name) => (name === 'aria-label' ? '内容转文字' : null),
    click: () => {
      firstClicks += 1
    },
  }
  const secondButton = {
    offsetParent: null,
    offsetWidth: 0,
    offsetHeight: 0,
    disabled: false,
    hasAttribute: () => false,
    getAttribute: (name) => (name === 'aria-label' ? '内容转文字' : null),
    click: () => {
      secondClicks += 1
      modernVisible = true
    },
  }
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.includes('ytd-engagement-panel-section-list-renderer')) {
        return [legacyPanel, modernPanel]
      }
      if (selector === 'button[aria-label*="内容转文字"]') {
        return [firstButton, secondButton]
      }
      if (selector === 'button') return [firstButton, secondButton]
      return []
    },
  }

  try {
    const result = await readYouTubeTranscriptPanel(videoId, 100)
    assert.deepEqual(result.segments, [
      { startMs: 83000, endMs: 84000, text: 'Modern transcript text' },
    ])
    assert.equal(firstClicks, 0)
    assert.equal(secondClicks, 1)
    assert.equal(legacyReads, 0)
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
  }
})

test('opens an existing hidden transcript panel, waits for segments, and closes it', async () => {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  let visible = false
  let closed = false
  let reads = 0
  const segment = {
    querySelector(selector) {
      if (selector.includes('timestamp')) return { textContent: '0:03' }
      if (selector.includes('segment-text')) return { textContent: 'Loaded text' }
      return null
    },
  }
  const panel = {
    getAttribute: (name) =>
      name === 'visibility'
        ? visible
          ? 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'
          : 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'
        : null,
    querySelectorAll() {
      reads += 1
      return visible && reads > 1 ? [segment] : []
    },
    querySelector: (selector) =>
      selector === '#visibility-button button' ? { click: () => (closed = true) } : null,
  }
  const opener = { click: () => (visible = true) }
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector.includes('ytd-engagement-panel-section-list-renderer')) return [panel]
      if (selector === 'ytd-video-description-transcript-section-renderer button') return [opener]
      return []
    },
  }

  try {
    const result = await readYouTubeTranscriptPanel(videoId, 100)
    assert.deepEqual(result.segments, [{ startMs: 3000, endMs: 4000, text: 'Loaded text' }])
    assert.equal(closed, true)
  } finally {
    globalThis.document = originalDocument
    globalThis.location = originalLocation
  }
})

test('executes native caption capture only for the authorized sender video', async () => {
  const calls = []
  const read = createYouTubePageDataReader({
    executeScript: async (details) => {
      calls.push(details)
      return [{ frameId: 0, result: { body: '{"events":[]}' } }]
    },
  })

  const result = await read.captureCaption({
    sender: {
      tab: { id: 42 },
      frameId: 0,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    },
    expectedVideoId: videoId,
    mode: 'nativeOnly',
    language: 'en',
    sourceKind: 'automatic',
    vssId: 'a.en',
  })

  assert.deepEqual(result, { body: '{"events":[]}' })
  assert.equal(calls[0].func, captureYouTubeMainWorldCaption)
  assert.deepEqual(calls[0].args, [
    videoId,
    { language: 'en', sourceKind: 'automatic', vssId: 'a.en' },
    5000,
    5 * 1024 * 1024,
  ])
})

test('executes only the explicitly requested panel, native, or Innertube command', async () => {
  const calls = []
  const read = createYouTubePageDataReader({
    executeScript: async (details) => {
      calls.push({ func: details.func, args: details.args })
      return [{ frameId: 0, result: null }]
    },
  })
  const sender = {
    tab: { id: 42 },
    frameId: 0,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  }

  await read.captureCaption({ sender, expectedVideoId: videoId, mode: 'panelOnly' })
  await read.captureCaption({
    sender,
    expectedVideoId: videoId,
    mode: 'nativeOnly',
    language: 'en',
    sourceKind: 'author',
    vssId: '.en',
  })
  await read.captureCaption({ sender, expectedVideoId: videoId, mode: 'innertubeOnly' })

  assert.deepEqual(
    calls.map(({ func }) => func),
    [readYouTubeTranscriptPanel, captureYouTubeMainWorldCaption, readYouTubeInnertubeTranscript],
  )
  assert.deepEqual(calls[0].args, [videoId, 15000, 5 * 1024 * 1024, 10000])
  assert.equal(calls.length, 3)
})

test('extracts continuation only from a nested get_transcript endpoint in the transcript panel', async () => {
  const originalInitialData = globalThis.ytInitialData
  const originalYtcfg = globalThis.ytcfg
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let requestBody
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.ytInitialData = {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          targetId: 'engagement-panel-searchable-transcript',
          content: {
            transcriptRenderer: {
              footer: {
                continuationItemRenderer: {
                  continuationEndpoint: {
                    commandMetadata: {
                      webCommandMetadata: { apiUrl: '/youtubei/v1/get_transcript' },
                    },
                    continuationCommand: { token: 'transcript-token' },
                  },
                },
              },
            },
          },
        },
      },
    ],
  }
  globalThis.ytcfg = {
    get: (key) =>
      ({
        INNERTUBE_API_KEY: 'redacted-key',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } },
      }[key]),
  }
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          transcriptSegmentRenderer: {
            startMs: '0',
            endMs: '1000',
            snippet: { runs: [{ text: 'Transcript' }] },
          },
        }),
    }
  }

  try {
    const result = await readYouTubeInnertubeTranscript(videoId, '', 100)
    assert.equal(requestBody.continuation, 'transcript-token')
    assert.equal(result.segments[0].text, 'Transcript')
  } finally {
    globalThis.ytInitialData = originalInitialData
    globalThis.ytcfg = originalYtcfg
    globalThis.fetch = originalFetch
    globalThis.location = originalLocation
  }
})

test('prefers getTranscriptEndpoint params from the searchable transcript panel', async () => {
  const originalInitialData = globalThis.ytInitialData
  const originalYtcfg = globalThis.ytcfg
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let requestBody
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.ytInitialData = {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          targetId: 'engagement-panel-searchable-transcript',
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [],
                    },
                  },
                  footer: {
                    transcriptFooterRenderer: {
                      languageMenu: {
                        sortFilterSubMenuRenderer: {
                          subMenuItems: [
                            {
                              title: 'English',
                              continuation: {
                                reloadContinuationData: {
                                  continuation: 'fallback-token',
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
              footer: {
                button: {
                  buttonRenderer: {
                    command: {
                      commandMetadata: {
                        webCommandMetadata: { apiUrl: '/youtubei/v1/get_transcript' },
                      },
                      getTranscriptEndpoint: { params: 'transcript-params' },
                      continuationCommand: { token: 'lower-priority-token' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  }
  globalThis.ytcfg = {
    get: (key) =>
      ({
        INNERTUBE_API_KEY: 'redacted-key',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } },
      }[key]),
  }
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          transcriptSegmentRenderer: {
            startMs: '0',
            endMs: '1000',
            snippet: { runs: [{ text: 'Transcript' }] },
          },
        }),
    }
  }

  try {
    await readYouTubeInnertubeTranscript(videoId, 'supplied-token', 100)
    assert.deepEqual(requestBody, {
      context: { client: { clientName: 'WEB' } },
      params: 'transcript-params',
    })
  } finally {
    globalThis.ytInitialData = originalInitialData
    globalThis.ytcfg = originalYtcfg
    globalThis.fetch = originalFetch
    globalThis.location = originalLocation
  }
})

test('does not use unrelated continuation tokens outside the transcript engagement panel endpoint', async () => {
  const originalInitialData = globalThis.ytInitialData
  const originalYtcfg = globalThis.ytcfg
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  let fetchCount = 0
  globalThis.location = { href: `https://www.youtube.com/watch?v=${videoId}` }
  globalThis.ytInitialData = {
    unrelatedRenderer: {
      continuationEndpoint: {
        commandMetadata: { webCommandMetadata: { apiUrl: '/youtubei/v1/browse' } },
        continuationCommand: { token: 'unrelated-secret-token' },
      },
    },
  }
  globalThis.ytcfg = {
    get: (key) =>
      ({
        INNERTUBE_API_KEY: 'redacted-key',
        INNERTUBE_CONTEXT: { client: { clientName: 'WEB' } },
      }[key]),
  }
  globalThis.fetch = async () => {
    fetchCount += 1
    throw new Error('must not fetch')
  }

  try {
    await assert.rejects(() => readYouTubeInnertubeTranscript(videoId, '', 100), {
      message: 'YOUTUBE_TRANSCRIPT_CONTINUATION_MISSING',
    })
    assert.equal(fetchCount, 0)
  } finally {
    globalThis.ytInitialData = originalInitialData
    globalThis.ytcfg = originalYtcfg
    globalThis.fetch = originalFetch
    globalThis.location = originalLocation
  }
})

test('restores an empty original caption track and ignores a response arriving after timeout', async () => {
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const originalMoviePlayer = globalThis.movie_player
  let resolveBody
  let hrefReads = 0
  const selected = []
  let ccEnabled = false
  globalThis.fetch = async () => ({
    headers: { get: () => null },
    clone: () => ({ text: () => new Promise((resolve) => (resolveBody = resolve)) }),
  })
  globalThis.XMLHttpRequest = class {
    open() {}
  }
  globalThis.document = {
    querySelector: () => ({
      click() {
        ccEnabled = !ccEnabled
        if (ccEnabled) void globalThis.fetch(`/api/timedtext?v=${videoId}&lang=en`)
      },
      getAttribute: () => (ccEnabled ? 'true' : 'false'),
    }),
  }
  globalThis.location = {
    get href() {
      hrefReads += 1
      return `https://www.youtube.com/watch?v=${videoId}`
    },
  }
  globalThis.movie_player = {
    getPlayerResponse: () => playerResponse(videoId),
    loadModule() {},
    getOption: (_module, option) => (option === 'track' ? null : [{ languageCode: 'en' }]),
    setOption: (_module, _name, track) => selected.push(track),
  }

  try {
    await assert.rejects(
      () =>
        captureYouTubeMainWorldCaption(
          videoId,
          { language: 'en', sourceKind: 'author', vssId: '.en' },
          5,
        ),
      { message: 'YOUTUBE_TIMED_TEXT_CAPTURE_TIMEOUT' },
    )
    const readsAtTimeout = hrefReads
    resolveBody('{"events":[{"tStartMs":0}]}')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(selected, [{ languageCode: 'en' }, null])
    assert.equal(ccEnabled, false)
    assert.equal(hrefReads, readsAtTimeout)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXhr
    globalThis.document = originalDocument
    globalThis.location = originalLocation
    globalThis.movie_player = originalMoviePlayer
  }
})

test('validates caption descriptor fields before executing page code', async () => {
  let executions = 0
  const read = createYouTubePageDataReader({
    executeScript: async () => {
      executions += 1
      return []
    },
  })
  const sender = {
    tab: { id: 42 },
    documentId: 'document-a',
    frameId: 0,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  }

  for (const descriptor of [
    { language: 'x'.repeat(65), sourceKind: 'author', vssId: '.en' },
    { language: 'en<script>', sourceKind: 'author', vssId: '.en' },
    { language: 'en', sourceKind: 'other', vssId: '.en' },
    { language: 'en', sourceKind: 'author', vssId: 'x'.repeat(257) },
    { language: 'en', sourceKind: 'author', vssId: 'bad token' },
  ]) {
    await assert.rejects(
      () => read.captureCaption({ sender, expectedVideoId: videoId, ...descriptor }),
      { message: 'YOUTUBE_CAPTION_DESCRIPTOR_INVALID' },
    )
  }
  assert.equal(executions, 0)
})

test('serializes page captures for the same tab document and video', async () => {
  const pending = []
  let executions = 0
  const read = createYouTubePageDataReader({
    executeScript: (details) => {
      executions += 1
      return new Promise((resolve) => pending.push({ details, resolve }))
    },
  })
  const request = {
    sender: {
      tab: { id: 42 },
      documentId: 'document-a',
      frameId: 0,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    },
    expectedVideoId: videoId,
    language: 'en',
    sourceKind: 'author',
    vssId: '.en',
  }

  const first = read.captureCaption(request)
  const second = read.captureCaption({ ...request, vssId: '.en-GB' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(executions, 1)
  pending[0].resolve([{ result: { videoId, body: 'first' } }])
  await first
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(executions, 2)
  pending[1].resolve([{ result: { videoId, body: 'second' } }])
  await second
})

test('executeScript functions remain self-contained after serialization', async () => {
  for (const func of [
    readYouTubeMainWorldPlayerResponse,
    captureYouTubeMainWorldCaption,
    readYouTubeInnertubeTranscript,
    readYouTubeTranscriptPanel,
  ]) {
    const context = {
      URL,
      AbortController,
      TextEncoder,
      setTimeout,
      clearTimeout,
      location: { href: `https://www.youtube.com/watch?v=${videoId}` },
      document: { querySelector: () => null },
    }
    context.globalThis = context
    const restored = vm.runInNewContext(`(${func.toString()})`, context)
    assert.equal(typeof restored, 'function')
    try {
      await restored(videoId, {}, 0, 1)
    } catch (error) {
      assert.notEqual(error?.name, 'ReferenceError', `${func.name}: ${error?.message}`)
    }
  }
})

test('rejects non-YouTube, subframe, and mismatched requests', async () => {
  let executions = 0
  const read = createYouTubePageDataReader({
    executeScript: async () => {
      executions += 1
      return []
    },
  })

  for (const sender of [
    { tab: { id: 42 }, frameId: 1, url: `https://www.youtube.com/watch?v=${videoId}` },
    { tab: { id: 42 }, frameId: 0, url: `https://example.com/watch?v=${videoId}` },
    { tab: { id: 42 }, frameId: 0, url: 'https://www.youtube.com/watch?v=OTHERID001' },
  ]) {
    await assert.rejects(() => read({ sender, expectedVideoId: videoId }), {
      message: 'YOUTUBE_PAGE_DATA_UNAUTHORIZED',
    })
  }
  assert.equal(executions, 0)
})
