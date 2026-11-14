# Bilibili Media Feasibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove or reject a reliable, Chromium-extension-native path from the current Bilibili video to an AI MediaKit ASR task before any production video-summary UI is implemented.

**Architecture:** Add pure Bilibili play-info parsing, a small testable MediaKit probe client, and a development-only extension diagnostic page. The diagnostic page receives a serializable source snapshot from the Bilibili content script, tests direct MediaKit ingestion and local OPFS download/upload separately, and produces a sanitized evidence report that determines go/no-go and whether FFmpeg is necessary.

**Tech Stack:** JavaScript ESM, Chrome/Edge 116+, WebExtension APIs, Webpack 5, Node test runner, OPFS, Declarative Net Request session rules, Volcengine AI MediaKit HTTP API.

**Design:** `docs/superpowers/specs/2026-09-27-video-transcription-summary-design.md`

## Global Constraints

- Do not implement production video-summary UI, Offscreen orchestration, or YouTube support in this plan.
- Do not add runtime behavior to production builds; the probe is compiled only with the
  `--bilibili-media-spike` build flag.
- Do not commit API keys, cookies, signed CDN URLs, raw media, transcripts, or unsanitized network captures.
- Do not bypass DRM, payment, privacy, or region restrictions.
- Test only public videos and logged-in videos the current browser profile may normally play.
- Every paid MediaKit submission requires the explicit `--confirm-paid-request` CLI flag or a visible confirmation in the diagnostic page.
- Use a stable `client_token` for retries of one logical ASR submission.
- Stop after the spike if neither direct MediaKit ingestion nor local download plus MediaKit upload is reliable.
- Chrome and Edge 116+ are the only browser targets for the probe.
- Use `apply_patch` for source edits and follow the repository's Prettier/ESLint conventions.

---

## File Map

### Production-candidate pure modules

- Create `src/content-script/site-adapters/bilibili/media-source.mjs`: parse Bilibili video identity and DASH audio candidates into serializable probe snapshots.
- Create `src/services/apis/volcengine-mediakit-probe.mjs`: dependency-injected MediaKit upload, submit, and query primitives used only by the spike harness.

### Development-only harness

- Create `src/content-script/site-adapters/bilibili/media-probe-bridge.mjs`: answer a single diagnostic snapshot message from the current Bilibili page.
- Create `src/pages/BilibiliMediaProbe/index.html`: diagnostic page shell.
- Create `src/pages/BilibiliMediaProbe/index.mjs`: active-tab discovery, direct-ingest test, OPFS download, signed upload, ASR polling, sanitization, and result display.
- Modify `src/content-script/site-adapters/bilibili/index.mjs`: register the bridge only when the compile-time spike flag is enabled.
- Modify `build.mjs`: define the spike flag, add the probe entry only for spike builds, and copy the page only into Chromium spike output.
- Modify `package.json`: add a bounded one-shot spike build command.

### Tests and evidence

- Create `tests/unit/content-script/bilibili-media-source.test.mjs`.
- Create `tests/unit/services/apis/volcengine-mediakit-probe.test.mjs`.
- Create `tests/unit/content-script/bilibili-media-probe-bridge.test.mjs`.
- Create `docs/superpowers/research/2026-09-27-bilibili-media-feasibility.md` only after running the real browser/provider matrix; commit it with concrete sanitized observations and a go/no-go decision.

---

### Task 1: Parse Bilibili media into a serializable probe snapshot

**Files:**
- Create: `src/content-script/site-adapters/bilibili/media-source.mjs`
- Test: `tests/unit/content-script/bilibili-media-source.test.mjs`

**Interfaces:**
- Consumes: Bilibili page URL and HTML containing `window.__playinfo__`.
- Produces: `getBilibiliVideoIdentity(url)`, `extractBilibiliPlayInfo(html)`, `normalizeBilibiliAudioCandidates(playInfo)`, and `createBilibiliMediaProbeSnapshot({ url, html })`.

