# Bilibili AI Subtitle Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer Bilibili-provided author and AI subtitles, including signed conclusion-endpoint AI subtitles, before offering explicitly confirmed Volcengine ASR.

**Architecture:** Keep page/network discovery in `VideoPageBridge`, add a pure WBI signer and subtitle normalizers, and preserve `nativeSubtitleTracks` as the serializable cross-context contract. Pass an explicit subtitle track ID through the existing port so `VideoTaskRunner` can build the transcript without touching MediaKit; expose the chosen source and non-fatal discovery status in the existing Bilibili view.

**Tech Stack:** JavaScript ES modules, Preact, `webextension-polyfill`, `@noble/hashes`, Node 22 `node:test`, JSDOM, Webpack 5.

## Global Constraints

- The feature remains limited to the full Chromium build on Chrome/Edge 116+.
- Consume only subtitles Bilibili has already generated; never trigger or poll Bilibili generation.
- Source order is author track, player AI track, unknown player track, conclusion AI track, then user-confirmed MediaKit ASR.
- Never start ASR automatically or weaken the existing retention/cost confirmation.
- Never serialize or log cookies, WBI key material, signed query strings, raw subtitle responses, subtitle text, prompts, model output, or provider credentials.
- Do not add dependencies, permissions, host permissions, remote executable code, persistent subtitle caches, or new settings.
- Preserve existing task ownership, cancellation, structured summaries, timestamps, archive/export, and summary-only retry behavior.
- Follow test-first red-green-refactor for every production change.

Before Task 1, run `npm ci` if `node_modules/` is absent, then run `git status --short`. Preserve the
pre-existing unstaged `AGENTS.md` change and stage only files named by each task.

---

### Task 1: Add a deterministic WBI signer

**Files:**
- Create: `src/content-script/site-adapters/bilibili/wbi-signature.mjs`
- Create: `tests/unit/content-script/bilibili-wbi-signature.test.mjs`

**Interfaces:**
- Consumes: nav response fields `data.wbi_img.img_url` and `data.wbi_img.sub_url`.
- Produces: `deriveBilibiliWbiMixinKey(wbiImage)` and
  `signBilibiliWbiParams({ params, mixinKey, nowSeconds })`.
- `signBilibiliWbiParams` returns the complete canonical query string including `wts` and
  `w_rid`; it never mutates `params`.

- [ ] **Step 1: Write the failing signer tests**

Create `tests/unit/content-script/bilibili-wbi-signature.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveBilibiliWbiMixinKey,
  signBilibiliWbiParams,
} from '../../../src/content-script/site-adapters/bilibili/wbi-signature.mjs'

const wbiImage = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
}

test('derives the 32-character WBI mixin key from nav image URLs', () => {
  assert.equal(deriveBilibiliWbiMixinKey(wbiImage), 'ea1db124af3c7062474693fa704f4ff8')
})

test('signs a canonical WBI parameter set', () => {
  const params = {
    up_mid: '297242063',
    cid: '1335073288',
    bvid: 'BV1L94y1H7CV',
  }
  const query = signBilibiliWbiParams({
    params,
    mixinKey: deriveBilibiliWbiMixinKey(wbiImage),
    nowSeconds: 1_700_000_000,
  })

  assert.equal(
    query,
    'bvid=BV1L94y1H7CV&cid=1335073288&up_mid=297242063&wts=1700000000' +
      '&w_rid=3eceadf7c76409e75bfc87611347e4ac',
  )
})

test('does not mutate caller parameters while signing', () => {
  const params = { bvid: 'BV1L94y1H7CV' }
  const original = structuredClone(params)
  signBilibiliWbiParams({
    params,
    mixinKey: deriveBilibiliWbiMixinKey(wbiImage),
    nowSeconds: 1_700_000_000,
  })
  assert.deepEqual(params, original)
})

test('removes WBI-forbidden characters before URL encoding', () => {
  const query = signBilibiliWbiParams({
    params: { keyword: "a!b(c)*d'e" },
    mixinKey: deriveBilibiliWbiMixinKey(wbiImage),
    nowSeconds: 1_700_000_000,
  })

  assert.match(query, /^keyword=abcde&wts=1700000000&w_rid=[a-f0-9]{32}$/)
})

test('rejects malformed WBI image data', () => {
  assert.throws(() => deriveBilibiliWbiMixinKey({}), {
    message: 'BILIBILI_WBI_KEY_INVALID',
  })
})

test('rejects an invalid WBI timestamp', () => {
  assert.throws(
    () =>
      signBilibiliWbiParams({
        params: {},
        mixinKey: 'valid-but-unused',
        nowSeconds: Number.NaN,
      }),
    { message: 'BILIBILI_WBI_TIMESTAMP_INVALID' },
  )
})
```

- [ ] **Step 2: Run the tests and verify the RED state**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-wbi-signature.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `wbi-signature.mjs`.

- [ ] **Step 3: Implement the minimal pure signer**

Create `src/content-script/site-adapters/bilibili/wbi-signature.mjs`:

