import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractBilibiliInitialState,
  extractBilibiliPlayInfo,
  getBilibiliVideoIdentity,
  normalizeBilibiliAudioCandidates,
  resolveBilibiliSelectedPageMetadata,
} from '../../../src/content-script/site-adapters/bilibili/media-source.mjs'

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

test('extracts __playinfo__ JSON without executing page script', () => {
  const html = `<script>window.__playinfo__=${JSON.stringify(playInfo)}</script>`
  assert.deepEqual(extractBilibiliPlayInfo(html), playInfo)
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

test('throws BILIBILI_PLAYINFO_NOT_FOUND when script marker is missing', () => {
  assert.throws(() => extractBilibiliPlayInfo('<html><body>no playinfo here</body></html>'), {
    message: 'BILIBILI_PLAYINFO_NOT_FOUND',
  })
})

test('throws BILIBILI_INITIAL_STATE_NOT_FOUND when script marker is missing', () => {
  assert.throws(
    () => extractBilibiliInitialState('<html><body>no initial state here</body></html>'),
    {
      message: 'BILIBILI_INITIAL_STATE_NOT_FOUND',
    },
  )
})

test('throws on malformed __playinfo__ JSON', () => {
  assert.throws(
    () => extractBilibiliPlayInfo('<script>window.__playinfo__={not json}</script>'),
    SyntaxError,
  )
})

test('throws BILIBILI_PLAYINFO_SCRIPT_INCOMPLETE when marker exists but closing script tag is absent', () => {
  assert.throws(
    () => extractBilibiliPlayInfo('<script>window.__playinfo__={"key":"value"}</div>'),
    { message: 'BILIBILI_PLAYINFO_SCRIPT_INCOMPLETE' },
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

test('resolveBilibiliSelectedPageMetadata uses the selected multipart page cid and duration', () => {
  assert.deepEqual(
    resolveBilibiliSelectedPageMetadata({
      url: multipartVideoUrl,
      initialState,
    }),
    {
      videoId: 'BVTESTCASE01',
      pageNumber: 2,
      bvid: 'BVTESTCASE01',
      cid: 222002,
      durationMs: 321000,
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