- [ ] **Step 1: Write the failing identity and play-info tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createBilibiliMediaProbeSnapshot,
  extractBilibiliPlayInfo,
  getBilibiliVideoIdentity,
  normalizeBilibiliAudioCandidates,
} from '../../../src/content-script/site-adapters/bilibili/media-source.mjs'

const primaryUrl =
  'https://xy123.mcdn.bilivideo.cn/audio.m4s?deadline=1790486400&token=secret-value'
const backupUrl =
  'https://backup.example.invalid/audio.m4s?deadline=1790486400&token=other-secret'
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

test('parses BV identity and page number', () => {
  assert.deepEqual(
    getBilibiliVideoIdentity('https://www.bilibili.com/video/BV1abc123?p=3'),
    { videoId: 'BV1abc123', pageNumber: 3 },
  )
})

test('extracts __playinfo__ JSON without executing page script', () => {
  const html = `<script>window.__playinfo__=${JSON.stringify(playInfo)}</script>`
  assert.deepEqual(extractBilibiliPlayInfo(html), playInfo)
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

test('creates a structured-clone-safe snapshot', () => {
  const html = `<script>window.__playinfo__=${JSON.stringify(playInfo)}</script>`
  const snapshot = createBilibiliMediaProbeSnapshot({
    url: 'https://www.bilibili.com/video/BV1abc123?p=1',
    html,
  })
  assert.doesNotThrow(() => structuredClone(snapshot))
  assert.equal(snapshot.platform, 'bilibili')
  assert.equal(snapshot.durationMs, 600000)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/content-script/bilibili-media-source.test.mjs
```

Expected: FAIL because `media-source.mjs` does not exist.

- [ ] **Step 3: Implement the minimal pure parser**

Implement these exact rules in `media-source.mjs`:

```js
export function getBilibiliVideoIdentity(input) {
  const url = new URL(input)
  const videoId = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/)?.[1] || ''
  const pageNumber = Math.max(1, Number.parseInt(url.searchParams.get('p') || '1', 10) || 1)
  return { videoId, pageNumber }
}

export function extractBilibiliPlayInfo(html) {
  const marker = 'window.__playinfo__='
  const start = html.indexOf(marker)
  if (start === -1) throw new Error('BILIBILI_PLAYINFO_NOT_FOUND')
  const scriptEnd = html.indexOf('</script>', start)
  if (scriptEnd === -1) throw new Error('BILIBILI_PLAYINFO_SCRIPT_INCOMPLETE')
  const json = html.slice(start + marker.length, scriptEnd).trim().replace(/;$/, '')
  return JSON.parse(json)
}

function readField(value, camelName, snakeName) {
  return value?.[camelName] ?? value?.[snakeName]
}

function parseExpiry(url) {
  const value = Number.parseInt(new URL(url).searchParams.get('deadline') || '', 10)
  return Number.isFinite(value) ? value * 1000 : null
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

export function createBilibiliMediaProbeSnapshot({ url, html }) {
  const identity = getBilibiliVideoIdentity(url)
  const playInfo = extractBilibiliPlayInfo(html)
  const mediaCandidates = normalizeBilibiliAudioCandidates(playInfo)
  return {
    platform: 'bilibili',
    ...identity,
    durationMs: mediaCandidates[0]?.mediaMetadata.durationMs || 0,
    mediaCandidates,
  }
}
```

- [ ] **Step 4: Add malformed-input and snake_case tests**

Add tests proving missing script, malformed JSON, non-HTTPS candidates, absent DASH audio, and
snake_case response fields produce deterministic results or named errors.

- [ ] **Step 5: Run the focused test**

Run the command from Step 2.

Expected: all tests in `bilibili-media-source.test.mjs` PASS.

- [ ] **Step 6: Commit the parser**

```bash
git add src/content-script/site-adapters/bilibili/media-source.mjs tests/unit/content-script/bilibili-media-source.test.mjs
git commit -m "Add Bilibili media source parser"
```

---

### Task 2: Add a testable AI MediaKit probe client

**Files:**
- Create: `src/services/apis/volcengine-mediakit-probe.mjs`
- Test: `tests/unit/services/apis/volcengine-mediakit-probe.test.mjs`

**Interfaces:**
- Consumes: explicit `apiKey`, media URL or `Blob`, stable `clientToken`, and injected `fetchImpl`.
- Produces: `sanitizeMediaUrl()`, `requestMediaUploadTarget()`, `uploadMediaBlob()`, `submitMediaKitAsr()`, `queryMediaKitTask()`, and `pollMediaKitTask()`.

- [ ] **Step 1: Write failing request-shape and redaction tests**

Use `mock.fn()` and synthetic responses to assert:

```js
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  requestMediaUploadTarget,
  sanitizeMediaUrl,
  submitMediaKitAsr,
} from '../../../../src/services/apis/volcengine-mediakit-probe.mjs'

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })

test('normalizes upload target and ASR request without exposing signed query values', async () => {
  const fetchImpl = mock.fn(async (url) => {
    if (url.endsWith('/request-media-upload-url')) {
      return jsonResponse({
        success: true,
        result: {
          file_id: 'file-1',
          method: 'PUT',
          upload_url: 'https://upload.example.invalid/signed?token=secret',
          upload_headers: [{ key: 'Content-Type', value: 'audio/mp4' }],
        },
      })
    }
    return jsonResponse({ success: true, task_id: 'task-1', request_id: 'request-1' })
  })

  const target = await requestMediaUploadTarget({ apiKey: 'secret', fetchImpl })
  assert.deepEqual(target, {
    fileReference: 'mediakit://file-1',
    method: 'PUT',
    uploadUrl: 'https://upload.example.invalid/signed?token=secret',
    headers: { 'Content-Type': 'audio/mp4' },
  })

  await submitMediaKitAsr({
    apiKey: 'secret',
    audioUrl: target.fileReference,
    clientToken: 'stable-token',
    confirmed: true,
    fetchImpl,
  })

  assert.deepEqual(JSON.parse(fetchImpl.mock.calls.at(-1).arguments[1].body), {
    audio_url: 'mediakit://file-1',
    content_type: 'speech',
    enable_speaker_info: true,
    enable_confidence: true,
    client_token: 'stable-token',
  })

  assert.deepEqual(
    sanitizeMediaUrl('https://cdn.example/a.m4s?deadline=123&token=secret'),
    { origin: 'https://cdn.example', pathname: '/a.m4s', queryKeys: ['deadline', 'token'] },
  )
})
```

Also test:

- upload response `result.file_id` with and without an existing `mediakit://` prefix;
- `upload_headers` array conversion without logging values;
- task states `running`, `completed`, and `failed`;
- nested and top-level MediaKit error shapes;
- `Retry-After` parsing;
- one stable `clientToken` across a simulated submit retry;
- rejection when `--confirm-paid-request` semantics are not represented by `confirmed: true`.

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/services/apis/volcengine-mediakit-probe.test.mjs
```

Expected: FAIL because the probe client does not exist.

- [ ] **Step 3: Implement the HTTP primitives**

Use this complete implementation as the starting point; keep the helper names unchanged so the
tests and diagnostic page share one contract:

```js
const BASE_URL = 'https://mediakit.cn-beijing.volces.com'
const UPLOAD_TARGET_PATH = '/api/v1/tools-sync/request-media-upload-url'
const ASR_PATH = '/api/v1/tools/asr-subtitles'

export class MediaKitProbeError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'MediaKitProbeError'
    Object.assign(this, details)
  }
}