```js
import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

const MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17,
  0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44,
  52,
])

function keyFromUrl(value) {
  try {
    const fileName = new URL(String(value || '')).pathname.split('/').pop() || ''
    return fileName.split('.')[0]
  } catch {
    return ''
  }
}

function sanitizeValue(value) {
  return String(value ?? '').replace(/[!'()*]/g, '')
}

export function deriveBilibiliWbiMixinKey(wbiImage) {
  const rawKey = keyFromUrl(wbiImage?.img_url) + keyFromUrl(wbiImage?.sub_url)
  if (rawKey.length < 64) throw new Error('BILIBILI_WBI_KEY_INVALID')
  return MIXIN_KEY_ENC_TAB.map((index) => rawKey[index]).join('').slice(0, 32)
}

export function signBilibiliWbiParams({ params, mixinKey, nowSeconds }) {
  if (!Number.isFinite(nowSeconds)) throw new Error('BILIBILI_WBI_TIMESTAMP_INVALID')
  if (typeof mixinKey !== 'string' || mixinKey.length !== 32) {
    throw new Error('BILIBILI_WBI_KEY_INVALID')
  }

  const values = { ...params, wts: String(Math.floor(nowSeconds)) }
  const query = Object.keys(values)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(sanitizeValue(values[key]))}`)
    .join('&')
  const wRid = bytesToHex(md5(utf8ToBytes(query + mixinKey)))
  return `${query}&w_rid=${wRid}`
}
```

- [ ] **Step 4: Run the signer tests and full utility-adjacent tests**

Run the focused command from Step 2. Expected: 5 tests PASS.

Then run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/content-script/*.test.mjs
```

Expected: all content-script unit tests PASS.

- [ ] **Step 5: Commit the signer**

```bash
git add src/content-script/site-adapters/bilibili/wbi-signature.mjs \
  tests/unit/content-script/bilibili-wbi-signature.test.mjs
git commit -m "Add Bilibili WBI request signing"
```

---

### Task 2: Normalize and order Bilibili subtitle sources

**Files:**
- Modify: `src/content-script/site-adapters/bilibili/media-source.mjs`
- Modify: `tests/unit/content-script/bilibili-media-source.test.mjs`

**Interfaces:**
- Consumes: player subtitle descriptors/bodies and full conclusion API responses.
- Produces: `normalizeSubtitleTracks`, `normalizeBilibiliAiConclusion`, and
  `selectPreferredBilibiliSubtitleTrack`.
- Every returned track has `{ id, language, label, sourceKind, cues }`; the ordered list is author,
  player AI, then unknown. Conclusion normalization returns zero or one `bilibili-ai` track.

- [ ] **Step 1: Add failing normalization and ordering tests**

Extend the import in `bilibili-media-source.test.mjs` with:

```js
import {
  normalizeBilibiliAiConclusion,
  normalizeSubtitleTracks,
  selectPreferredBilibiliSubtitleTrack,
} from '../../../src/content-script/site-adapters/bilibili/media-source.mjs'
```

Add these tests:

```js
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
  assert.equal(selectPreferredBilibiliSubtitleTrack(tracks).id, '1')
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

  assert.deepEqual(tracks.map((track) => track.id), ['2'])
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
```

- [ ] **Step 2: Run the media-source tests and verify the RED state**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs
```

Expected: FAIL because the new exports/source metadata do not exist and track failures still reject
the complete normalization.

- [ ] **Step 3: Implement source classification, cue normalization, and conclusion flattening**

In `media-source.mjs`, replace the subtitle normalization helpers with these complete units:

```js
function secondsToMilliseconds(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null
}

function normalizeTimedCue(item, startKey, endKey) {
  const startMs = secondsToMilliseconds(item?.[startKey])
  const endMs = secondsToMilliseconds(item?.[endKey])
  const text = typeof item?.content === 'string' ? item.content.trim() : ''
  if (!text || startMs === null || endMs === null || endMs < startMs) return null
  return { startMs, endMs, text }
}

function classifyPlayerSubtitle(track) {
  const label = String(track?.lan_doc || track?.lan || '')
  const aiType = Number(track?.ai_type)
  if ((Number.isFinite(aiType) && aiType > 0) || /(?:AI|自动生成)/iu.test(label)) {
    return 'bilibili-ai'
  }
  if (track?.ai_type !== undefined && Number.isFinite(aiType) && aiType === 0) return 'author'
  return 'unknown'
}

function subtitleSourceWeight(track) {
  return { author: 0, 'bilibili-ai': 1, unknown: 2 }[track?.sourceKind] ?? 2
}

export function selectPreferredBilibiliSubtitleTrack(tracks) {
  return Array.isArray(tracks) ? tracks.find((track) => track?.cues?.length > 0) || null : null
}

export async function normalizeSubtitleTracks(playInfo, loadSubtitleBody) {
  const subtitles = playInfo?.data?.subtitle?.subtitles
  const tracks = Array.isArray(subtitles) ? subtitles : []
  if (typeof loadSubtitleBody !== 'function') return []

  const resolved = []
  for (const [index, track] of tracks.entries()) {
    const subtitleUrl = normalizeSubtitleUrl(track?.subtitle_url || track?.subtitleUrl)
    if (!subtitleUrl) continue
    try {
      const bodyResponse = await loadSubtitleBody(subtitleUrl)
      const cues = (Array.isArray(bodyResponse?.body) ? bodyResponse.body : [])
        .map((item) => normalizeTimedCue(item, 'from', 'to'))
        .filter(Boolean)
      if (cues.length === 0) continue
      resolved.push({
        id: String(track?.id ?? index),
        language: String(track?.lan || ''),
        label: String(track?.lan_doc || track?.lan || ''),
        sourceKind: classifyPlayerSubtitle(track),
        cues,
      })
    } catch {
      continue
    }
  }

  return resolved
    .map((track, index) => ({ track, index }))
    .sort(
      (left, right) =>
        subtitleSourceWeight(left.track) - subtitleSourceWeight(right.track) ||
        left.index - right.index,
    )
    .map(({ track }) => track)
}

