import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createBilibiliVideoPageBridge,
  resolveBilibiliSourceSnapshot,
} from '../../../src/content-script/site-adapters/bilibili/video-page-bridge.mjs'

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

function createVideoPageHtml({ bvid, cid, duration = 60, upMid = 297242063 }) {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({
    videoData: {
      bvid,
      duration,
      owner: { mid: upMid },
      pages: [{ page: 1, cid, duration }],
    },
  })}</script>`
}

function createAudioOnlyPlayurl({ bvid, cid, duration = 60 }) {
  return {
    code: 0,
    data: {
      bvid,
      cid,
      dash: {
        duration,
        audio: [
          {
            id: 30280,
            baseUrl: 'https://cdn.example.invalid/audio.m4s',
            mimeType: 'audio/mp4',
            codecs: 'mp4a.40.2',
          },
        ],
      },
    },
  }
}

test('source snapshot resolves the selected page through INITIAL_STATE then playurl', async () => {
  const snapshot = await resolveBilibiliSourceSnapshot({
    url: 'https://www.bilibili.com/video/BV1test?p=2',
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify({
      videoData: {
        bvid: 'BV1test',
        duration: 2106,
        owner: { mid: 297242063 },
        pages: [{ page: 2, cid: 2002, duration: 2106 }],
      },
    })}</script>`,
    loadPlayurl: async () => ({
      code: 0,
      data: {
        bvid: 'BV1test',
        cid: 2002,
        dash: {
          duration: 2106,
          audio: [
            {
              id: 30280,
              baseUrl: 'https://cdn.example.invalid/audio.m4s?deadline=1790486400',
              backupUrl: ['https://backup.example.invalid/audio.m4s?deadline=1790486400'],
              mimeType: 'audio/mp4',
              codecs: 'mp4a.40.2',
            },
          ],
        },
        subtitle: {
          subtitles: [
            { id: 1, lan: 'zh', lan_doc: '中文', subtitle_url: '//sub.example.invalid/1' },
          ],
        },
      },
    }),
    loadSubtitleBody: async () => ({
      body: [{ from: 0, to: 1.2, content: 'hello world' }],
    }),
  })

  assert.deepEqual(snapshot.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BV1test',
    mediaId: '2002',
  })
  assert.equal(snapshot.nativeSubtitleTracks.length, 1)
  assert.equal(snapshot.mediaCandidates.length, 1)
  assert.doesNotThrow(() => structuredClone(snapshot))
})