function authorization(apiKey) {
  if (!apiKey) throw new MediaKitProbeError('MEDIAKIT_API_KEY_REQUIRED')
  return { Authorization: `Bearer ${apiKey}` }
}

async function readJson(response) {
  return response.json().catch(() => ({}))
}

function requestIdOf(response, data) {
  return data?.request_id || response.headers.get('x-request-id') || null
}

function assertSuccess(operation, response, data) {
  if (response.ok && data?.success !== false) return
  const providerError = data?.error || data
  throw new MediaKitProbeError(providerError?.message || `${response.status} ${response.statusText}`, {
    operation,
    httpStatus: response.status,
    providerCode: providerError?.code || null,
    requestId: requestIdOf(response, data),
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  })
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(60000, Math.max(0, seconds * 1000))
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.min(60000, Math.max(0, dateMs - now)) : null
}

export function sanitizeMediaUrl(input) {
  const url = new URL(input)
  return {
    origin: url.origin,
    pathname: url.pathname,
    queryKeys: [...new Set(url.searchParams.keys())].sort(),
  }
}

export async function requestMediaUploadTarget({ apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE_URL}${UPLOAD_TARGET_PATH}`, {
    method: 'POST',
    headers: authorization(apiKey),
  })
  const data = await readJson(response)
  assertSuccess('request-upload-target', response, data)
  const result = data.result || {}
  const rawFileId = String(result.file_id || '')
  if (!rawFileId || !result.upload_url || result.method !== 'PUT') {
    throw new MediaKitProbeError('INVALID_UPLOAD_TARGET_RESPONSE', {
      operation: 'request-upload-target',
      requestId: requestIdOf(response, data),
    })
  }
  return {
    fileReference: rawFileId.startsWith('mediakit://')
      ? rawFileId
      : `mediakit://${rawFileId}`,
    method: result.method,
    uploadUrl: result.upload_url,
    headers: Object.fromEntries(
      (result.upload_headers || []).map(({ key, value }) => [key, value]),
    ),
  }
}