export function normalizeBilibiliAiConclusion(response) {
  const groups = response?.data?.model_result?.subtitle
  const seen = new Set()
  const cues = (Array.isArray(groups) ? groups : [])
    .flatMap((group) => (Array.isArray(group?.part_subtitle) ? group.part_subtitle : []))
    .map((item) => normalizeTimedCue(item, 'start_timestamp', 'end_timestamp'))
    .filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    .filter((cue) => {
      const key = `${cue.startMs}:${cue.endMs}:${cue.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  return cues.length > 0
    ? [
        {
          id: 'bilibili-ai-conclusion',
          language: 'zh-CN',
          label: 'Bilibili AI subtitles',
          sourceKind: 'bilibili-ai',
          cues,
        },
      ]
    : []
}
```

Remove the superseded `normalizeSubtitleCues` helper. Keep `durationToMs` for video/audio metadata.

- [ ] **Step 4: Run the focused tests and the existing Bilibili source/bridge tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs
```

Expected: all tests PASS after updating any existing deep equality that now includes `sourceKind`.

- [ ] **Step 5: Commit subtitle normalization**

```bash
git add src/content-script/site-adapters/bilibili/media-source.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs
git commit -m "Normalize Bilibili subtitle sources"
```

---

### Task 3: Add signed AI-conclusion fallback to `VideoPageBridge`

**Files:**
- Modify: `src/content-script/site-adapters/bilibili/media-source.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-page-bridge.mjs`
- Modify: `tests/unit/content-script/bilibili-media-source.test.mjs`
- Modify: `tests/unit/content-script/bilibili-video-page-bridge.test.mjs`

**Interfaces:**
- `resolveBilibiliSelectedPageMetadata` additionally returns `upMid: number | null`.
- `resolveBilibiliSourceSnapshot` additionally consumes `loadAiConclusion(pageMetadata)` and emits
  `subtitleDiscovery.conclusionStatus`.
- The concrete bridge owns the in-memory mixin-key cache, fixed Bilibili endpoints, one `-403`
  refresh, and non-fatal status mapping.

- [ ] **Step 1: Add failing metadata and bridge orchestration tests**

Update the shared `initialState.videoData` fixture to include `owner: { mid: 297242063 }`, update its
expected page metadata with `upMid: 297242063`, and add:

```js
test('source snapshot skips AI conclusion when a player subtitle is usable', async () => {
  let conclusionCalls = 0
  const snapshot = await resolveBilibiliSourceSnapshot({
    url: videoUrl,
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify(initialState)}</script>`,
    loadPlayurl: async () => playInfo,
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

  assert.equal(conclusionCalls, 0)
  assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'not-needed')
  assert.equal(snapshot.nativeSubtitleTracks[0].sourceKind, 'author')
})

test('source snapshot falls back to normalized conclusion AI subtitles', async () => {
  const snapshot = await resolveBilibiliSourceSnapshot({
    url: videoUrl,
    html: `<script>window.__INITIAL_STATE__=${JSON.stringify(initialState)}</script>`,
    loadPlayurl: async () => playInfo,
    loadPlayerInfo: async () => ({ data: { subtitle: { subtitles: [] } } }),
    loadSubtitleBody: async () => assert.fail('no player body should be loaded'),
    loadAiConclusion: async ({ bvid, cid, upMid }) => {
      assert.deepEqual({ bvid, cid, upMid }, { bvid: 'BVTESTCASE01', cid: 111001, upMid: 297242063 })
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
```

In `bilibili-video-page-bridge.test.mjs`, add a full `createBilibiliVideoPageBridge` fake-fetch test
that returns empty player tracks, nav WBI image URLs, then a successful conclusion body. Capture the
conclusion URL and assert:

```js
assert.equal(conclusionUrl.searchParams.get('bvid'), 'BV1subtitle')
assert.equal(conclusionUrl.searchParams.get('cid'), '12345')
assert.equal(conclusionUrl.searchParams.get('up_mid'), '297242063')
assert.equal(conclusionUrl.searchParams.get('wts'), '1700000000')
assert.match(conclusionUrl.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
assert.equal(conclusionRequest.credentials, 'include')
assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'available')
assert.equal(snapshot.nativeSubtitleTracks[0].sourceKind, 'bilibili-ai')
```

Construct the bridge with `now: () => 1_700_000_000_000` so the signed URL is deterministic.

- [ ] **Step 2: Run the bridge tests and verify the RED state**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs
```

Expected: FAIL because metadata lacks `upMid`, the resolver lacks `loadAiConclusion`, and the bridge
does not call nav/conclusion.

- [ ] **Step 3: Add uploader metadata and pure resolver fallback**

Extend the page metadata return value in `media-source.mjs`:

```js
return {
  videoId: identity.videoId || bvid,
  pageNumber: identity.pageNumber,
  bvid,
  cid,
  upMid: parsePositiveInteger(videoData?.owner?.mid),
  durationMs: durationToMs(selectedPage?.duration ?? videoData.duration),
}
```

Replace the subtitle part of `resolveBilibiliSourceSnapshot` in `video-page-bridge.mjs` with:

```js
const playerSubtitleTracks = await normalizeSubtitleTracks(playerInfo, loadSubtitleBody)
let conclusionResult = { status: 'not-needed', tracks: [] }
if (playerSubtitleTracks.length === 0 && typeof loadAiConclusion === 'function') {
  conclusionResult = await loadAiConclusion(pageMetadata).catch(() => ({
    status: 'unavailable',
    tracks: [],
  }))
}

return {
  platform: 'bilibili',
  videoId: pageMetadata.videoId,
  pageId: String(pageMetadata.cid),
  title: String(initialState?.videoData?.title || ''),
  durationMs: pageMetadata.durationMs,
  nativeSubtitleTracks:
    playerSubtitleTracks.length > 0 ? playerSubtitleTracks : conclusionResult.tracks || [],
  subtitleDiscovery: {
    conclusionStatus: playerSubtitleTracks.length > 0 ? 'not-needed' : conclusionResult.status,
  },
  mediaCandidates,
}
```

Add `loadAiConclusion` to the resolver parameter list.

- [ ] **Step 4: Implement the concrete signed conclusion loader**

Import the Task 1 signer and Task 2 normalizer. Add fixed endpoint builders and a bridge-local cache:

```js
function createNavEndpoint() {
  return new URL('https://api.bilibili.com/x/web-interface/nav')
}

function createConclusionEndpoint(query) {
  return new URL(`https://api.bilibili.com/x/web-interface/view/conclusion/get?${query}`)
}
```

Inside `createBilibiliVideoPageBridge`, accept `now = () => Date.now()` and add:

```js
let cachedWbiMixinKey = null

const loadWbiMixinKey = async ({ refresh = false } = {}) => {
  if (cachedWbiMixinKey && !refresh) return cachedWbiMixinKey
  const response = await fetchImpl(createNavEndpoint(), { credentials: 'include' })
  if (!response?.ok) throw new Error('BILIBILI_WBI_NAV_HTTP_ERROR')
  const body = await response.json()
  if (Number(body?.code) !== 0) throw new Error('BILIBILI_WBI_NAV_API_ERROR')
  cachedWbiMixinKey = deriveBilibiliWbiMixinKey(body?.data?.wbi_img)
  return cachedWbiMixinKey
}

const loadAiConclusion = async ({ bvid, cid, upMid }) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const mixinKey = await loadWbiMixinKey({ refresh: attempt > 0 })
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
      if (!response?.ok) return { status: 'unavailable', tracks: [] }
      const body = await response.json()
      if (Number(body?.code) === -101) return { status: 'login-required', tracks: [] }
      if (Number(body?.code) === -403 && attempt === 0) {
        cachedWbiMixinKey = null
        continue
      }
      if (Number(body?.code) !== 0) return { status: 'unavailable', tracks: [] }
      const tracks = normalizeBilibiliAiConclusion(body)
      return { status: tracks.length > 0 ? 'available' : 'not-found', tracks }
    } catch {
      return { status: 'unavailable', tracks: [] }
    }
  }
  return { status: 'unavailable', tracks: [] }
}
```

Pass `loadAiConclusion` from `getSnapshot()` into `resolveBilibiliSourceSnapshot`.

- [ ] **Step 5: Add bounded retry and non-fatal status tests**

Using the same fake-fetch bridge harness, add separate tests that assert:

```js
assert.equal(navRequestCount, 2)
assert.equal(conclusionRequestCount, 2)
assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'unavailable')
assert.deepEqual(snapshot.nativeSubtitleTracks, [])
assert.equal(snapshot.mediaCandidates.length, 1)
```

for two consecutive `-403` conclusion responses, and:

```js
assert.equal(snapshot.subtitleDiscovery.conclusionStatus, 'login-required')
assert.equal(conclusionRequestCount, 1)
assert.equal(mediaKitRequestCount, 0)
```

for an outer `-101` response. `mediaKitRequestCount` is a fake sentinel and must stay zero because
source discovery never invokes MediaKit.

- [ ] **Step 6: Run all Bilibili source/bridge tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-wbi-signature.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs
```

Expected: all tests PASS, including one-refresh-only behavior and serializable snapshots.

- [ ] **Step 7: Commit the bridge fallback**

```bash
git add src/content-script/site-adapters/bilibili/media-source.mjs \
  src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs
git commit -m "Fetch Bilibili AI subtitle fallback"
```

---

### Task 4: Carry an explicit subtitle track through the task protocol

**Files:**
- Modify: `src/content-script/site-adapters/bilibili/video-summary-port.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-summary-host.mjs`
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/content-script/bilibili-video-summary-port.test.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

**Interfaces:**
- `startTask` accepts `subtitleTrackId` and includes it in `START_TASK` only when present.
- Host chooses `selectPreferredBilibiliSubtitleTrack(sourceSnapshot.nativeSubtitleTracks)`.
- `createNativeSubtitleTranscription(sourceSnapshot, subtitleTrackId)` requires the matching usable
  track and otherwise throws `BILIBILI_SUBTITLE_TRACK_NOT_FOUND`.

- [ ] **Step 1: Add a failing port serialization test**

Change the first `client.startTask` call in `bilibili-video-summary-port.test.mjs` to include:

```js
subtitleTrackId: 'bilibili-ai-conclusion',
```

Then assert:

```js
assert.equal(port.outbound[0].subtitleTrackId, 'bilibili-ai-conclusion')
```

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-video-summary-port.test.mjs
```

Expected: FAIL because `startTask` currently discards `subtitleTrackId`.

- [ ] **Step 2: Forward the track ID through the port**

Change the method signature and payload in `video-summary-port.mjs`:

```js
async startTask({
  sourceChoice,
  subtitleTrackId,
  sourceSnapshot,
  settingsSnapshot,
  modelSnapshot,
}) {
  const taskId = crypto.randomUUID()
  activeTaskId = taskId
  port.postMessage(
    cloneSerializable({
      type: 'START_TASK',
      taskId,
      videoId,
      sourceChoice,
      ...(subtitleTrackId ? { subtitleTrackId } : {}),
      sourceSnapshot,
      settingsSnapshot,
      ...(modelSnapshot === undefined ? {} : { modelSnapshot }),
    }),
  )
  return taskId
}
```

Run the focused port test again. Expected: PASS.

- [ ] **Step 3: Add failing runner track-selection tests**

In `task-runner.test.mjs`, add a helper model gateway that returns unsupported capabilities so the
test observes the transcript result without model calls, then add:

```js
test('Bilibili subtitle choice uses the requested track and never calls MediaKit', async () => {
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource() {
        assert.fail('Bilibili subtitle path must not call MediaKit')
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: false, reason: 'MODEL_GATEWAY_UNSUPPORTED' }
      },
      cancel() {},
    },
    logger: createLogger(),
    clock: { now: () => 1234 },
  })
  const emitted = []
  await runner.start(
    {
      taskId: 'task-ai-subtitle',
      owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
      sourceChoice: 'native-subtitle',
      subtitleTrackId: 'ai-track',
      sourceSnapshot: {
        nativeSubtitleTracks: [
          {
            id: 'author-track',
            language: 'en',
            cues: [{ startMs: 0, endMs: 500, text: 'wrong track' }],
          },
          {
            id: 'ai-track',
            language: 'zh-CN',
            sourceKind: 'bilibili-ai',
            cues: [{ startMs: 1000, endMs: 2000, text: 'selected AI track' }],
          },
        ],
      },
      settingsSnapshot: { preferredLanguage: 'zh-Hans' },
      modelSnapshot: {},
    },
    (event) => emitted.push(event),
  )

  const result = emitted.findLast((event) => event.type === 'TASK_RESULT').result
  assert.equal(result.transcriptSegments[0].text, 'selected AI track')
  assert.equal(result.transcriptSegments[0].id, 'native-1')
})