test('source snapshot loads logged-in subtitles from player info instead of playurl', async () => {
  const pageUrl = 'https://www.bilibili.com/video/BV1subtitle?p=1'
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    const href = typeof url === 'string' ? url : url?.toString?.() || ''
    requests.push({ href, credentials: options.credentials })

    if (href === pageUrl) {
      return new Response(
        `<script>window.__INITIAL_STATE__=${JSON.stringify({
          videoData: {
            bvid: 'BV1subtitle',
            duration: 60,
            owner: { mid: 297242063 },
            pages: [{ page: 1, cid: 12345, duration: 60 }],
          },
        })}</script>`,
        { status: 200 },
      )
    }
    if (href.includes('/x/player/playurl')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            bvid: 'BV1subtitle',
            cid: 12345,
            dash: {
              duration: 60,
              audio: [
                {
                  id: 30280,
                  baseUrl: 'https://cdn.example.invalid/audio.m4s',
                  mimeType: 'audio/mp4',
                  codecs: 'mp4a.40.2',
                },
              ],
            },
          },
        }),
        { status: 200 },
      )
    }
    if (href.includes('/x/player/wbi/v2')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                {
                  id: 9,
                  lan: 'zh-CN',
                  lan_doc: '中文（自动生成）',
                  subtitle_url: '//sub.example.invalid/native.json',
                },
              ],
            },
          },
        }),
        { status: 200 },
      )
    }
    if (href === 'https://sub.example.invalid/native.json') {
      return new Response(
        JSON.stringify({ body: [{ from: 1, to: 2.5, content: '真实登录态字幕' }] }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch ${href}`)
  }

  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => pageUrl,
    fetchImpl,
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
  })

  const snapshot = await bridge.getSnapshot()

  assert.equal(snapshot.nativeSubtitleTracks.length, 1)
  assert.equal(snapshot.nativeSubtitleTracks[0].cues[0].text, '真实登录态字幕')
  assert.equal(
    requests.some(
      (request) => request.href.includes('/x/player/wbi/v2') && request.credentials === 'include',
    ),
    true,
  )
  assert.equal(
    requests.some(
      (request) =>
        request.href === 'https://sub.example.invalid/native.json' &&
        request.credentials === 'omit',
    ),
    true,
  )
})

test('bridge signs and loads AI conclusion fallback when player subtitles are empty', async () => {
  const pageUrl = 'https://www.bilibili.com/video/BV1subtitle?p=1'
  let conclusionUrl = null
  let conclusionRequest = null
  const fetchImpl = async (url, options = {}) => {
    const href = typeof url === 'string' ? url : url?.toString?.() || ''
    if (href === pageUrl) {
      return new Response(createVideoPageHtml({ bvid: 'BV1subtitle', cid: 12345 }), {
        status: 200,
      })
    }
    if (href.includes('/x/player/playurl')) {
      return new Response(
        JSON.stringify(createAudioOnlyPlayurl({ bvid: 'BV1subtitle', cid: 12345 })),
        {
          status: 200,
        },
      )
    }
    if (href.includes('/x/player/wbi/v2')) {
      return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), {
        status: 200,
      })
    }
    if (href === 'https://api.bilibili.com/x/web-interface/nav') {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        }),
        { status: 200 },
      )
    }
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view/conclusion/get?')) {
      conclusionUrl = new URL(href)
      conclusionRequest = { credentials: options.credentials }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            model_result: {
              subtitle: [
                {
                  part_subtitle: [{ content: 'AI 字幕', start_timestamp: 0, end_timestamp: 1 }],
                },
              ],
            },
          },
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch ${href}`)
  }

  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => pageUrl,
    fetchImpl,
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
    now: () => 1_700_000_000_000,
  })

  const snapshot = await bridge.getSnapshot()

  assert.equal(conclusionUrl.searchParams.get('bvid'), 'BV1subtitle')
  assert.equal(conclusionUrl.searchParams.get('cid'), '12345')
  assert.equal(conclusionUrl.searchParams.get('up_mid'), '297242063')
  assert.equal(conclusionUrl.searchParams.get('wts'), '1700000000')
  assert.match(conclusionUrl.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
  assert.equal(conclusionRequest.credentials, 'include')
  assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'available')
  assert.equal(snapshot.nativeSubtitleTracks[0].sourceKind, 'bilibili-ai')
})

test('bridge retries one time on conclusion -403 and keeps audio snapshot usable', async () => {
  const pageUrl = 'https://www.bilibili.com/video/BV1retry?p=1'
  let navRequestCount = 0
  let conclusionRequestCount = 0
  let mediaKitRequestCount = 0
  const fetchImpl = async (url) => {
    const href = typeof url === 'string' ? url : url?.toString?.() || ''
    if (href === pageUrl) {
      return new Response(createVideoPageHtml({ bvid: 'BV1retry', cid: 12345 }), { status: 200 })
    }
    if (href.includes('/x/player/playurl')) {
      return new Response(
        JSON.stringify(createAudioOnlyPlayurl({ bvid: 'BV1retry', cid: 12345 })),
        {
          status: 200,
        },
      )
    }
    if (href.includes('/x/player/wbi/v2')) {
      return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), {
        status: 200,
      })
    }
    if (href === 'https://api.bilibili.com/x/web-interface/nav') {
      navRequestCount += 1
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        }),
        { status: 200 },
      )
    }
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view/conclusion/get?')) {
      conclusionRequestCount += 1
      return new Response(JSON.stringify({ code: -403 }), { status: 200 })
    }
    mediaKitRequestCount += 1
    throw new Error(`unexpected fetch ${href}`)
  }

  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => pageUrl,
    fetchImpl,
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
    now: () => 1_700_000_000_000,
  })

  const snapshot = await bridge.getSnapshot()

  assert.equal(navRequestCount, 2)
  assert.equal(conclusionRequestCount, 2)
  assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'unavailable')
  assert.deepEqual(snapshot.nativeSubtitleTracks, [])
  assert.equal(snapshot.mediaCandidates.length, 1)
  assert.equal(mediaKitRequestCount, 0)
})