export async function uploadMediaBlob({ target, blob, fetchImpl = fetch }) {
  const response = await fetchImpl(target.uploadUrl, {
    method: target.method,
    headers: target.headers,
    body: blob,
  })
  if (!response.ok) {
    throw new MediaKitProbeError(`${response.status} ${response.statusText}`, {
      operation: 'upload-media',
      httpStatus: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    })
  }
}

export async function submitMediaKitAsr({
  apiKey,
  audioUrl,
  clientToken,
  confirmed,
  fetchImpl = fetch,
}) {
  if (confirmed !== true) throw new MediaKitProbeError('PAID_REQUEST_NOT_CONFIRMED')
  if (!clientToken) throw new MediaKitProbeError('CLIENT_TOKEN_REQUIRED')
  const response = await fetchImpl(`${BASE_URL}${ASR_PATH}`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      content_type: 'speech',
      enable_speaker_info: true,
      enable_confidence: true,
      client_token: clientToken,
    }),
  })
  const data = await readJson(response)
  assertSuccess('submit-asr', response, data)
  if (!data.task_id) {
    throw new MediaKitProbeError('MISSING_MEDIAKIT_TASK_ID', {
      operation: 'submit-asr',
      requestId: requestIdOf(response, data),
    })
  }
  return { taskId: data.task_id, requestId: requestIdOf(response, data) }
}