test('Bilibili subtitle choice rejects a missing requested track without MediaKit fallback', async () => {
  const mediaCalls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
      },
    },
    modelGateway: {},
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  await assert.rejects(
    () =>
      runner.start(
        {
          taskId: 'task-missing-track',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
          sourceChoice: 'native-subtitle',
          subtitleTrackId: 'missing',
          sourceSnapshot: { nativeSubtitleTracks: [] },
        },
        () => {},
      ),
    { message: 'BILIBILI_SUBTITLE_TRACK_NOT_FOUND' },
  )
  assert.equal(mediaCalls.length, 0)
})

test('unsupported source choice cannot fall through to paid ASR', async () => {
  const mediaCalls = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
      },
    },
    modelGateway: {},
    logger: createLogger(),
    clock: { now: () => 1234 },
  })

  await assert.rejects(
    () =>
      runner.start(
        {
          taskId: 'task-invalid-source',
          owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1ai' },
          sourceChoice: 'unexpected-source',
          sourceSnapshot: { nativeSubtitleTracks: [], mediaCandidates: [{ id: 'audio' }] },
        },
        () => {},
      ),
    { message: 'VIDEO_SUMMARY_SOURCE_CHOICE_UNSUPPORTED' },
  )
  assert.equal(mediaCalls.length, 0)
})
```

In `end-to-end-fakes.test.mjs`, replace `createSubtitleTrack` with a helper that accepts source
metadata:

```js
function createSubtitleTrack(
  cues,
  { id = 'sub-1', language = 'zh-CN', label = 'Chinese', sourceKind = 'unknown' } = {},
) {
  return [
    {
      id,
      language,
      label,
      sourceKind,
      cues: cues.map((cue) => ({ ...cue })),
    },
  ]
}
```

Update both existing native-subtitle start commands with `subtitleTrackId: 'sub-1'`, then add these
two complete cases before changing production code:

```js
for (const fixture of [
  {
    name: 'player AI subtitles',
    id: 'player-ai',
    label: '中文（自动生成）',
    lines: ['播放器 AI 字幕第一句', '播放器 AI 字幕第二句'],
  },
  {
    name: 'conclusion AI subtitles',
    id: 'bilibili-ai-conclusion',
    label: 'Bilibili AI subtitles',
    lines: ['总结接口 AI 字幕第一句', '总结接口 AI 字幕第二句'],
  },
]) {
  test(`${fixture.name} complete without any MediaKit call`, async () => {
    const mediaPipeline = {
      async transcribeFromSource() {
        assert.fail('Bilibili subtitle path must not call MediaKit')
      },
    }
    const harness = createHarness({ mediaPipeline, modelGateway: createModelGateway() })
    const owner = createVideoSummaryOwner({
      tabId: 1,
      documentId: `doc-${fixture.id}`,
      videoId: `BV1-${fixture.id}`,
    })
    const sourceSnapshot = createSourceSnapshot({
      videoId: owner.videoId,
      nativeSubtitleTracks: createSubtitleTrack(
        [
          { startMs: 0, endMs: 1000, text: fixture.lines[0] },
          { startMs: 1000, endMs: 2200, text: fixture.lines[1] },
        ],
        {
          id: fixture.id,
          label: fixture.label,
          sourceKind: 'bilibili-ai',
        },
      ),
    })
    const mounted = await harness.mountClient({ owner, sourceSnapshot })

    await mounted.client.startTask({
      sourceChoice: 'native-subtitle',
      subtitleTrackId: fixture.id,
      sourceSnapshot,
      settingsSnapshot: { preferredLanguage: 'zh-Hans' },
      modelSnapshot: { apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' } },
    })

    const resultEvent = await mounted.waitFor((event) => event.type === 'TASK_RESULT')
    assert.deepEqual(
      resultEvent.result.transcriptSegments.map((segment) => segment.text),
      fixture.lines,
    )
  })
}
```

- [ ] **Step 4: Run runner tests and verify the RED state**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: the first new test uses the wrong array-first track, the second reports the old
`BILIBILI_NATIVE_SUBTITLES_NOT_FOUND` error, and the unsupported choice reaches the media pipeline.
The integration cases also fail because the port drops the requested track ID and the runner does
not select it.

- [ ] **Step 5: Select the explicit track in the runner**

Replace `createNativeSubtitleTranscription` with:

```js
function createNativeSubtitleTranscription(sourceSnapshot, subtitleTrackId) {
  const tracks = Array.isArray(sourceSnapshot?.nativeSubtitleTracks)
    ? sourceSnapshot.nativeSubtitleTracks
    : []
  const normalizedTrackId = String(subtitleTrackId || '').trim()
  const track = tracks.find((item) => String(item?.id || '') === normalizedTrackId) || null
  const cues = Array.isArray(track?.cues) ? track.cues : []
  if (!track || cues.length === 0) throw new Error('BILIBILI_SUBTITLE_TRACK_NOT_FOUND')

  const segments = cues
    .map((cue, index) => ({
      id: `native-${index + 1}`,
      startMs: toFiniteMs(cue?.startMs),
      endMs: toFiniteMs(cue?.endMs),
      text: String(cue?.text || '').trim(),
      speaker: null,
      confidence: null,
    }))
    .filter((segment) => segment.text)
  if (segments.length === 0) throw new Error('BILIBILI_SUBTITLE_TRACK_NOT_FOUND')

  return {
    durationMs: Math.max(...segments.map((segment) => segment.endMs), 0),
    detectedLanguage:
      typeof track?.language === 'string' && track.language.trim() ? track.language.trim() : null,
    segments,
  }
}
```

Replace the source branch in `start()` with an explicit branch that cannot route an unknown choice
to paid ASR:

```js
if (command.sourceChoice === 'native-subtitle') {
  emitEvent(emit, {
    type: 'TASK_STATUS',
    taskId,
    owner: command.owner,
    stage: 'loading-native-subtitles',
    checkpointAvailable: false,
  })
  transcription = createNativeSubtitleTranscription(
    command.sourceSnapshot,
    command.subtitleTrackId,
  )
} else if (command.sourceChoice === 'asr') {
  transcription = await mediaPipeline.transcribeFromSource({
    taskId,
    owner: command.owner,
    sourceSnapshot: command.sourceSnapshot,
    settingsSnapshot: command.settingsSnapshot,
    requestSourceRefresh: command.requestSourceRefresh,
    signal: controller.signal,
    onEvent(event) {
      emitEvent(emit, {
        type: 'TASK_STATUS',
        taskId,
        owner: command.owner,
        checkpointAvailable: false,
        ...event,
      })
    },
  })
} else {
  throw new Error('VIDEO_SUMMARY_SOURCE_CHOICE_UNSUPPORTED')
}
```

Update existing native-subtitle tests and integration fixtures to pass the exact track ID.

- [ ] **Step 6: Select and send the recommended track from the host**

Import `selectPreferredBilibiliSubtitleTrack` in `video-summary-host.mjs`. In `rerender`, derive:

```js
const subtitleTrack = selectPreferredBilibiliSubtitleTrack(
  state.sourceSnapshot?.nativeSubtitleTracks,
)
```

Pass `subtitleTrack` and `subtitleDiscoveryStatus` to the view:

```js
subtitleTrack,
subtitleDiscoveryStatus: state.sourceSnapshot?.subtitleDiscovery?.conclusionStatus,
```

In `startTask`, pass:

```js
subtitleTrackId:
  choice === 'native-subtitle'
    ? selectPreferredBilibiliSubtitleTrack(sourceSnapshot.nativeSubtitleTracks)?.id
    : undefined,
```

Do not change ASR confirmation or `sourceChoice` values.

- [ ] **Step 7: Run protocol and runner tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-video-summary-port.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: all tests PASS and every subtitle test asserts zero media-pipeline calls.

- [ ] **Step 8: Commit the explicit track protocol**

```bash
git add src/content-script/site-adapters/bilibili/video-summary-port.mjs \
  src/content-script/site-adapters/bilibili/video-summary-host.mjs \
  src/video-summary/task-runner.mjs \
  tests/unit/content-script/bilibili-video-summary-port.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
git commit -m "Select Bilibili subtitle tracks explicitly"
```

---

### Task 5: Present subtitle availability and source in the UI

**Files:**
- Modify: `src/components/BilibiliVideoSummaryView/index.jsx`
- Modify: `src/components/BilibiliVideoSummaryView/styles.scss`
- Modify: `src/_locales/en/main.json`
- Modify: `src/_locales/zh-hans/main.json`
- Modify: `src/_locales/zh-hant/main.json`
- Modify: `tests/unit/components/bilibili-video-summary-view.test.mjs`

**Interfaces:**
- View consumes `subtitleTrack` and `subtitleDiscoveryStatus` from Task 4.
- The Bilibili subtitle button stays `data-source-choice="native-subtitle"`, is disabled when no
  track exists, and never triggers ASR confirmation.

- [ ] **Step 1: Add failing source-label and fallback-state view tests**

Extend the first view test props with:

```js
subtitleTrack: {
  id: 'bilibili-ai-conclusion',
  label: 'Bilibili AI subtitles',
  sourceKind: 'bilibili-ai',
  cues: [{ startMs: 0, endMs: 1000, text: 'AI 字幕' }],
},
subtitleDiscoveryStatus: 'available',
```

Then assert before clicking:

```js
assert.equal(nativeButton.disabled, false)
assert.equal(nativeButton.textContent.includes('Bilibili AI subtitles'), true)
assert.equal(nativeButton.textContent.includes('Recommended'), true)
```

Add a separate test:

```js
test('view explains login-required subtitle discovery and never auto-selects ASR', () => {
  const calls = []
  mountView({
    videoTitle: 'No Subtitle Video',
    sourceChoice: null,
    subtitleTrack: null,
    subtitleDiscoveryStatus: 'login-required',
    taskState: { phase: 'idle', activeStage: null, result: null, checkpointAvailable: false },
    onChooseSource: (choice) => calls.push(choice),
    onConfirmAsr() {},
    onCancelAsrConfirmation() {},
    onArchive() {},
    onAskAboutVideo() {},
    onDownloadMarkdown() {},
    onSeekTo() {},
    onRetrySummary() {},
  })

  assert.equal(
    container.textContent.includes('Sign in to Bilibili to check for AI subtitles'),
    true,
  )
  assert.equal(
    container.querySelector('button[data-source-choice="native-subtitle"]').disabled,
    true,
  )
  assert.deepEqual(calls, [])
  assert.equal(container.querySelector('[data-action="confirm-asr"]'), null)
})
```

- [ ] **Step 2: Run the component test and verify the RED state**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/components/bilibili-video-summary-view.test.mjs
```

Expected: FAIL because the view does not consume source metadata or render the discovery message.

- [ ] **Step 3: Implement translated source labels and availability messages**

Add this import:

```js
import { useTranslation } from 'react-i18next'
```

Update `SourceChoiceButtons` to accept `subtitleTrack`:

```jsx
function SourceChoiceButtons({ sourceChoice, subtitleTrack, onChooseSource }) {
  const { t } = useTranslation()
  const subtitleLabel =
    subtitleTrack?.sourceKind === 'author'
      ? t('Use author subtitles')
      : subtitleTrack?.sourceKind === 'bilibili-ai'
      ? t('Use Bilibili AI subtitles')
      : subtitleTrack?.label
      ? t('Use Bilibili subtitles: {{label}}', { label: subtitleTrack.label })
      : t('Bilibili subtitles unavailable')

  return (
    <div className="bilibili-video-summary-view__choices">
      <button
        type="button"
        data-source-choice="native-subtitle"
        disabled={!subtitleTrack}
        className={sourceChoice === 'native-subtitle' ? 'is-selected' : ''}
        onClick={() => onChooseSource('native-subtitle')}
      >
        {subtitleLabel}
        {subtitleTrack ? <span className="bilibili-video-summary-view__recommended">{t('Recommended')}</span> : null}
      </button>
      <button
        type="button"
        data-source-choice="asr"
        className={sourceChoice === 'asr' ? 'is-selected' : ''}
        onClick={() => onChooseSource('asr')}
      >
        {t('Run ASR')}
      </button>
    </div>
  )
}
```

Add `const { t } = useTranslation()` at the start of the main view function. Render this non-fatal
message immediately below the choices:

```jsx
{!subtitleTrack && subtitleDiscoveryStatus === 'login-required' ? (
  <p className="bilibili-video-summary-view__subtitle-notice">
    {t('Sign in to Bilibili to check for AI subtitles')}
  </p>
) : !subtitleTrack ? (
  <p className="bilibili-video-summary-view__subtitle-notice">
    {t('No Bilibili subtitles available')}
  </p>
) : null}
```

Add `subtitleTrack` and `subtitleDiscoveryStatus` to the component and `PropTypes`; pass
`subtitleTrack` into `SourceChoiceButtons`. Add the exact styles:

```scss
.bilibili-video-summary-view__recommended {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 600;
}

.bilibili-video-summary-view__subtitle-notice {
  margin: 8px 0 0;
  color: #4e6680;
}
```

Use these exact prop declarations:

```js
SourceChoiceButtons.propTypes = {
  sourceChoice: PropTypes.string,
  subtitleTrack: PropTypes.shape({
    id: PropTypes.string.isRequired,
    label: PropTypes.string,
    sourceKind: PropTypes.oneOf(['author', 'bilibili-ai', 'unknown']).isRequired,
    cues: PropTypes.array.isRequired,
  }),
  onChooseSource: PropTypes.func.isRequired,
}

subtitleTrack: PropTypes.shape({
  id: PropTypes.string.isRequired,
  label: PropTypes.string,
  sourceKind: PropTypes.oneOf(['author', 'bilibili-ai', 'unknown']).isRequired,
  cues: PropTypes.array.isRequired,
}),
subtitleDiscoveryStatus: PropTypes.oneOf([
  'not-needed',
  'available',
  'not-found',
  'login-required',
  'unavailable',
]),
```

Insert the last two properties inside the existing `BilibiliVideoSummaryView.propTypes` object;
leave every existing callback and task-state declaration unchanged.

In the component test's async setup, initialize the real English i18n resources before importing
the component:

```js
await import('../../../src/_locales/i18n-react.mjs')
const importedModule = await import('../../../src/components/BilibiliVideoSummaryView/index.jsx')
```

- [ ] **Step 4: Add the exact locale entries**

Add these English keys to `src/_locales/en/main.json`, then the shown translations to Simplified
and Traditional Chinese:

```json
"Use author subtitles": "Use author subtitles",
"Use Bilibili AI subtitles": "Use Bilibili AI subtitles",
"Use Bilibili subtitles: {{label}}": "Use Bilibili subtitles: {{label}}",
"Bilibili subtitles unavailable": "Bilibili subtitles unavailable",
"Recommended": "Recommended",
"Run ASR": "Run ASR",
"Sign in to Bilibili to check for AI subtitles": "Sign in to Bilibili to check for AI subtitles",
"No Bilibili subtitles available": "No Bilibili subtitles available"
```

```json
"Use author subtitles": "使用作者字幕",
"Use Bilibili AI subtitles": "使用 B 站 AI 字幕",
"Use Bilibili subtitles: {{label}}": "使用 B 站字幕：{{label}}",
"Bilibili subtitles unavailable": "没有可用的 B 站字幕",
"Recommended": "推荐",
"Run ASR": "运行 ASR",
"Sign in to Bilibili to check for AI subtitles": "登录 B 站后可继续检查 AI 字幕",
"No Bilibili subtitles available": "没有可用的 B 站字幕"
```

```json
"Use author subtitles": "使用作者字幕",
"Use Bilibili AI subtitles": "使用 Bilibili AI 字幕",
"Use Bilibili subtitles: {{label}}": "使用 Bilibili 字幕：{{label}}",
"Bilibili subtitles unavailable": "沒有可用的 Bilibili 字幕",
"Recommended": "推薦",
"Run ASR": "執行 ASR",
"Sign in to Bilibili to check for AI subtitles": "登入 Bilibili 後可繼續檢查 AI 字幕",
"No Bilibili subtitles available": "沒有可用的 Bilibili 字幕"
```

- [ ] **Step 5: Run component and locale-adjacent tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/components/bilibili-video-summary-view.test.mjs \
  tests/unit/config/language-config.test.mjs \
  tests/unit/config/language-data.test.mjs
```

Expected: all tests PASS with no React/Preact act warnings.

- [ ] **Step 6: Commit the source-aware UI**

```bash
git add src/components/BilibiliVideoSummaryView/index.jsx \
  src/components/BilibiliVideoSummaryView/styles.scss \
  src/_locales/en/main.json src/_locales/zh-hans/main.json src/_locales/zh-hant/main.json \
  tests/unit/components/bilibili-video-summary-view.test.mjs
git commit -m "Recommend Bilibili subtitle sources"
```

---

### Task 6: Run release-level validation

**Files:**
- Verify only; production and test changes are complete in Tasks 1–5.

**Interfaces:**
- Proves the user-visible invariant: every Bilibili subtitle path bypasses MediaKit, while explicit
  ASR retains its existing behavior.

- [ ] **Step 1: Run the focused feature suite**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-wbi-signature.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/bilibili-video-summary-port.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/unit/components/bilibili-video-summary-view.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 2: Format and run repository validation**

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Expected: every command exits 0. Do not treat `npm run verify` as required for this feature because
it exercises external search engines, not Bilibili.

- [ ] **Step 3: Validate generated artifacts**

Run:

```bash
test -f build/chromium/VideoSummaryOffscreen.html
test -f build/chromium/VideoSummaryOffscreen.js
test ! -e build/firefox/VideoSummaryOffscreen.html
test ! -e build/firefox/VideoSummaryOffscreen.js
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.js
```

Expected: all assertions exit 0, proving the new code did not widen the feature's build boundary.

- [ ] **Step 4: Perform manual Chromium verification**

Load `build/chromium/` in Chrome or Edge 116+ and verify all of the following with DevTools network
and extension context logs open:

1. Author-subtitle video: the author source is labeled/recommended, conclusion is not requested,
   and MediaKit is not requested.
2. Player-AI-subtitle video: the AI source is labeled/recommended, conclusion is not requested, and
   MediaKit is not requested.
3. Conclusion-only AI-subtitle video while logged in: nav and signed conclusion requests succeed,
   timestamps seek correctly, and MediaKit is not requested.
4. Logged-out conclusion-only video: the login-required notice appears and no ASR starts.
5. Explicit ASR selection: the existing retention/cost confirmation appears before any MediaKit
   request.
6. SPA navigation/reload: old task events do not attach to the new document/video.
7. Archive, Markdown export, and summary-only retry still work for a Bilibili AI transcript.

- [ ] **Step 5: Review the final diff for security and scope**

```bash
git diff --check 7cd71cc..HEAD
git diff --stat 7cd71cc..HEAD
git status --short
```

Inspect every changed logging call and serialized message. Confirm no raw conclusion response,
subtitle content, signed query, WBI key, cookie, or API key is logged or persisted. Confirm the only
unrelated working-tree change remains the pre-existing `AGENTS.md` modification.