test('bridge maps AI conclusion login-required without retrying or affecting audio fallback', async () => {
  const pageUrl = 'https://www.bilibili.com/video/BV1login?p=1'
  let conclusionRequestCount = 0
  let mediaKitRequestCount = 0
  const fetchImpl = async (url) => {
    const href = typeof url === 'string' ? url : url?.toString?.() || ''
    if (href === pageUrl) {
      return new Response(createVideoPageHtml({ bvid: 'BV1login', cid: 12345 }), { status: 200 })
    }
    if (href.includes('/x/player/playurl')) {
      return new Response(
        JSON.stringify(createAudioOnlyPlayurl({ bvid: 'BV1login', cid: 12345 })),
        {
          status: 200,
        },
      )
    }
    if (href.includes('/x/player/wbi/v2')) {
      return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), {
        status: 200,
      })
    }
    if (href === 'https://api.bilibili.com/x/web-interface/nav') {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        }),
        { status: 200 },
      )
    }
    if (href.startsWith('https://api.bilibili.com/x/web-interface/view/conclusion/get?')) {
      conclusionRequestCount += 1
      return new Response(JSON.stringify({ code: -101 }), { status: 200 })
    }
    mediaKitRequestCount += 1
    throw new Error(`unexpected fetch ${href}`)
  }

  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => pageUrl,
    fetchImpl,
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
    now: () => 1_700_000_000_000,
  })

  const snapshot = await bridge.getSnapshot()

  assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'login-required')
  assert.equal(conclusionRequestCount, 1)
  assert.equal(mediaKitRequestCount, 0)
  assert.equal(snapshot.mediaCandidates.length, 1)
})

test('multipart navigation changes canonical identity and fences stale extraction', async () => {
  let currentUrl = 'https://www.bilibili.com/video/BV1multi?p=1'
  let releasePlayurl
  const playurlReady = new Promise((resolve) => {
    releasePlayurl = resolve
  })
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
    videoData: {
      bvid: 'BV1multi',
      owner: { mid: 7 },
      pages: [
        { page: 1, cid: 101, duration: 10 },
        { page: 2, cid: 202, duration: 20 },
      ],
    },
  })}</script>`
  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => currentUrl,
    fetchImpl: async (url) => {
      const href = String(url)
      if (href.startsWith('https://www.bilibili.com/video/')) {
        return new Response(html, { status: 200 })
      }
      if (href.includes('/x/player/playurl')) {
        await playurlReady
        return new Response(
          JSON.stringify(createAudioOnlyPlayurl({ bvid: 'BV1multi', cid: 101, duration: 10 })),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch ${href}`)
    },
  })

  const pendingSnapshot = bridge.getSnapshot()
  await nextTask()
  assert.deepEqual(bridge.getCurrentPageIdentity(), {
    platform: 'bilibili',
    videoId: 'BV1multi',
    mediaId: '101',
  })
  currentUrl = 'https://www.bilibili.com/video/BV1multi?p=2'
  assert.deepEqual(bridge.getCurrentPageIdentity(), {
    platform: 'bilibili',
    videoId: 'BV1multi',
    mediaId: '202',
  })
  releasePlayurl()

  await assert.rejects(() => pendingSnapshot, { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' })
})

test('refreshSnapshot rejects a mismatched platform before network access', async () => {
  let fetchCount = 0
  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => 'https://www.bilibili.com/video/BV1same',
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error('should not fetch on mismatch')
    },
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
  })

  await assert.rejects(
    () => bridge.refreshSnapshot({ expectedPlatform: 'youtube', expectedVideoId: 'BV1same' }),
    { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' },
  )
  assert.equal(fetchCount, 0)
})