export async function queryMediaKitTask({ apiKey, taskId, fetchImpl = fetch }) {
  const response = await fetchImpl(`${BASE_URL}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: authorization(apiKey),
  })
  const data = await readJson(response)
  assertSuccess('query-asr', response, data)
  return data
}

export async function pollMediaKitTask({
  apiKey,
  taskId,
  signal,
  fetchImpl = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  const delays = [5000, 10000, 20000, 30000]
  const deadline = now() + 2 * 60 * 60 * 1000
  let delayIndex = 0
  let consecutiveFailures = 0

  while (now() < deadline) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
    try {
      const data = await queryMediaKitTask({ apiKey, taskId, fetchImpl })
      consecutiveFailures = 0
      delayIndex = 0
      if (data.status === 'completed') return data.result
      if (data.status === 'failed') {
        throw new MediaKitProbeError(data.error?.message || 'MEDIAKIT_TASK_FAILED', {
          operation: 'query-asr',
          providerCode: data.error?.code || null,
          requestId: data.request_id || null,
        })
      }
    } catch (error) {
      const retryable =
        error instanceof TypeError ||
        error?.httpStatus === 429 ||
        [500, 503, 504].includes(error?.httpStatus)
      if (!retryable || ++consecutiveFailures > 5) throw error
      const retryDelay = error.retryAfterMs ?? delays[Math.min(delayIndex, delays.length - 1)]
      delayIndex += 1
      await wait(retryDelay)
      continue
    }
    await wait(delays[Math.min(delayIndex, delays.length - 1)])
    delayIndex += 1
  }
  throw new MediaKitProbeError('MEDIAKIT_TASK_TIMEOUT', { operation: 'query-asr' })
}
```

`requestMediaUploadTarget()` sends an empty-body POST with Bearer authorization. Normalize the
documented `result.file_id`, `result.method`, `result.upload_url`, and
`result.upload_headers[{key,value}]`. `uploadMediaBlob()` must use the returned method and headers
unchanged. `submitMediaKitAsr()` must throw `PAID_REQUEST_NOT_CONFIRMED` unless `confirmed === true`.

Implement a `MediaKitProbeError` carrying `operation`, `httpStatus`, `providerCode`, `requestId`,
and `retryAfterMs`; never attach the API key, response Authorization header, or signed URL.

- [ ] **Step 4: Implement bounded polling and tests**

Polling rules for the spike:

```js
const delays = [5000, 10000, 20000, 30000]
const maxConsecutiveFailures = 5
const deadlineMs = 2 * 60 * 60 * 1000
```

Honor `Retry-After` up to 60 seconds, abort immediately on `signal.aborted`, return completed
results, and throw structured failed-task and timeout errors. Unit tests inject `wait: async () =>
{}` so they do not sleep.

- [ ] **Step 5: Run the focused test**

Run the command from Step 2.

Expected: all MediaKit probe tests PASS without a network request.

- [ ] **Step 6: Commit the probe client**

```bash
git add src/services/apis/volcengine-mediakit-probe.mjs tests/unit/services/apis/volcengine-mediakit-probe.test.mjs
git commit -m "Add MediaKit feasibility probe client"
```

---

### Task 3: Add a development-only Chromium probe page

**Files:**
- Create: `src/content-script/site-adapters/bilibili/media-probe-bridge.mjs`
- Create: `src/pages/BilibiliMediaProbe/index.html`
- Create: `src/pages/BilibiliMediaProbe/index.mjs`
- Modify: `src/content-script/site-adapters/bilibili/index.mjs`
- Modify: `build.mjs:115-170,202-235,543-607`
- Modify: `package.json:5-22`
- Test: `tests/unit/content-script/bilibili-media-probe-bridge.test.mjs`

**Interfaces:**
- Consumes: Task 1 snapshot functions and Task 2 MediaKit probe client.
- Produces: a spike-only `BILIBILI_MEDIA_PROBE_SNAPSHOT` message and
  `BilibiliMediaProbe.html` when `--bilibili-media-spike` is passed to `build.mjs`.

- [ ] **Step 1: Write the failing bridge test**

Test a dependency-injected handler rather than a global listener:

```js
const playInfo = {
  data: {
    dash: {
      duration: 60,
      audio: [{ id: 30280, baseUrl: 'https://cdn.example.invalid/audio.m4s' }],
    },
  },
}
const handler = createBilibiliMediaProbeHandler({
  getUrl: () => 'https://www.bilibili.com/video/BV1abc123',
  loadHtml: async () => `<script>window.__playinfo__=${JSON.stringify(playInfo)}</script>`,
})

assert.equal(await handler({ type: 'OTHER' }), undefined)
const result = await handler({ type: 'BILIBILI_MEDIA_PROBE_SNAPSHOT' })
assert.equal(result.platform, 'bilibili')
assert.equal(result.videoId, 'BV1abc123')
assert.doesNotThrow(() => structuredClone(result))
```

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/content-script/bilibili-media-probe-bridge.test.mjs
```

Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Implement and conditionally register the bridge**

`createBilibiliMediaProbeHandler()` fetches `location.href` with credentials, parses it through
Task 1, and returns only the serializable snapshot. In `bilibili/index.mjs`, register the runtime
listener only under:

```js
import Browser from 'webextension-polyfill'
import { createBilibiliMediaProbeSnapshot } from './media-source.mjs'

export function createBilibiliMediaProbeHandler({
  getUrl = () => location.href,
  loadHtml = async () => (await fetch(location.href, { credentials: 'include' })).text(),
} = {}) {
  return async (message) => {
    if (message?.type !== 'BILIBILI_MEDIA_PROBE_SNAPSHOT') return undefined
    return createBilibiliMediaProbeSnapshot({ url: getUrl(), html: await loadHtml() })
  }
}

export function registerBilibiliMediaProbeBridge() {
  const handler = createBilibiliMediaProbeHandler()
  Browser.runtime.onMessage.addListener(handler)
  return () => Browser.runtime.onMessage.removeListener(handler)
}

// In bilibili/index.mjs:
if (globalThis.__BILIBILI_MEDIA_SPIKE__ === true) {
  import('./media-probe-bridge.mjs').then(({ registerBilibiliMediaProbeBridge }) => {
    registerBilibiliMediaProbeBridge()
  })
}
```

- [ ] **Step 4: Add spike-only build plumbing**

In `build.mjs`, derive both flags without platform-specific environment assignment:

```js
const enableBilibiliMediaSpike = process.argv.includes('--bilibili-media-spike')
const isWatchOnce =
  process.argv.includes('--watch-once') || getBooleanEnv(process.env.BUILD_WATCH_ONCE, false)
```

Add a `DefinePlugin` value for `globalThis.__BILIBILI_MEDIA_SPIKE__`. Add the
`BilibiliMediaProbe` entry only when enabled. Copy its JS, HTML, and development source map only
to the Chromium output. A normal production build must not contain the page.

Add this package script:

```json
"probe:bilibili-media": "node build.mjs --development --bilibili-media-spike --watch-once"
```

- [ ] **Step 5: Implement the probe page**

The page must:

1. query the active Bilibili tab;
2. request `BILIBILI_MEDIA_PROBE_SNAPSHOT`;
3. display only sanitized URL metadata from `sanitizeMediaUrl()`;
4. accept a MediaKit API key in a password input without saving it;
5. require a visible paid-request confirmation checkbox;
6. run direct URL submission/polling;
7. run local download into `video-summary-probe/media.bin` in OPFS;
8. install a temporary DNR session rule setting Bilibili Referer for the exact candidate host,
   remove it in `finally`, and record whether it was required;
9. report `Content-Length`, Range response, observed MIME type, bytes written, OPFS quota, and URL
   expiry without printing signed query values;
10. request an upload target, PUT the OPFS file, submit its normalized `mediakit://` reference,
    and poll ASR;
11. remove the OPFS probe directory after each run;
12. render a copyable sanitized JSON result containing pass/fail and error categories only.

Use this result shape so the research report can consume it without interpretation:

```js
{
  video: { durationMs, candidateContainer, candidateCodec, candidateBandwidth },
  source: {
    hasExpiry: true,
    contentLengthKnown: true,
    rangeSupported: true,
    fetchWithoutRefererRule: 'passed' | 'failed',
    fetchWithRefererRule: 'passed' | 'failed',
  },
  directMediaKit: { status: 'passed' | 'failed', errorCategory: null },
  localUpload: {
    status: 'passed' | 'failed',
    uploadedOriginalContainer: true,
    errorCategory: null,
  },
  opfs: { estimatedQuotaBytes, fileBytes, cleanupPassed: true },
}
```

Never render the raw media URL, API key, upload URL, transcript, or provider response body.

Implement OPFS transfer and temporary Referer handling with these focused helpers; keep the rule
ID and directory name probe-specific so cleanup cannot touch user data:

```js
const PROBE_RULE_ID = 910001
const PROBE_DIR = 'video-summary-probe'

async function setRefererRule(candidateUrl, enabled) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [PROBE_RULE_ID],
    addRules: enabled
      ? [
          {
            id: PROBE_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [
                {
                  header: 'Referer',
                  operation: 'set',
                  value: 'https://www.bilibili.com/',
                },
              ],
            },
            condition: {
              requestDomains: [new URL(candidateUrl).hostname],
              resourceTypes: ['xmlhttprequest'],
            },
          },
        ]
      : [],
  })
}

async function downloadCandidateToOpfs(candidate, useRefererRule) {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry(PROBE_DIR, { recursive: true }).catch(() => {})
  const directory = await root.getDirectoryHandle(PROBE_DIR, { create: true })
  const fileHandle = await directory.getFileHandle('media.bin', { create: true })
  if (useRefererRule) await setRefererRule(candidate.localFetchRecipe.primaryUrl, true)
  try {
    const response = await fetch(candidate.localFetchRecipe.primaryUrl, {
      credentials: candidate.localFetchRecipe.credentialMode,
    })
    if (!response.ok || !response.body) throw new Error(`MEDIA_DOWNLOAD_${response.status}`)
    const writable = await fileHandle.createWritable()
    await response.body.pipeTo(writable)
    const file = await fileHandle.getFile()
    return {
      file,
      contentLength: Number(response.headers.get('content-length')) || null,
      contentType: response.headers.get('content-type') || '',
      acceptRanges: response.headers.get('accept-ranges') || '',
    }
  } finally {
    if (useRefererRule) await setRefererRule(candidate.localFetchRecipe.primaryUrl, false)
  }
}

async function removeProbeDirectory() {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry(PROBE_DIR, { recursive: true }).catch(() => {})
}
```

The direct and upload buttons generate one `crypto.randomUUID()` per click and pass that unchanged
to `submitMediaKitAsr()`. The upload button calls `requestMediaUploadTarget()`,
`uploadMediaBlob()`, `submitMediaKitAsr()`, and `pollMediaKitTask()` in that order inside a
`try/finally` that always calls `removeProbeDirectory()`.

- [ ] **Step 6: Run unit tests and both build modes**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/content-script/bilibili-media-probe-bridge.test.mjs
npm run probe:bilibili-media
test -f build/chromium/BilibiliMediaProbe.html
npm run build
test ! -e build/chromium/BilibiliMediaProbe.html
```

Expected: the unit test passes; the spike page exists only after the spike build; the normal
production build succeeds and omits the probe page.

- [ ] **Step 7: Commit the development harness**

```bash
git add build.mjs package.json src/content-script/site-adapters/bilibili/index.mjs src/content-script/site-adapters/bilibili/media-probe-bridge.mjs src/pages/BilibiliMediaProbe tests/unit/content-script/bilibili-media-probe-bridge.test.mjs
git commit -m "Add Bilibili media feasibility harness"
```

---

### Task 4: Execute the real matrix and make the go/no-go decision

**Files:**
- Create: `docs/superpowers/research/2026-09-27-bilibili-media-feasibility.md`
- Modify only if evidence exposes a parser/client defect: files created in Tasks 1–3 and their focused tests.

**Interfaces:**
- Consumes: the development-only probe and a user-provided MediaKit key entered locally.
- Produces: a sanitized evidence report and an explicit `GO` or `NO-GO` decision that gates the product implementation plan.

- [ ] **Step 1: Prepare the local environment**

```bash
npm ci
npm run probe:bilibili-media
```

Load `build/chromium/` as an unpacked extension. Do not paste the MediaKit key into chat, source,
terminal history, screenshots, or the report.

- [ ] **Step 2: Open the diagnostic page**

Open a supported Bilibili video in the test profile. From the extension service-worker DevTools
console run:

```js
chrome.tabs.create({ url: chrome.runtime.getURL('BilibiliMediaProbe.html') })
```

The probe page discovers the active Bilibili tab. Enter the MediaKit key only in its password
field and confirm the paid request immediately before each ASR submission.

- [ ] **Step 3: Run the source matrix**

Use four videos that the profile may lawfully play:

- public video with native subtitles;
- public video without native subtitles;
- logged-in-accessible video without DRM or payment protection;
- multipart video with `p > 1`.

For each sample, record the sanitized probe result, whether candidate refresh works after expiry,
and whether the active page identity remains stable. Never record title, BV ID, full hostname,
query values, cookie values, or transcript text in the committed report.

- [ ] **Step 4: Run the transport matrix**

For each sample:

1. run direct MediaKit ingestion;
2. run OPFS local download without the temporary Referer rule;
3. run it with the temporary Referer rule;
4. if local download succeeds, upload the original container and run MediaKit ASR;
5. record whether the original M4S/MP4 audio is accepted;
6. remove the probe OPFS directory and confirm `cleanupPassed`.

Do not add FFmpeg during this task. A format rejection is evidence that the later implementation
plan must include a narrowly scoped remux/transcode experiment.

- [ ] **Step 5: Write the evidence report with a decision**

The report must contain completed sections—no empty fields—for:

```markdown
# Bilibili Media Feasibility Results

## Environment
- Browser and exact version
- Extension commit
- Test date

## Sanitized Sample Matrix
| Sample class | Source extraction | Local fetch | Direct MediaKit | Upload MediaKit | Cleanup |

## Request Requirements
- Whether Referer rule was required
- Whether cookies were required
- Whether Range and Content-Length were available
- Observed expiry behavior

## Format Findings
- Container and codec classes observed
- Original-container MediaKit acceptance
- Whether FFmpeg is required

## Resource Findings
- Largest file and OPFS quota ratio
- Page responsiveness observations

## Decision
GO or NO-GO, followed by evidence-based reasons and the single proven transport path.
```

Decision rules:

- `GO` requires source extraction and local fetch success for all four sample classes, successful
  MediaKit ASR through at least one reliable path, correct OPFS cleanup, and no credential/signed
  URL leakage.
- `NO-GO` is mandatory if source extraction or local fetch is unreliable, neither MediaKit path
  completes, required request context cannot be safely scoped, or OPFS usage is impractical.

- [ ] **Step 6: Run final repository validation**

```bash
npm run pretty
npm run lint
npm test
npm run build
test -f build/chromium/manifest.json
test -f build/firefox/manifest.json
test ! -e build/chromium/BilibiliMediaProbe.html
```

Expected: formatting, lint, tests, and production build pass; normal artifacts exist; the
development-only probe page is absent from production output.

- [ ] **Step 7: Commit the sanitized evidence**

If defects required code changes, stage only the focused source and test files plus the report.
Otherwise stage only the report:

```bash
git add docs/superpowers/research/2026-09-27-bilibili-media-feasibility.md
git commit -m "Document Bilibili media feasibility results"
```

- [ ] **Step 8: Gate the next plan**

- On `NO-GO`, stop and report which acceptance rule failed. Do not write the product implementation
  plan.
- On `GO`, update the approved design with the proven transport path and FFmpeg decision, then use
  `writing-plans` again to create the production implementation plan. Do not copy unproven fallback
  branches into that plan.
