import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractBilibiliInitialState,
  getBilibiliVideoIdentity,
  normalizeBilibiliAiConclusion,
  normalizeBilibiliAudioCandidates,
  normalizeSubtitleTracks,
  resolveBilibiliSelectedPageMetadata,
} from '../../../src/content-script/site-adapters/bilibili/media-source.mjs'
import { resolveBilibiliSourceSnapshot } from '../../../src/content-script/site-adapters/bilibili/video-page-bridge.mjs'

const videoUrl = 'https://video.example.invalid/video/BVTESTCASE01'
const multipartVideoUrl = 'https://video.example.invalid/video/BVTESTCASE01?p=2'
const primaryUrl =
  'https://audio-primary.example.invalid/audio.m4s?deadline=1700000000&fixture=primary'
const backupUrl =
  'https://audio-backup.example.invalid/audio.m4s?deadline=1700000000&fixture=backup'
const playInfo = {
  data: {
    dash: {
      duration: 600,
      audio: [
        {
          id: 30280,
          baseUrl: primaryUrl,
          backupUrl: [backupUrl],
          mimeType: 'audio/mp4',
          codecs: 'mp4a.40.2',
          bandwidth: 128000,
        },
      ],
    },
  },
}
const initialState = {
  videoData: {
    bvid: 'BVTESTCASE01',
    cid: 111001,
    duration: 600,
    owner: { mid: 297242063 },
    pages: [
      { page: 1, cid: 111001, duration: 600, part: 'P1' },
      { page: 2, cid: 222002, duration: 321, part: 'P2' },
    ],
  },
}

test('parses BV identity and page number', () => {
  assert.deepEqual(getBilibiliVideoIdentity(`${videoUrl}?p=3`), {
    videoId: 'BVTESTCASE01',
    pageNumber: 3,
  })
})

test('extracts __INITIAL_STATE__ JSON without executing page script', () => {
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(initialState)}</script>`
  assert.deepEqual(extractBilibiliInitialState(html), initialState)
})

test('extracts __INITIAL_STATE__ when the first complete object is followed by a trailing IIFE', () => {
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(
    initialState,
  )};(function(){window.later=true})()</script>`
  assert.deepEqual(extractBilibiliInitialState(html), initialState)
})