test('refreshSnapshot rejects a mismatched video identity before network access', async () => {
  let fetchCount = 0
  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => 'https://www.bilibili.com/video/BV1new',
    fetchImpl: async () => {
      fetchCount += 1
      throw new Error('should not fetch on mismatch')
    },
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
  })

  await assert.rejects(
    () => bridge.refreshSnapshot({ expectedPlatform: 'bilibili', expectedVideoId: 'BV1old' }),
    { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' },
  )
  assert.equal(fetchCount, 0)
})

test('refreshSnapshot works when called without a bound this', async () => {
  const pageUrl = 'https://www.bilibili.com/video/BV1unbound?p=1'
  const playInfo = {
    code: 0,
    data: {
      bvid: 'BV1unbound',
      cid: 99001,
      dash: { duration: 10, audio: [{ id: 30280, baseUrl: 'https://cdn.example.invalid/a.m4s' }] },
      subtitle: {
        subtitles: [{ id: 1, lan: 'zh', lan_doc: '中文', subtitle_url: '//sub.example/1' }],
      },
    },
  }
  const fetchImpl = async (url) => {
    const href = typeof url === 'string' ? url : url?.toString?.() || ''
    if (href === pageUrl) {
      return new Response(
        `<script>window.__INITIAL_STATE__=${JSON.stringify({
          videoData: {
            bvid: 'BV1unbound',
            duration: 10,
            owner: { mid: 297242063 },
            pages: [{ page: 1, cid: 99001, duration: 10 }],
          },
        })}</script>`,
        { status: 200 },
      )
    }
    if (href.includes('/x/player/playurl')) {
      return new Response(JSON.stringify(playInfo), { status: 200 })
    }
    if (href.includes('/x/player/wbi/v2')) {
      return new Response(JSON.stringify(playInfo), { status: 200 })
    }
    if (href.startsWith('https://sub.example/')) {
      return new Response(JSON.stringify({ body: [{ from: 0, to: 1, content: 'hi' }] }), {
        status: 200,
      })
    }
    throw new Error(`unexpected fetch ${href}`)
  }

  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => pageUrl,
    fetchImpl,
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
  })

  const { refreshSnapshot } = bridge
  const snapshot = await refreshSnapshot({
    expectedPlatform: 'bilibili',
    expectedVideoId: 'BV1unbound',
  })

  assert.deepEqual(snapshot.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BV1unbound',
    mediaId: '99001',
  })
  assert.equal(snapshot.mediaCandidates.length, 1)
  assert.equal(snapshot.nativeSubtitleTracks.length, 1)
})

test('seekTo updates currentTime in seconds and scrolls into view', () => {
  const calls = []
  const video = {
    currentTime: 0,
    scrollIntoView: (options) => calls.push(options),
  }
  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => 'https://www.bilibili.com/video/BV1seek',
    fetchImpl: async () => {
      throw new Error('unexpected fetch')
    },
    getVideoElement: () => video,
  })

  bridge.seekTo(1234)

  assert.equal(video.currentTime, 1.234)
  assert.deepEqual(calls, [{ block: 'center', behavior: 'smooth' }])
})

test('subscribeToVideoChanges fires when pathname or p changes', async () => {
  let currentUrl = 'https://www.bilibili.com/video/BV1sub?p=1'
  const events = []
  const bridge = createBilibiliVideoPageBridge({
    getLocationHref: () => currentUrl,
    fetchImpl: async () => {
      throw new Error('unexpected fetch')
    },
    getVideoElement: () => ({ currentTime: 0, scrollIntoView: () => {} }),
  })

  const unsubscribe = bridge.subscribeToVideoChanges((payload) => events.push(payload))

  await nextTask()
  currentUrl = 'https://www.bilibili.com/video/BV1sub?p=2'
  await new Promise((resolve) => setTimeout(resolve, 350))
  unsubscribe()

  assert.equal(events.length >= 1, true)
  assert.equal(events[events.length - 1], null)
})