test('extracts __INITIAL_STATE__ with braces and escaped quotes inside JSON strings', () => {
  const nestedStringState = {
    videoData: {
      bvid: 'BVTESTCASE01',
      cid: 111001,
      duration: 600,
      title: 'literal { brace } and "quotes" and \\\\ slash',
      pages: [{ page: 1, cid: 111001, duration: 600, part: 'P1 {json-like} "quoted"' }],
    },
  }
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(
    nestedStringState,
  )};(function(){return "{not-json}"})()</script>`
  assert.deepEqual(extractBilibiliInitialState(html), nestedStringState)
})

test('extracts __INITIAL_STATE__ with whitespace and semicolon variants after the object', () => {
  const html = `<script>window.__INITIAL_STATE__=\n  ${JSON.stringify(
    initialState,
  )} \n ; \n</script>`
  assert.deepEqual(extractBilibiliInitialState(html), initialState)
})

test('normalizes audio candidates and never materializes cookie headers', () => {
  const [candidate] = normalizeBilibiliAudioCandidates(playInfo)
  assert.equal(candidate.id, '30280')
  assert.equal(candidate.mediaMetadata.kind, 'audio')
  assert.equal(candidate.mediaMetadata.container, 'audio/mp4')
  assert.equal(candidate.localFetchRecipe.primaryUrl, primaryUrl)
  assert.deepEqual(candidate.localFetchRecipe.backupUrls, [backupUrl])
  assert.equal(candidate.localFetchRecipe.credentialMode, 'include')
  assert.equal(candidate.localFetchRecipe.requiredRequestOrigin, 'https://www.bilibili.com/')
  assert.equal('headers' in candidate.localFetchRecipe, false)
})

test('throws BILIBILI_INITIAL_STATE_NOT_FOUND when script marker is missing', () => {
  assert.throws(
    () => extractBilibiliInitialState('<html><body>no initial state here</body></html>'),
    {
      message: 'BILIBILI_INITIAL_STATE_NOT_FOUND',
    },
  )
})

test('throws BILIBILI_INITIAL_STATE_SCRIPT_INCOMPLETE when marker exists but closing script tag is absent', () => {
  assert.throws(
    () => extractBilibiliInitialState('<script>window.__INITIAL_STATE__={"key":"value"}</div>'),
    { message: 'BILIBILI_INITIAL_STATE_SCRIPT_INCOMPLETE' },
  )
})

test('throws BILIBILI_INITIAL_STATE_SCRIPT_INCOMPLETE when the initial-state object is incomplete before script end', () => {
  assert.throws(
    () =>
      extractBilibiliInitialState('<script>window.__INITIAL_STATE__={"key":{"nested":1}</script>'),
    { message: 'BILIBILI_INITIAL_STATE_SCRIPT_INCOMPLETE' },
  )
})

test('filters out non-HTTPS audio candidates', () => {
  const mixedPlayInfo = {
    data: {
      dash: {
        duration: 100,
        audio: [
          {
            id: 1,
            baseUrl: 'http://insecure.example/audio.m4s',
            backupUrl: [],
            mimeType: 'audio/mp4',
            codecs: 'mp4a.40.2',
            bandwidth: 64000,
          },
          {
            id: 2,
            baseUrl: 'https://secure.example/audio.m4s',
            backupUrl: [],
            mimeType: 'audio/mp4',
            codecs: 'mp4a.40.2',
            bandwidth: 128000,
          },
        ],
      },
    },
  }
  const candidates = normalizeBilibiliAudioCandidates(mixedPlayInfo)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].id, '2')
})

test('returns empty array when DASH audio is absent', () => {
  const noAudioPlayInfo = { data: { dash: { duration: 0, audio: [] } } }
  const candidates = normalizeBilibiliAudioCandidates(noAudioPlayInfo)
  assert.deepEqual(candidates, [])
})

test('returns empty array when dash property is missing', () => {
  const candidates = normalizeBilibiliAudioCandidates({ data: {} })
  assert.deepEqual(candidates, [])
})

test('returns empty array when audio property is missing', () => {
  const candidates = normalizeBilibiliAudioCandidates({ data: { dash: { duration: 100 } } })
  assert.deepEqual(candidates, [])
})

test('handles snake_case response fields', () => {
  const snakeCasePlayInfo = {
    data: {
      dash: {
        duration: 300,
        audio: [
          {
            id: 30281,
            base_url: primaryUrl,
            backup_url: [backupUrl],
            mime_type: 'audio/mp4',
            codecs: 'mp4a.40.2',
            bandwidth: 256000,
          },
        ],
      },
    },
  }
  const [candidate] = normalizeBilibiliAudioCandidates(snakeCasePlayInfo)
  assert.equal(candidate.id, '30281')
  assert.equal(candidate.mediaMetadata.container, 'audio/mp4')
  assert.equal(candidate.localFetchRecipe.primaryUrl, primaryUrl)
})

test('Bilibili P1 and P2 share BVID but have distinct canonical media identity', () => {
  const p1 = resolveBilibiliSelectedPageMetadata({ url: videoUrl, initialState })
  const p2 = resolveBilibiliSelectedPageMetadata({ url: multipartVideoUrl, initialState })

  assert.deepEqual(p1.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BVTESTCASE01',
    mediaId: '111001',
  })
  assert.deepEqual(p2.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BVTESTCASE01',
    mediaId: '222002',
  })
  assert.notDeepEqual(p1.pageIdentity, p2.pageIdentity)
})

test('resolveBilibiliSelectedPageMetadata uses the selected multipart page cid and duration', () => {
  assert.deepEqual(
    resolveBilibiliSelectedPageMetadata({
      url: multipartVideoUrl,
      initialState,
    }),
    {
      pageIdentity: {
        platform: 'bilibili',
        videoId: 'BVTESTCASE01',
        mediaId: '222002',
      },
      videoId: 'BVTESTCASE01',
      pageNumber: 2,
      bvid: 'BVTESTCASE01',
      cid: 222002,
      upMid: 297242063,
      durationMs: 321000,
    },
  )
})

test('resolveBilibiliSelectedPageMetadata returns uploader mid when available', () => {
  assert.deepEqual(
    resolveBilibiliSelectedPageMetadata({
      url: videoUrl,
      initialState,
    }),
    {
      pageIdentity: {
        platform: 'bilibili',
        videoId: 'BVTESTCASE01',
        mediaId: '111001',
      },
      videoId: 'BVTESTCASE01',
      pageNumber: 1,
      bvid: 'BVTESTCASE01',
      cid: 111001,
      upMid: 297242063,
      durationMs: 600000,
    },
  )
})

test('resolveBilibiliSelectedPageMetadata rejects missing or invalid initial-state video data', () => {
  assert.throws(
    () =>
      resolveBilibiliSelectedPageMetadata({
        url: videoUrl,
        initialState: {},
      }),
    { message: 'BILIBILI_INITIAL_STATE_VIDEO_DATA_INVALID' },
  )
})

test('resolveBilibiliSelectedPageMetadata rejects initial-state identity mismatches', () => {
  assert.throws(
    () =>
      resolveBilibiliSelectedPageMetadata({
        url: videoUrl,
        initialState: { videoData: { ...initialState.videoData, bvid: 'BVMISMATCH99' } },
      }),
    { message: 'BILIBILI_INITIAL_STATE_IDENTITY_MISMATCH' },
  )
})

test('normalizes and orders player subtitle tracks by source kind', async () => {
  const playInfoWithTracks = {
    data: {
      subtitle: {
        subtitles: [
          { id: 3, lan: 'ja', lan_doc: '日本語', subtitle_url: '//sub/unknown' },
          {
            id: 2,
            lan: 'zh-CN',
            lan_doc: '中文（自动生成）',
            ai_type: 1,
            subtitle_url: '//sub/ai',
          },
          { id: 1, lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//sub/author' },
        ],
      },
    },
  }
  const tracks = await normalizeSubtitleTracks(playInfoWithTracks, async (url) => {
    return { body: [{ from: 0, to: 1.5, content: `cue:${url}` }] }
  })

  assert.deepEqual(
    tracks.map(({ id, sourceKind }) => ({ id, sourceKind })),
    [
      { id: '1', sourceKind: 'author' },
      { id: '2', sourceKind: 'bilibili-ai' },
      { id: '3', sourceKind: 'unknown' },
    ],
  )
})

test('skips a failing player subtitle body while retaining usable tracks', async () => {
  const tracks = await normalizeSubtitleTracks(
    {
      data: {
        subtitle: {
          subtitles: [
            { id: 1, lan: 'en', ai_type: 0, subtitle_url: '//sub/fails' },
            { id: 2, lan: 'zh-CN', ai_type: 1, subtitle_url: '//sub/works' },
          ],
        },
      },
    },
    async (url) => {
      if (url.endsWith('/fails')) throw new Error('fixture failure')
      return { body: [{ from: 0, to: 1, content: 'usable' }] }
    },
  )

  assert.deepEqual(
    tracks.map((track) => track.id),
    ['2'],
  )
})

test('normalizes conclusion AI subtitle groups and removes invalid duplicate cues', () => {
  const tracks = normalizeBilibiliAiConclusion({
    code: 0,
    data: {
      model_result: {
        subtitle: [
          {
            part_subtitle: [
              { content: 'second', start_timestamp: 2, end_timestamp: 3.25 },
              { content: 'first', start_timestamp: 0, end_timestamp: 1 },
              { content: 'first', start_timestamp: 0, end_timestamp: 1 },
              { content: ' ', start_timestamp: 4, end_timestamp: 5 },
              { content: 'invalid', start_timestamp: 8, end_timestamp: 7 },
            ],
          },
        ],
      },
    },
  })

  assert.deepEqual(tracks, [
    {
      id: 'bilibili-ai-conclusion',
      language: 'zh-CN',
      label: 'Bilibili AI subtitles',
      sourceKind: 'bilibili-ai',
      cues: [
        { startMs: 0, endMs: 1000, text: 'first' },
        { startMs: 2000, endMs: 3250, text: 'second' },
      ],
    },
  ])
})

test('returns no conclusion track when no usable AI subtitle cue exists', () => {
  assert.deepEqual(normalizeBilibiliAiConclusion({ code: 0, data: { model_result: {} } }), [])
})

test('source snapshot skips AI conclusion when a player subtitle is usable', async () => {
  let conclusionCalls = 0
  const snapshot = await resolveBilibiliSourceSnapshot({
    url: videoUrl,
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify(initialState)}</script>`,
    loadPlayurl: async () => ({
      code: 0,
      data: {
        ...playInfo.data,
        bvid: 'BVTESTCASE01',
        cid: 111001,
      },
    }),
    loadPlayerInfo: async () => ({
      data: {
        subtitle: {
          subtitles: [
            { id: 1, lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//sub/1' },
          ],
        },
      },
    }),
    loadSubtitleBody: async () => ({ body: [{ from: 0, to: 1, content: '作者字幕' }] }),
    loadAiConclusion: async () => {
      conclusionCalls += 1
      return { status: 'available', tracks: [] }
    },
  })

  assert.deepEqual(snapshot.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BVTESTCASE01',
    mediaId: '111001',
  })
  assert.equal('platform' in snapshot, false)
  assert.equal('videoId' in snapshot, false)
  assert.equal('pageId' in snapshot, false)
  assert.equal(conclusionCalls, 0)
  assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'not-needed')
  assert.equal(snapshot.nativeSubtitleTracks[0].sourceKind, 'author')
})

test('source snapshot falls back to normalized conclusion AI subtitles', async () => {
  const snapshot = await resolveBilibiliSourceSnapshot({
    url: videoUrl,
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify(initialState)}</script>`,
    loadPlayurl: async () => ({
      code: 0,
      data: {
        ...playInfo.data,
        bvid: 'BVTESTCASE01',
        cid: 111001,
      },
    }),
    loadPlayerInfo: async () => ({ data: { subtitle: { subtitles: [] } } }),
    loadSubtitleBody: async () => assert.fail('no player body should be loaded'),
    loadAiConclusion: async ({ bvid, cid, upMid }) => {
      assert.deepEqual(
        { bvid, cid, upMid },
        { bvid: 'BVTESTCASE01', cid: 111001, upMid: 297242063 },
      )
      return {
        status: 'available',
        tracks: [
          {
            id: 'bilibili-ai-conclusion',
            language: 'zh-CN',
            label: 'Bilibili AI subtitles',
            sourceKind: 'bilibili-ai',
            cues: [{ startMs: 0, endMs: 1000, text: 'AI 字幕' }],
          },
        ],
      }
    },
  })

  assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'available')
  assert.equal(snapshot.nativeSubtitleTracks[0].id, 'bilibili-ai-conclusion')
})
