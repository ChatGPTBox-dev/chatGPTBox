# Video Summary Protocol Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Increment 1 of the approved video-summary hardening design: canonical page identity, browser-rooted port authentication, Background-owned attempt fences, bounded replay/idempotency state, race-safe cancellation, and explicit Offscreen release/deletion.

**Architecture:** Pure protocol, authentication, coordinator, and runner boundaries are built and tested before any production transport uses them. Task F removes the old `START_TASK`/`RETRY_TASK` execution path in one atomic wiring change so Content, Background, and Offscreen switch together to the single `START_ATTEMPT` → `ATTEMPT_ACCEPTED` → `ATTEMPT_AUTHORIZED` protocol.

**Tech Stack:** Node.js 22+, ES modules, WebExtension MV3 APIs, `webextension-polyfill`, `node:test`, `node:assert/strict`, Webpack 5.

## Global Constraints

- Scope is Increment 1 only: canonical identity, authenticated ports, schemas, `activeSlots`, `retainedTasks`, `startRecords`, unified attempt start, execution release/task delete, replay, disconnect behavior, and tests.
- Enhanced summaries remain gated to the full Chromium MV3 build on Chrome/Edge 116+; Firefox, Safari, minimal builds, unsupported pages, and disabled settings retain the legacy path.
- Do not add dependencies, persistent jobs, persistent recovery, a general privileged proxy, a second request journal, restart tombstones, cleanup registries, or protocol transaction logs.
- Do not change media policy, polling, OPFS quota policy, page-mode UI behavior, summary quality, Markdown sinks, provider adapters, or localization in this increment.
- No temporary dual protocol ships: Task F replaces the old production protocol atomically after Tasks A–E are independently green.
- Adapters own page identity, source discovery, refresh, and seek; Background authenticates contexts, allocates fences, owns one execution slot per `(tabId, platform)`, and authorizes attempts; Offscreen executes ephemeral attempts and owns checkpoints.
- Bilibili identity is exactly `{ platform: 'bilibili', videoId: '<BVID>', mediaId: '<CID>' }`; YouTube identity is exactly `{ platform: 'youtube', videoId: '<video-id>', mediaId: '<video-id>' }`.
- Source snapshots contain one nested `pageIdentity` exactly equal to the command identity; protocol messages do not duplicate `platform`, `videoId`, or `mediaId` at top level.
- Background derives `{ tabId, documentId, platform, mediaId }` from authenticated sender metadata plus validated `pageIdentity`; caller-supplied owner, generation, attempt, headers, and credentials are rejected.
- Every fence is exactly `{ owner, taskId, generation, attempt }`; only Background allocates positive integer `generation` and `attempt`.
- A Background or Offscreen restart fails local work with `VIDEO_SUMMARY_RUNTIME_RESTARTED`; it never resumes work.
- Content ports require matching extension ID, integer tab ID, non-empty document ID, `frameId === 0`, HTTPS Bilibili/YouTube URL, and platform/origin agreement; reject before creating Offscreen.
- The Offscreen port requires matching extension ID, no sender tab, and exact `runtime.getURL('VideoSummaryOffscreen.html')`; port name alone is insufficient.
- On Background initialization, close an existing video-summary Offscreen document before accepting video-summary ports; do not add a nonce or `runtime.getContexts()` document-ID cross-match.
- Protocol limits are exact: IDs/codes/operation names 128 UTF-16 code units; title/label 1,000; one cue 20,000; 20,000 cues; total subtitle text 16 MiB; 16 media candidates; 32 upload headers with 256 code units per key/value; serialized content command 24 MiB; 16 pending RPCs per task.
- Start records are capped at 128 per document; terminal records expire after 15 minutes; pending records and their cancellation markers are never evicted.
- Retained tasks are capped at 32 and total serialized replay state at 16 MiB; live state is rejected rather than evicted; one bounded `replayEvent` is retained per task.
- Attempt acceptance, execution release, and task deletion watchdogs are 10 seconds; same-document/same-media disconnect grace is 15 seconds; retained terminal/retryable state expires 15 minutes after attempt terminal time.
- `EXECUTION_RELEASED` removes attempt resources and the active slot only; only `DELETE_TASK`/`TASK_DELETED` removes the generation checkpoint and retained task.
- Explicit cancellation revokes the generation before aborting the active attempt; deletion marks retained state `deleting` before sending `DELETE_TASK`.
- Preserve structured-clone-safe messages and never send provider credentials, arbitrary headers, DOM values, callbacks, or `AbortSignal` objects across ports.
- Follow repository formatting: two spaces, single quotes, no semicolons, trailing commas, 100-column width; do not add code comments.
- Every task must run its focused command and commit only the files listed for that task.

---

### Task A: Pure Canonical Protocol Module

**Files:**
- Create: `src/video-summary/protocol.mjs`
- Create: `tests/unit/video-summary/protocol.test.mjs`

**Interfaces:**
- Consumes: no browser APIs and no mutable application state.
- Produces:
  ```js
  VIDEO_SUMMARY_PROTOCOL_LIMITS
  VIDEO_SUMMARY_CONTENT_COMMAND_TYPES
  VIDEO_SUMMARY_OFFSCREEN_COMMAND_TYPES
  VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES
  createPageIdentity({ platform, videoId, mediaId })
  parsePageIdentity(value)
  pageIdentitiesEqual(left, right)
  createVideoSummaryOwner({ tabId, documentId, platform, mediaId })
  ownersEqual(left, right)
  createTaskFence({ owner, taskId, generation, attempt })
  fencesEqual(left, right)
  parseContentCommand(value)
  parseContentMessage(value)
  parseOffscreenCommand(value)
  parseOffscreenMessage(value)
  hashStartRequest({ pageIdentity, sourceChoice, subtitleTrackId, sourceSnapshot, settingsSnapshot, modelSnapshot })
  hashRetryRequest({ fromStage, modelSnapshot })
  measureSerializedBytes(value)
  ```
- `parseContentCommand` returns a newly allocated normalized plain object for `START_TASK`, `CANCEL_START`, `ATTACH_TASK`, `CANCEL_TASK`, `RETRY_TASK`, and `SOURCE_REFRESH_RESULT`.
- `parseContentMessage` returns normalized Background→Content `START_ACK`, `CANCEL_START_ACK`, `ATTACH_ACK`, `RETRY_ACK`, `TASK_EVENT`, and `SOURCE_REFRESH_REQUEST` objects; ACK status determines whether fence/event/errorCode is required or forbidden.
- `parseOffscreenCommand` returns a newly allocated normalized plain object for `START_ATTEMPT`, `ATTEMPT_AUTHORIZED`, `CANCEL_TASK`, `EXECUTION_RELEASED_ACK`, `DELETE_TASK`, `SOURCE_REFRESH_RESULT`, and `GATEWAY_RESPONSE`.
- `parseOffscreenMessage` returns a newly allocated normalized plain object for `ATTEMPT_ACCEPTED`, `ATTEMPT_REJECTED`, `TASK_EVENT`, `EXECUTION_RELEASED`, `TASK_DELETED`, `SOURCE_REFRESH_REQUEST`, and `GATEWAY_REQUEST`.
- Hash functions return lowercase SHA-256 hex strings over recursively key-sorted JSON; `undefined` object properties are omitted and array order is preserved.

- [ ] **Step 1: Write the identity, fence, allowlist, and deterministic-hash RED tests**

Create `tests/unit/video-summary/protocol.test.mjs` with these imports and tests:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VIDEO_SUMMARY_PROTOCOL_LIMITS,
  createPageIdentity,
  createTaskFence,
  createVideoSummaryOwner,
  fencesEqual,
  hashRetryRequest,
  pageIdentitiesEqual,
  parseContentCommand,
  parseContentMessage,
  parseOffscreenCommand,
  parseOffscreenMessage,
} from '../../../src/video-summary/protocol.mjs'

const youtubeIdentity = Object.freeze({
  platform: 'youtube',
  videoId: 'abcdefghijk',
  mediaId: 'abcdefghijk',
})

function createStart(overrides = {}) {
  return {
    type: 'START_TASK',
    requestId: 'start-1',
    taskId: 'task-1',
    pageIdentity: youtubeIdentity,
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity: youtubeIdentity,
      title: 'Title',
      durationMs: 10_000,
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          language: 'en',
          label: 'English',
          sourceKind: 'author',
          cues: [{ startMs: 0, endMs: 1_000, text: 'hello' }],
        },
      ],
      mediaCandidates: [],
    },
    settingsSnapshot: {
      preferredLanguage: 'en',
      speakerIdentification: true,
      summaryMaxOutputTokens: 4_000,
      asrConfirmed: false,
    },
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
    ...overrides,
  }
}

test('canonical identities distinguish Bilibili multipart media', () => {
  const p1 = createPageIdentity({ platform: 'bilibili', videoId: 'BV1test', mediaId: '100' })
  const p2 = createPageIdentity({ platform: 'bilibili', videoId: 'BV1test', mediaId: '200' })
  assert.equal(pageIdentitiesEqual(p1, p2), false)
  assert.deepEqual(p1, { platform: 'bilibili', videoId: 'BV1test', mediaId: '100' })
})

test('owners and fences contain only authoritative identity fields', () => {
  const owner = createVideoSummaryOwner({
    tabId: 7,
    documentId: 'doc-7',
    platform: 'youtube',
    mediaId: 'abcdefghijk',
  })
  const fence = createTaskFence({ owner, taskId: 'task-1', generation: 2, attempt: 3 })
  assert.deepEqual(fence, { owner, taskId: 'task-1', generation: 2, attempt: 3 })
  assert.equal(fencesEqual(fence, structuredClone(fence)), true)
  assert.throws(
    () => createTaskFence({ owner, taskId: 'task-1', generation: 0, attempt: 1 }),
    /VIDEO_SUMMARY_GENERATION_INVALID/,
  )
})

test('content parser rejects caller-owned authority and unknown fields', () => {
  for (const forbidden of [
    { owner: { tabId: 99 } },
    { generation: 1 },
    { attempt: 1 },
    { platform: 'youtube' },
    { videoId: 'abcdefghijk' },
    { headers: { Authorization: 'secret' } },
  ]) {
    assert.throws(
      () => parseContentCommand(createStart(forbidden)),
      /VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED/,
    )
  }
})

test('snapshot identity must exactly equal command identity', () => {
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...createStart().sourceSnapshot,
            pageIdentity: { ...youtubeIdentity, mediaId: 'other-video' },
          },
        }),
      ),
    /VIDEO_SUMMARY_PAGE_IDENTITY_MISMATCH/,
  )
})

test('retry hashes normalize object key order but bind stage and model identity', async () => {
  const first = await hashRetryRequest({
    fromStage: 'synthesis',
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
  })
  const reordered = await hashRetryRequest({
    modelSnapshot: { apiMode: null, modelName: 'gpt-4o-mini' },
    fromStage: 'synthesis',
  })
  const changed = await hashRetryRequest({
    fromStage: 'summarizing',
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
  })
  assert.equal(first, reordered)
  assert.notEqual(first, changed)
  assert.match(first, /^[0-9a-f]{64}$/)
})

test('all parser families reject arrays and unsupported message types', () => {
  assert.throws(() => parseContentCommand([]), /VIDEO_SUMMARY_PROTOCOL_OBJECT_REQUIRED/)
  assert.throws(
    () => parseOffscreenCommand({ type: 'START_TASK' }),
    /VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED/,
  )
  assert.throws(
    () => parseOffscreenMessage({ type: 'RETRY_TASK' }),
    /VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED/,
  )
  assert.equal(VIDEO_SUMMARY_PROTOCOL_LIMITS.idCodeUnits, 128)
})
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/protocol.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/video-summary/protocol.mjs`; zero tests pass.

- [ ] **Step 3: Implement strict constructors, equality, and message schemas**

Implement `src/video-summary/protocol.mjs` as a browser-independent module. Use `Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null` for plain-object checks, `Object.keys` for exact field allowlists, and `structuredClone` before returning parsed values. Enforce these exact shapes:

```js
START_TASK = {
  type,
  requestId,
  taskId,
  pageIdentity,
  sourceChoice: 'native-subtitle' | 'asr',
  subtitleTrackId?,
  sourceSnapshot,
  settingsSnapshot,
  modelSnapshot,
}
CANCEL_START = { type, cancelRequestId, targetStartRequestId, taskId, pageIdentity }
ATTACH_TASK = { type, taskId, generation, pageIdentity }
CANCEL_TASK = { type, taskId, generation, pageIdentity }
RETRY_TASK = { type, requestId, taskId, generation, pageIdentity, fromStage, modelSnapshot }
SOURCE_REFRESH_RESULT = {
  type,
  requestId,
  taskId,
  generation,
  pageIdentity,
  pageGeneration,
  sourceSnapshot?,
  errorCode?,
}
START_ACK = { type, requestId, taskId, status: 'started' | 'cancelled' | 'cancelling' | 'rejected', fence?, errorCode? }
CANCEL_START_ACK = { type, cancelRequestId, targetStartRequestId, status: 'cancelled' | 'cancelling', fence? }
ATTACH_ACK = { type, requestId, status: 'active' | 'retryable' | 'terminal' | 'not-found', fence?, event?, errorCode? }
RETRY_ACK = { type, requestId, status: 'started' | 'cancelled' | 'rejected', fence?, errorCode? }
SOURCE_REFRESH_REQUEST = { type, requestId, fence, expectedPageIdentity, reason }
START_ATTEMPT = { type, requestId, fence, mode: 'initial' | 'retry-summary', payload }
ATTEMPT_AUTHORIZED = { type, requestId, fence }
DELETE_TASK = { type, owner, taskId, generation }
EXECUTION_RELEASED_ACK = { type, fence }
ATTEMPT_ACCEPTED = { type, requestId, fence }
ATTEMPT_REJECTED = { type, requestId, fence, errorCode }
EXECUTION_RELEASED = { type, fence }
TASK_DELETED = { type, owner, taskId, generation }
TASK_EVENT = { type, fence, event }
GATEWAY_REQUEST = { type, requestId, fence, gateway, operation, args }
GATEWAY_RESPONSE = { type, requestId, fence, ok, result? | error? }
```

`TASK_EVENT.event` may contain only `type`, `stage`, `checkpointAvailable`, `completedChunks`, `totalChunks`, `result`, `errorCode`, and `message`; the outer fence supplies identity. Require exactly one of `result`/`error` according to `ok`, and exactly one of `sourceSnapshot`/`errorCode` for refresh results. Accept retry stages only `summarizing` and `synthesis`.

- [ ] **Step 4: Add aggregate and per-field RED tests**

Append these tests to `tests/unit/video-summary/protocol.test.mjs`:

```js
test('protocol enforces all content aggregate limits before privileged work', () => {
  const overlongId = 'x'.repeat(129)
  const tooManyCues = Array.from({ length: 20_001 }, (_, index) => ({
    startMs: index,
    endMs: index + 1,
    text: 'x',
  }))
  const tooManyCandidates = Array.from({ length: 17 }, (_, index) => ({
    id: String(index),
    mediaMetadata: { kind: 'audio', durationMs: 10_000 },
    remoteCandidate: { url: `https://r${index}.googlevideo.com/audio`, expiresAt: null },
    localFetchRecipe: null,
  }))

  assert.throws(
    () => parseContentCommand(createStart({ requestId: overlongId })),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...createStart().sourceSnapshot,
            nativeSubtitleTracks: [
              { id: 'track-1', language: 'en', label: 'English', sourceKind: 'author', cues: tooManyCues },
            ],
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: { ...createStart().sourceSnapshot, mediaCandidates: tooManyCandidates },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
})

test('protocol enforces cue, total subtitle, header, and serialized command limits', () => {
  const sourceSnapshot = createStart().sourceSnapshot
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...sourceSnapshot,
            nativeSubtitleTracks: [
              {
                id: 'track-1',
                language: 'en',
                label: 'English',
                sourceKind: 'author',
                cues: [{ startMs: 0, endMs: 1, text: 'x'.repeat(20_001) }],
              },
            ],
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )

  const sixteenMiB = 16 * 1024 * 1024
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...sourceSnapshot,
            nativeSubtitleTracks: [
              {
                id: 'track-1',
                language: 'en',
                label: 'English',
                sourceKind: 'author',
                cues: Array.from({ length: 1_000 }, () => ({
                  startMs: 0,
                  endMs: 1,
                  text: 'x'.repeat(Math.floor(sixteenMiB / 1_000) + 1),
                })),
              },
            ],
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )

  assert.throws(
    () =>
      parseContentCommand(
        createStart({ settingsSnapshot: { ...createStart().settingsSnapshot, blob: 'x'.repeat(24 * 1024 * 1024) } }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_(FIELD_UNSUPPORTED|LIMIT_EXCEEDED)/,
  )
})
```

Also add table-driven valid/invalid tests for every message shape listed in Step 3, including 1,001-character titles/labels, 33 upload headers, and 257-character header keys/values in Offscreen gateway messages. Each excess must throw `VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED`; unknown keys must throw `VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED`.

- [ ] **Step 5: Complete hashing and aggregate validation, then run the focused test**

Use `crypto.subtle.digest('SHA-256', bytes)` with Node's global Web Crypto, a recursive key-sorter, `TextEncoder`, and `JSON.stringify`. Count protocol text limits in JavaScript `.length` UTF-16 code units; use encoded byte length only for the 16 MiB subtitle aggregate, 24 MiB command aggregate, and replay byte accounting.

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/protocol.test.mjs
```

Expected: PASS; all protocol tests pass with zero failures.

- [ ] **Step 6: Format and commit Task A**

Run:

```bash
npx prettier --write src/video-summary/protocol.mjs tests/unit/video-summary/protocol.test.mjs
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/protocol.test.mjs
git add src/video-summary/protocol.mjs tests/unit/video-summary/protocol.test.mjs
git commit -m "Define hardened video summary protocol"
```

Expected: Prettier exits 0; focused tests pass; commit contains exactly the two Task A files.

### Task B: Adapter Page Identity Only

**Files:**
- Modify: `src/content-script/site-adapters/bilibili/media-source.mjs:3-8,128-162`
- Modify: `src/content-script/site-adapters/bilibili/video-page-bridge.mjs:37-75,177-222`
- Modify: `src/content-script/site-adapters/youtube/media-source.mjs:4-10`
- Modify: `src/content-script/site-adapters/youtube/video-page-bridge.mjs:75-238,333-415`
- Modify: `tests/unit/content-script/bilibili-media-source.test.mjs`
- Modify: `tests/unit/content-script/bilibili-video-page-bridge.test.mjs`
- Modify: `tests/unit/content-script/youtube-media-source.test.mjs`
- Modify: `tests/unit/content-script/youtube-video-page-bridge.test.mjs`

**Interfaces:**
- Consumes: `createPageIdentity` and `pageIdentitiesEqual` from Task A.
- Produces from both bridges:
  ```js
  getCurrentPageIdentity() -> PageIdentity | null
  getSnapshot() -> Promise<SourceSnapshot>
  refreshSnapshot({ expectedPageIdentity, pageGeneration, signal? }) -> Promise<SourceSnapshot>
  subscribeToVideoChanges((pageIdentity: PageIdentity | null) => void) -> () => void
  ```
- Every returned `SourceSnapshot` adds canonical `pageIdentity` while retaining the current top-level `platform`, `videoId`, and `pageId` only as temporary compatibility fields through Tasks B–E; Task F removes them atomically with Content/Background migration.
- `pageGeneration` is accepted and returned as refresh correlation metadata but is not part of `PageIdentity` or a task fence.

- [ ] **Step 1: Write the Bilibili multipart and nested-snapshot RED tests**

Add these assertions to the existing Bilibili test files, reusing their existing valid HTML/play-info fixture builders:

```js
test('Bilibili P1 and P2 share BVID but have distinct canonical media identity', () => {
  const initialState = {
    videoData: {
      bvid: 'BV1multi',
      owner: { mid: 7 },
      pages: [
        { page: 1, cid: 101, duration: 10 },
        { page: 2, cid: 202, duration: 20 },
      ],
    },
  }
  const p1 = resolveBilibiliSelectedPageMetadata({
    url: 'https://www.bilibili.com/video/BV1multi?p=1',
    initialState,
  })
  const p2 = resolveBilibiliSelectedPageMetadata({
    url: 'https://www.bilibili.com/video/BV1multi?p=2',
    initialState,
  })
  assert.deepEqual(p1.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BV1multi',
    mediaId: '101',
  })
  assert.deepEqual(p2.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BV1multi',
    mediaId: '202',
  })
  assert.notDeepEqual(p1.pageIdentity, p2.pageIdentity)
})

function createValidBilibiliSourceFixture() {
  return {
    url: 'https://www.bilibili.com/video/BV1fixture?p=1',
    html: createInitialStateHtml({ bvid: 'BV1fixture', cid: 101 }),
    loadPlayurl: async () => createPlayurlResponse({ bvid: 'BV1fixture', cid: 101 }),
    loadPlayerInfo: async () => ({ data: { subtitle: { subtitles: [] } } }),
    loadSubtitleBody: async () => ({ body: [] }),
    loadAiConclusion: async () => null,
  }
}

test('Bilibili snapshot carries identity only in pageIdentity', async () => {
  const snapshot = await resolveBilibiliSourceSnapshot(createValidBilibiliSourceFixture())
  assert.deepEqual(snapshot.pageIdentity, {
    platform: 'bilibili',
    videoId: 'BV1fixture',
    mediaId: '101',
  })
  assert.equal(snapshot.platform, 'bilibili')
  assert.equal(snapshot.videoId, 'BV1fixture')
  assert.equal(snapshot.pageId, 101)
})
```

In the bridge test, add a deferred fetch test that starts P1 extraction, changes the URL to P2 before the promise resolves, and expects `VIDEO_SOURCE_IDENTITY_CHANGED`. The test must assert `getCurrentPageIdentity()` changes from CID `101` to CID `202` even though BVID is unchanged.

- [ ] **Step 2: Write the YouTube nested identity and stale-refresh RED tests**

Add these tests using existing YouTube fixture helpers:

```js
test('YouTube watch identity uses the video id as media id', () => {
  assert.deepEqual(getYouTubeWatchIdentity('https://www.youtube.com/watch?v=abcdefghijk'), {
    supported: true,
    pageIdentity: {
      platform: 'youtube',
      videoId: 'abcdefghijk',
      mediaId: 'abcdefghijk',
    },
  })
})

function createValidYouTubeSourceFixture() {
  return {
    expectedVideoId: 'abcdefghijk',
    playerResponse: createPlayerResponse('abcdefghijk'),
    pageHtml: '',
    captureCaption: async () => null,
    readTranscriptPanel: async () => null,
    readInnertubeTranscript: async () => null,
  }
}

test('YouTube snapshot does not duplicate identity fields', async () => {
  const snapshot = await resolveYouTubeSourceSnapshot(createValidYouTubeSourceFixture())
  assert.deepEqual(snapshot.pageIdentity, {
    platform: 'youtube',
    videoId: 'abcdefghijk',
    mediaId: 'abcdefghijk',
  })
  assert.equal(snapshot.platform, 'youtube')
  assert.equal(snapshot.videoId, 'abcdefghijk')
  assert.equal(snapshot.pageId, 'abcdefghijk')
})
```

Add a bridge test that starts a refresh for `abcdefghijk`, changes the location to `lmnopqrstuv` at each existing asynchronous fixture boundary (`getPlayerResponse`, HTML fallback, caption capture, panel transcript, Innertube transcript, and replay fetch), and asserts every branch rejects with `VIDEO_SOURCE_IDENTITY_CHANGED` rather than returning stale data.

- [ ] **Step 3: Run adapter tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs
```

Expected: FAIL because snapshots lack canonical nested `pageIdentity`, Bilibili metadata does not expose CID as `mediaId`, and bridges lack `getCurrentPageIdentity()`.

- [ ] **Step 4: Implement canonical identity without changing transport or UI**

Import Task A helpers in both adapters. Keep Bilibili `pageNumber` only in local extraction metadata; derive protocol identity from resolved BVID and CID. For every await in both bridges, capture the starting `PageIdentity` and verify `pageIdentitiesEqual(startingIdentity, getCurrentPageIdentity())` immediately after the await and before using the result. On mismatch, throw `VIDEO_SOURCE_IDENTITY_CHANGED`.

Return snapshots with canonical `pageIdentity` plus the existing top-level identity compatibility fields required by the current host:

```js
{
  pageIdentity,
  platform: pageIdentity.platform,
  videoId: pageIdentity.videoId,
  pageId: pageIdentity.mediaId,
  title,
  durationMs,
  nativeSubtitleTracks,
  subtitleDiscovery,
  mediaCandidates,
}
```

Task F removes `platform`, `videoId`, and `pageId` atomically after every production consumer reads `pageIdentity`.

`refreshSnapshot` must reject unless `expectedPageIdentity` equals the identity before extraction and after extraction. If supplied, return `pageGeneration` unchanged as a sibling field on the refresh result; do not persist it in the source snapshot.

- [ ] **Step 5: Run focused tests and adapter regressions**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/bilibili-adapter.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-adapter.test.mjs
```

Expected: PASS; P1/P2 are distinct, stale async reads fail, and all six adapter tests have zero failures.

- [ ] **Step 6: Format and commit Task B**

Run:

```bash
npx prettier --write \
  src/content-script/site-adapters/bilibili/media-source.mjs \
  src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  src/content-script/site-adapters/youtube/media-source.mjs \
  src/content-script/site-adapters/youtube/video-page-bridge.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs
git add \
  src/content-script/site-adapters/bilibili/media-source.mjs \
  src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  src/content-script/site-adapters/youtube/media-source.mjs \
  src/content-script/site-adapters/youtube/video-page-bridge.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs
git commit -m "Use canonical video page identity"
```

Expected: focused tests pass; commit contains only adapter identity implementation and tests.

### Task C: Port Authentication Helpers and Offscreen Reset Only

**Files:**
- Create: `src/background/video-summary-port-auth.mjs`
- Create: `tests/unit/background/video-summary-port-auth.test.mjs`
- Modify: `src/background/offscreen.mjs:8-63`
- Create: `tests/unit/background/offscreen.test.mjs`

**Interfaces:**
- Consumes: `VIDEO_SUMMARY_OFFSCREEN_PATH` from `src/video-summary/contracts.mjs` and `parsePageIdentity` from Task A.
- Produces:
  ```js
  authenticateVideoSummaryContentPort({ port, runtime, pageIdentity })
    -> { tabId, documentId, frameId: 0, pageIdentity, owner }
  authenticateVideoSummaryOffscreenPort({ port, runtime })
    -> { documentUrl }
  closeVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) -> Promise<boolean>
  resetVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) -> Promise<void>
  ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) -> Promise<void>
  ```
- This task does not modify `video-summary-router.mjs`, `video-summary-offscreen-rpc.mjs`, or `background/index.mjs`; Task F wires these helpers.

- [ ] **Step 1: Write complete content/offscreen authentication RED tests**

Create `tests/unit/background/video-summary-port-auth.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticateVideoSummaryContentPort,
  authenticateVideoSummaryOffscreenPort,
} from '../../../src/background/video-summary-port-auth.mjs'

const runtime = {
  id: 'extension-id',
  getURL(path) {
    return `chrome-extension://extension-id/${path}`
  },
}
const bilibiliIdentity = {
  platform: 'bilibili',
  videoId: 'BV1auth',
  mediaId: '101',
}
const validContentSender = {
  id: 'extension-id',
  tab: { id: 7 },
  documentId: 'doc-7',
  frameId: 0,
  url: 'https://www.bilibili.com/video/BV1auth?p=1',
}

function contentPort(sender = validContentSender) {
  return { name: 'video-summary', sender }
}

test('content authentication derives owner from browser sender and page identity', () => {
  assert.deepEqual(
    authenticateVideoSummaryContentPort({
      port: contentPort(),
      runtime,
      pageIdentity: bilibiliIdentity,
    }),
    {
      tabId: 7,
      documentId: 'doc-7',
      frameId: 0,
      pageIdentity: bilibiliIdentity,
      owner: { tabId: 7, documentId: 'doc-7', platform: 'bilibili', mediaId: '101' },
    },
  )
})

test('content authentication rejects every forged browser context', () => {
  const invalidSenders = [
    { ...validContentSender, id: 'other-extension' },
    { ...validContentSender, tab: undefined },
    { ...validContentSender, tab: { id: 1.5 } },
    { ...validContentSender, documentId: '' },
    { ...validContentSender, frameId: undefined },
    { ...validContentSender, frameId: 1 },
    { ...validContentSender, url: 'http://www.bilibili.com/video/BV1auth' },
    { ...validContentSender, url: 'https://evil.example/video/BV1auth' },
  ]
  for (const sender of invalidSenders) {
    assert.throws(
      () =>
        authenticateVideoSummaryContentPort({
          port: contentPort(sender),
          runtime,
          pageIdentity: bilibiliIdentity,
        }),
      /VIDEO_SUMMARY_CONTENT_PORT_UNAUTHORIZED/,
    )
  }
})

test('content platform must match exact allowed origin', () => {
  assert.throws(
    () =>
      authenticateVideoSummaryContentPort({
        port: contentPort(),
        runtime,
        pageIdentity: {
          platform: 'youtube',
          videoId: 'abcdefghijk',
          mediaId: 'abcdefghijk',
        },
      }),
    /VIDEO_SUMMARY_CONTENT_PORT_UNAUTHORIZED/,
  )
  assert.doesNotThrow(() =>
    authenticateVideoSummaryContentPort({
      port: contentPort({
        ...validContentSender,
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
      }),
      runtime,
      pageIdentity: {
        platform: 'youtube',
        videoId: 'abcdefghijk',
        mediaId: 'abcdefghijk',
      },
    }),
  )
})

test('offscreen authentication requires exact extension document identity', () => {
  const valid = {
    name: 'video-summary-offscreen',
    sender: {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/VideoSummaryOffscreen.html',
    },
  }
  assert.deepEqual(authenticateVideoSummaryOffscreenPort({ port: valid, runtime }), {
    documentUrl: runtime.getURL('VideoSummaryOffscreen.html'),
  })
  for (const sender of [
    { ...valid.sender, id: 'other-extension' },
    { ...valid.sender, tab: { id: 7 } },
    { ...valid.sender, url: 'chrome-extension://extension-id/popup.html' },
    { ...valid.sender, url: 'https://www.bilibili.com/' },
  ]) {
    assert.throws(
      () => authenticateVideoSummaryOffscreenPort({ port: { ...valid, sender }, runtime }),
      /VIDEO_SUMMARY_OFFSCREEN_PORT_UNAUTHORIZED/,
    )
  }
})
```

- [ ] **Step 2: Write stale Offscreen close/reset RED tests**

Create `tests/unit/background/offscreen.test.mjs` with a fake `runtime.getContexts`, `runtime.getURL`, and `chromeOffscreen` and add:

```js
test('close removes an existing matching Offscreen document', async () => {
  const calls = []
  const runtime = createRuntime([
    {
      contextType: 'OFFSCREEN_DOCUMENT',
      documentUrl: 'chrome-extension://extension-id/VideoSummaryOffscreen.html',
    },
  ])
  const closed = await closeVideoSummaryOffscreenDocument({
    runtime,
    chromeOffscreen: { async closeDocument() { calls.push('close') } },
  })
  assert.equal(closed, true)
  assert.deepEqual(calls, ['close'])
})

test('reset closes stale state and creates one fresh document', async () => {
  const calls = []
  const runtime = createRuntime([
    {
      contextType: 'OFFSCREEN_DOCUMENT',
      documentUrl: 'chrome-extension://extension-id/VideoSummaryOffscreen.html',
    },
  ])
  await resetVideoSummaryOffscreenDocument({
    runtime,
    chromeOffscreen: {
      async closeDocument() { calls.push('close') },
      async createDocument(options) { calls.push(['create', options]) },
    },
  })
  assert.equal(calls[0], 'close')
  assert.deepEqual(calls[1], [
    'create',
    {
      url: 'VideoSummaryOffscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Run the enhanced video summary task lifecycle.',
    },
  ])
})
```

The `createRuntime(contexts)` helper must return the provided contexts once, then no contexts after `closeDocument`; also test no existing document returns `false`, concurrent ensure calls create once, missing APIs return stable `VIDEO_SUMMARY_*_UNAVAILABLE` errors, and close failure propagates without creation.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/video-summary-port-auth.test.mjs \
  tests/unit/background/offscreen.test.mjs
```

Expected: FAIL because the authentication module and close/reset exports do not exist.

- [ ] **Step 4: Implement pure sender authentication**

Parse sender URLs with `new URL`. Accept Bilibili only when `hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')`; accept YouTube only when `hostname === 'youtube.com' || hostname.endsWith('.youtube.com')`; require `protocol === 'https:'`. Do not trust `sender.origin` when `sender.url`/`sender.documentUrl` is absent. Trim `documentId`, reject empty values, and construct owner only from sender tab/document plus parsed platform/media ID.

- [ ] **Step 5: Implement close/reset serialization**

Keep one module-scoped promise for creation and one for reset. `closeVideoSummaryOffscreenDocument` checks exact `runtime.getURL(VIDEO_SUMMARY_OFFSCREEN_PATH)` contexts, calls `chromeOffscreen.closeDocument()` only when present, and returns whether it closed. `resetVideoSummaryOffscreenDocument` waits for pending creation, closes, then calls ensure; concurrent resets share one promise. Use the exact justification asserted by the test.

- [ ] **Step 6: Run focused tests and commit Task C**

Run:

```bash
npx prettier --write \
  src/background/video-summary-port-auth.mjs \
  src/background/offscreen.mjs \
  tests/unit/background/video-summary-port-auth.test.mjs \
  tests/unit/background/offscreen.test.mjs
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/video-summary-port-auth.test.mjs \
  tests/unit/background/offscreen.test.mjs
git add \
  src/background/video-summary-port-auth.mjs \
  src/background/offscreen.mjs \
  tests/unit/background/video-summary-port-auth.test.mjs \
  tests/unit/background/offscreen.test.mjs
git commit -m "Authenticate video summary contexts"
```

Expected: both focused files pass; commit contains exactly the four Task C files.

### Task D: Pure Background Coordinator with Complete Lifecycle State

**Files:**
- Create: `src/background/video-summary-coordinator.mjs`
- Create: `tests/unit/background/video-summary-coordinator.test.mjs`

**Interfaces:**
- Consumes: Task A parsers/equality/hash/size helpers and an already authenticated content context from Task C.
- Produces:
  ```js
  createVideoSummaryCoordinator({
    clock,
    ensureOffscreen,
    sendOffscreen,
    sendContent,
    resetOffscreen,
  })
  ```
- Returned methods:
  ```js
  handleContentCommand({ context, port, command }) -> Promise<void>
  handleOffscreenMessage(message) -> void
  handleContentDisconnect({ context, port }) -> void
  handleTabRemoved(tabId) -> void
  handleOffscreenDisconnect() -> void
  debugState() -> structured-cloned readonly snapshot
  ```
- Injected `clock` is exactly `{ now, setTimeout, clearTimeout }`. `sendOffscreen` and `sendContent` are synchronous functions. `ensureOffscreen` and `resetOffscreen` return promises.
- Internal state is exactly four primary collections: `activeSlots`, `retainedTasks`, `startRecords`, and `capabilities`, plus one scalar `nextGeneration` integer. Initial starts allocate `generation = nextGeneration++`, so deleting every slot/retained record cannot reuse a generation during the Background lifetime. Timer handles and pending promise resolvers are fields of records, not additional journals.

- [ ] **Step 1: Build a deterministic coordinator harness and RED tests for slots/fences/start replay**

Create `tests/unit/background/video-summary-coordinator.test.mjs`. The harness must provide a fake clock with `advance(ms)`, arrays for Offscreen/Content messages, deferred `ensureOffscreen`, and these helpers:

```js
const identity = { platform: 'bilibili', videoId: 'BV1coord', mediaId: '101' }
const context = {
  tabId: 7,
  documentId: 'doc-7',
  frameId: 0,
  pageIdentity: identity,
  owner: { tabId: 7, documentId: 'doc-7', platform: 'bilibili', mediaId: '101' },
}
const start = {
  type: 'START_TASK',
  requestId: 'start-1',
  taskId: 'task-1',
  pageIdentity: identity,
  sourceChoice: 'native-subtitle',
  subtitleTrackId: 'track-1',
  sourceSnapshot: {
    pageIdentity: identity,
    title: 'Title',
    durationMs: 10_000,
    nativeSubtitleTracks: [
      {
        id: 'track-1',
        language: 'en',
        label: 'English',
        sourceKind: 'author',
        cues: [{ startMs: 0, endMs: 1_000, text: 'hello' }],
      },
    ],
    mediaCandidates: [],
  },
  settingsSnapshot: {
    preferredLanguage: 'en',
    speakerIdentification: true,
    summaryMaxOutputTokens: 4_000,
    asrConfirmed: false,
  },
  modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
}

test('initial start allocates one Background fence and writes TASK_STARTED before posting', async () => {
  const harness = createHarness()
  await harness.coordinator.handleContentCommand({ context, port: harness.port, command: start })
  const command = harness.offscreenMessages[0]
  assert.equal(command.type, 'START_ATTEMPT')
  assert.equal(command.mode, 'initial')
  assert.deepEqual(command.fence, {
    owner: context.owner,
    taskId: 'task-1',
    generation: 1,
    attempt: 1,
  })
  assert.deepEqual(harness.coordinator.debugState().activeSlots, [
    {
      key: '7:bilibili',
      state: 'starting',
      fence: command.fence,
      pageIdentity: identity,
    },
  ])
  assert.equal(harness.coordinator.debugState().retainedTasks[0].replayEvent.type, 'TASK_STARTED')
  assert.deepEqual(harness.contentMessages, [])
})

test('identical start replay shares pending completion and conflict is deterministic', async () => {
  const harness = createHarness()
  const first = harness.coordinator.handleContentCommand({ context, port: harness.port, command: start })
  const replay = harness.coordinator.handleContentCommand({ context, port: harness.port, command: structuredClone(start) })
  await Promise.resolve()
  assert.equal(harness.offscreenMessages.length, 1)

  await harness.coordinator.handleContentCommand({
    context,
    port: harness.port,
    command: { ...start, sourceChoice: 'asr' },
  })
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')

  harness.acceptAttempt(0)
  await Promise.all([first, replay])
  assert.equal(
    harness.contentMessages.filter((message) => message.type === 'START_ACK').length,
    2,
  )
  assert.deepEqual(harness.contentMessages.at(-1), harness.contentMessages.at(-2))
})

test('one tab-platform slot rejects concurrent media but permits another platform', async () => {
  const harness = createHarness()
  await harness.coordinator.handleContentCommand({ context, port: harness.port, command: start })
  await harness.coordinator.handleContentCommand({
    context: { ...context, documentId: 'doc-8', owner: { ...context.owner, documentId: 'doc-8' } },
    port: harness.otherPort,
    command: { ...start, requestId: 'start-2', taskId: 'task-2' },
  })
  assert.equal(harness.contentMessages.at(-1).errorCode, 'VIDEO_SUMMARY_EXECUTION_BUSY')

  const youtubeIdentity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
  await harness.coordinator.handleContentCommand({
    context: {
      tabId: 7,
      documentId: 'doc-y',
      frameId: 0,
      pageIdentity: youtubeIdentity,
      owner: { tabId: 7, documentId: 'doc-y', platform: 'youtube', mediaId: 'abcdefghijk' },
    },
    port: harness.otherPort,
    command: {
      ...start,
      requestId: 'start-y',
      taskId: 'task-y',
      pageIdentity: youtubeIdentity,
      sourceSnapshot: { ...start.sourceSnapshot, pageIdentity: youtubeIdentity },
    },
  })
  assert.equal(harness.offscreenMessages.length, 2)
})
```

- [ ] **Step 2: Add RED tests for every cancel-before-start ordering**

Add tests that pause `ensureOffscreen` and issue `CANCEL_START` before it resolves, after it resolves but before the synchronous send-commit segment, immediately after `START_ATTEMPT`, and after `ATTEMPT_ACCEPTED`. Assert exact terminal responses:

```js
assert.deepEqual(cancelledStartAck, {
  type: 'START_ACK',
  requestId: 'start-1',
  taskId: 'task-1',
  status: 'cancelled',
  fence: null,
})
assert.deepEqual(cancelAck, {
  type: 'CANCEL_START_ACK',
  cancelRequestId: 'cancel-1',
  targetStartRequestId: 'start-1',
  status: 'cancelled',
  fence: null,
})
```

When `START_ATTEMPT` was posted first, assert both ACKs use `status: 'cancelling'` and the exact fence, capability is revoked, slot state is `cancelling`, `CANCEL_TASK` is posted once, and no `ATTEMPT_AUTHORIZED` is posted. Repeat `cancelRequestId: 'cancel-1'` and assert byte-for-byte replay; reuse it with another target and assert `VIDEO_SUMMARY_REQUEST_ID_CONFLICT`.

- [ ] **Step 3: Add RED tests for acceptance, retryRecord, and old-attempt cancellation**

Add tests asserting:

```js
harness.acceptAttempt(0)
assert.deepEqual(harness.offscreenMessages.at(-1), {
  type: 'ATTEMPT_AUTHORIZED',
  requestId: 'start-1',
  fence: harness.offscreenMessages[0].fence,
})
assert.equal(harness.coordinator.debugState().activeSlots[0].state, 'running')
assert.equal(harness.contentMessages.at(-1).status, 'started')
```

Then emit a retryable terminal `TASK_EVENT`, emit matching `EXECUTION_RELEASED`, request retry with `requestId: 'retry-1'`, and assert generation remains `1`, attempt becomes `2`, expiry is cleared during reservation, and mode is `retry-summary`. Cover all retry-record rules:

- same ID/different hash → `VIDEO_SUMMARY_REQUEST_ID_CONFLICT`;
- same ID/hash while `pending` → one `START_ATTEMPT` and all callers receive its eventual ACK;
- same ID/hash after `started` or `rejected` → stored response replay;
- different ID replaces a terminal retry record only when no active slot exists and checkpoint remains retryable;
- pending record cannot be replaced;
- deletion removes the retry record.

Issue `CANCEL_TASK { taskId: 'task-1', generation: 1 }` while attempt 2 runs and assert Background resolves the current fence with attempt 2 even when the caller never received retry ACK.

- [ ] **Step 4: Add RED tests for release/delete watchdogs and reset semantics**

Cover these exact timelines with the fake clock:

1. A terminal `TASK_EVENT` is stored before delivery and starts a 10,000 ms release watchdog.
2. Before 10,000 ms, matching `EXECUTION_RELEASED` removes only `activeSlots` and attempt capability, sends `EXECUTION_RELEASED_ACK`, retains checkpoint/replay, and starts 15-minute expiry.
3. At 10,000 ms without release, `resetOffscreen()` runs once, slot clears, `checkpointAvailable` becomes false, and replay becomes `TASK_FAILED` with `VIDEO_SUMMARY_RUNTIME_RESTARTED`.
4. Explicit cancel with no active slot synchronously sets `state: 'deleting'`, posts `DELETE_TASK`, rejects attach/retry, and starts a 10,000 ms delete watchdog.
5. Matching `TASK_DELETED` removes retained task/capability and cancels the watchdog; duplicate `TASK_DELETED` is harmless.
6. Delete timeout invokes reset and removes retained state via the same runtime-reset cleanup.
7. Authenticated Offscreen disconnect fails current executions, clears every active slot, marks retained checkpoints unavailable, resolves pending start/retry ACKs as rejected with `VIDEO_SUMMARY_RUNTIME_RESTARTED`, and permits a later explicit start.

- [ ] **Step 5: Add RED tests for replay, expiry, disconnect grace, and hard limits**

Add exact assertions for:

- attach during `starting` returns `ATTACH_ACK { status: 'active', fence, event: TASK_STARTED }`;
- completed result returns `terminal`, checkpoint failure returns `retryable`, and missing task returns `not-found` with `errorCode: 'TASK_UNAVAILABLE'`;
- same-document/same-media reconnect inside 15 seconds cancels grace and replays state;
- grace expiry and tab removal order observable calls as `revoke`, `CANCEL_TASK`, `EXECUTION_RELEASED`, `DELETE_TASK`, `TASK_DELETED`;
- terminal expiry callback captures its deadline, deletes only when `expiresAt` still equals it and no slot exists, and cannot delete a task whose retry cleared expiry;
- 128 pending start records in one document reject the 129th with `VIDEO_SUMMARY_START_RECORD_LIMIT_EXCEEDED` without evicting any pending marker;
- terminal start records expire after 15 minutes and free capacity;
- 32 retained tasks reject the 33rd with `VIDEO_SUMMARY_RETAINED_TASK_LIMIT_EXCEEDED`;
- replay state crossing 16 MiB replaces an oversized terminal result with `TASK_FAILED`, `checkpointAvailable: false`, and `VIDEO_SUMMARY_RESULT_TOO_LARGE`;
- each task stores one event, so progress replacement does not grow an event list;
- more than 16 pending gateway RPC identifiers for one fence is rejected before dispatch with `VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED`.

- [ ] **Step 6: Implement the coordinator state machine**

Use these exact record shapes in `src/background/video-summary-coordinator.mjs`:

```js
activeSlot = { state: 'starting' | 'running' | 'cancelling', fence, pageIdentity, port }
retainedTask = {
  owner,
  taskId,
  generation,
  pageIdentity,
  state: 'retained' | 'deleting',
  checkpointAvailable,
  replayEvent,
  expiresAt,
  retryRecord: null | { requestId, requestHash, state: 'pending' | 'started' | 'rejected', response },
}
startRecord = {
  documentId,
  taskId,
  requestId,
  requestHash,
  state: 'pending' | 'started' | 'cancelled' | 'cancelling' | 'rejected',
  cancellation: null | { cancelRequestId, response },
  fence,
  response,
  expiresAt,
}
capability = {
  fence,
  sourceChoice,
  asrConfirmed,
  candidateUrls,
  modelIdentity,
  executable,
  revoked,
  pendingRpcIds,
}
```

Use nested Maps rather than delimiter-joined strings: `activeSlots.get(tabId).get(platform)`, `startRecords.get(documentId).get(taskId)`, and retained/capability lookup through nested owner fields, task ID, and generation. Each start record stores one authoritative `requestId`; a different request ID for the same `(documentId, taskId)` key conflicts until the terminal record expires. Allocate generation from the coordinator-wide scalar `nextGeneration` and attempt monotonically inside a generation; neither value comes from Content or Offscreen.

The send-commit segment after `ensureOffscreen()` must contain no `await`: final cancellation check, slot reservation, retained shell/capability creation, synthetic `TASK_STARTED`, and synchronous `sendOffscreen(START_ATTEMPT)`. The `ATTEMPT_ACCEPTED` handler must also contain no `await`: verify exact starting fence/record, atomically select cancel or authorize, mark executable/running, send `ATTEMPT_AUTHORIZED`, then send Content ACK. Ignore every stale fence.

Terminal event handling must store bounded replay before `sendContent`. `EXECUTION_RELEASED` acknowledges only exact active fence. Deletion is idempotent and only `TASK_DELETED` removes retained state during normal operation. `debugState()` returns sorted arrays with timer IDs, ports, promise functions, and mutable Maps omitted.

- [ ] **Step 7: Run coordinator tests**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/protocol.test.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs
```

Expected: PASS; all protocol/coordinator tests pass, including fake-clock watchdog and capacity cases.

- [ ] **Step 8: Format and commit Task D**

Run:

```bash
npx prettier --write \
  src/background/video-summary-coordinator.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/video-summary-coordinator.test.mjs
git add \
  src/background/video-summary-coordinator.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs
git commit -m "Coordinate hardened video summary attempts"
```

Expected: coordinator tests pass; commit contains exactly the two Task D files.

### Task E: Pure Runner Attempt/Generation Interfaces

**Files:**
- Modify: `src/video-summary/task-runner.mjs:462-689`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`

**Interfaces:**
- Consumes: Task A `fencesEqual`, `ownersEqual`, and canonical fence shape; existing media pipeline/model gateway interfaces remain unchanged internally.
- Adds the new fenced interface below while retaining temporary `start`, `retry`, and `cancel` wrappers through Task E so the existing production runtime remains buildable. Task F removes those wrappers atomically after runtime wiring migrates:
  ```js
  registerAttempt({ requestId, fence, mode, payload, emit })
    -> { status: 'accepted', requestId, fence }
  authorizeAttempt({ requestId, fence }) -> Promise<void>
  cancelGeneration({ owner, taskId, generation }) -> void
  releaseAttempt(fence) -> void
  deleteTask({ owner, taskId, generation }) -> void
  hasCheckpoint({ owner, taskId, generation }) -> boolean
  ```
- Runner stores generation state in nested Maps by owner fields → task ID → generation and attempt controllers in a nested attempt Map; it never uses object identity or delimiter-joined keys. Registration performs no media, gateway, or model work.
- Offscreen runtime, not the runner, stores `pendingExecutionReleases` in the same nested owner → task → generation → attempt shape. After terminal cleanup it posts `EXECUTION_RELEASED` immediately and allows at most 10 total sends, including the initial send, spaced 1 second apart; it removes the entry on exact `EXECUTION_RELEASED_ACK`. Generation cancellation/runtime disconnect clears matching timers.

- [ ] **Step 1: Add registration/authorization barrier RED tests**

Add these helpers and tests to `tests/unit/video-summary/task-runner.test.mjs`:

```js
function createFence({ generation = 1, attempt = 1 } = {}) {
  return {
    owner: {
      tabId: 1,
      documentId: 'doc-1',
      platform: 'youtube',
      mediaId: 'abcdefghijk',
    },
    taskId: 'task-1',
    generation,
    attempt,
  }
}

function createInitialPayload() {
  return {
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity: {
        platform: 'youtube',
        videoId: 'abcdefghijk',
        mediaId: 'abcdefghijk',
      },
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          language: 'en',
          cues: [{ startMs: 0, endMs: 1000, text: 'hello' }],
        },
      ],
      mediaCandidates: [],
    },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { modelName: 'customModel' },
  }
}

function createRunnerFixture() {
  const mediaCalls = []
  const modelCalls = []
  const events = []
  const runner = createVideoTaskRunner({
    mediaPipeline: {
      async transcribeFromSource(args) {
        mediaCalls.push(args)
        return {
          durationMs: 1000,
          segments: [{ id: 's1', startMs: 0, endMs: 1000, text: 'hello' }],
        }
      },
    },
    modelGateway: {
      async describeCapabilities() {
        return { supported: false, reason: 'MODEL_GATEWAY_UNSUPPORTED' }
      },
      async generateText(args) {
        modelCalls.push(args)
        return { text: '', finishReason: null }
      },
      cancel() {},
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: { now: () => 0 },
  })
  return { runner, mediaCalls, modelCalls, events }
}

test('registerAttempt accepts locally without beginning provider work', () => {
  const fixture = createRunnerFixture()
  const fence = createFence({ generation: 1, attempt: 1 })
  const accepted = fixture.runner.registerAttempt({
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: (event) => fixture.events.push(event),
  })
  assert.deepEqual(accepted, { status: 'accepted', requestId: 'start-1', fence })
  assert.deepEqual(fixture.mediaCalls, [])
  assert.deepEqual(fixture.modelCalls, [])
})

test('only exact authorization begins the registered attempt', async () => {
  const fixture = createRunnerFixture()
  const fence = createFence({ generation: 1, attempt: 1 })
  fixture.runner.registerAttempt({
    requestId: 'start-1',
    fence,
    mode: 'initial',
    payload: createInitialPayload(),
    emit: (event) => fixture.events.push(event),
  })
  await assert.rejects(
    fixture.runner.authorizeAttempt({
      requestId: 'wrong-request',
      fence,
    }),
    /VIDEO_SUMMARY_ATTEMPT_NOT_REGISTERED/,
  )
  assert.deepEqual(fixture.mediaCalls, [])
  await fixture.runner.authorizeAttempt({ requestId: 'start-1', fence })
  assert.equal(fixture.mediaCalls.length, 1)
})
```

- [ ] **Step 2: Add permanent generation cancel and stale cleanup RED tests**

Add tests proving `cancelGeneration` sets the latch before invoking any asynchronous provider drain, aborts all controllers for that generation, prevents delayed `authorizeAttempt`, and leaves another generation untouched. Add this stale cleanup assertion:

```js
const attempt1 = createFence({ generation: 1, attempt: 1 })
const attempt2 = createFence({ generation: 1, attempt: 2 })
const generationKey = {
  owner: attempt1.owner,
  taskId: attempt1.taskId,
  generation: attempt1.generation,
}
fixture.runner.registerAttempt({
  requestId: 'retry-1',
  fence: attempt2,
  mode: 'retry-summary',
  payload: { fromStage: 'synthesis', modelSnapshot: { modelName: 'customModel' } },
  emit: (event) => fixture.events.push(event),
})
const attempt2Signal = fixture.runner.debugState().attempts.find(
  ({ fence }) => fencesEqual(fence, attempt2),
).controller.signal
fixture.runner.releaseAttempt(attempt1)
assert.equal(fixture.runner.hasCheckpoint(generationKey), true)
await fixture.runner.authorizeAttempt({ requestId: 'retry-1', fence: attempt2 })
fixture.runner.releaseAttempt(attempt1)
assert.equal(fixture.runner.hasCheckpoint(generationKey), true)
assert.equal(attempt2Signal.aborted, false)
fixture.runner.deleteTask(generationKey)
assert.equal(fixture.runner.hasCheckpoint(generationKey), false)
```

Also assert duplicate `deleteTask` succeeds, duplicate identical registration returns accepted without replacing state, conflicting duplicate fence/request throws `VIDEO_SUMMARY_ATTEMPT_CONFLICT`, and retry mode without checkpoint throws `VIDEO_SUMMARY_CHECKPOINT_NOT_FOUND` before acceptance.

- [ ] **Step 3: Run runner tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/task-runner.test.mjs
```

Expected: FAIL because `registerAttempt`, `authorizeAttempt`, `cancelGeneration`, `releaseAttempt`, `deleteTask`, and `hasCheckpoint` do not exist.

- [ ] **Step 4: Refactor state without changing summary/media behavior**

Retain existing transcription and summarization functions. Replace task-ID keyed state with:

```js
generationState = {
  owner,
  taskId,
  generation,
  checkpoint: {
    transcription,
    successfulChunkResults,
    failedRanges,
  },
  basePayload,
  emit,
  cancelled,
  attempts: Map<attempt, { requestId, fence, mode, payload, controller, state }>,
}
```

`registerAttempt` validates the fence and mode, rejects a cancelled generation, creates generation state only for `initial`, requires an existing transcription checkpoint for `retry-summary`, and stores a clone-safe payload. `authorizeAttempt` synchronously changes `registered` to `authorized` before its first await, then executes the existing initial or retry path. It emits task status/result/failure through the registered `emit`, with the exact fence attached by its caller in Task F.

`releaseAttempt` removes only an exact matching attempt/controller. `cancelGeneration` sets `cancelled = true` before aborting controllers and never clears it. `deleteTask` aborts attempts and removes the entire generation. In every `finally`, delete a controller only when the stored controller is the same object; old attempt cleanup must not mutate a newer attempt.

- [ ] **Step 5: Preserve existing runner tests through temporary wrappers**

Keep every current `runner.start(command, emit)`, `runner.retry(taskId, options)`, and `runner.cancel(taskId)` test unchanged. Implement temporary wrappers that translate those calls into `registerAttempt` plus `authorizeAttempt`, generation-level retry registration, and `cancelGeneration`. Add direct tests for the new fenced interface from Steps 1–2. Task F migrates runtime callers and tests, then deletes the wrappers. This keeps Task E independently buildable without shipping a dual protocol.

- [ ] **Step 6: Run runner tests and commit Task E**

Run:

```bash
npx prettier --write src/video-summary/task-runner.mjs tests/unit/video-summary/task-runner.test.mjs
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/task-runner.test.mjs
git add src/video-summary/task-runner.mjs tests/unit/video-summary/task-runner.test.mjs
git commit -m "Separate video summary attempts from checkpoints"
```

Expected: all existing and new runner tests pass; commit contains exactly the runner and its test.

### Task F: Atomic Production Wiring and Full Verification

**Files:**
- Modify: `src/video-summary/contracts.mjs:1-33`
- Modify: `tests/unit/video-summary/contracts.test.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-page-bridge.mjs`
- Modify: `src/content-script/site-adapters/youtube/video-page-bridge.mjs`
- Modify: `src/content-script/video-summary-port.mjs:1-173`
- Modify: `tests/unit/content-script/video-summary-port.test.mjs`
- Modify: `src/content-script/video-summary-host.mjs`
- Modify: `tests/unit/content-script/video-summary-host.test.mjs`
- Modify: `src/background/video-summary-router.mjs:1-361`
- Modify: `tests/unit/background/video-summary-router.test.mjs`
- Modify: `src/background/video-summary-offscreen-rpc.mjs:1-253`
- Modify: `tests/unit/background/video-summary-offscreen-rpc.test.mjs`
- Modify: `src/pages/VideoSummaryOffscreen/runtime.mjs:1-395`
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Modify: `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`
- Modify: `src/background/index.mjs:66-247,1268-1292`
- Create: `tests/integration/video-summary/protocol-lifecycle.test.mjs`

**Interfaces:**
- Consumes: all interfaces from Tasks A–E.
- Produces Content client methods:
  ```js
  startTask(payload) -> Promise<{ taskId, generation, fence }>
  cancelStart({ cancelRequestId, targetStartRequestId, taskId }) -> Promise<CANCEL_START_ACK>
  attachTask({ taskId, generation }) -> Promise<ATTACH_ACK>
  cancelTask({ taskId, generation }) -> Promise<void>
  retryTask({ requestId, taskId, generation, fromStage, modelSnapshot }) -> Promise<RETRY_ACK>
  dispose() -> void
  ```
- Produces Offscreen runtime handling for `START_ATTEMPT`, `ATTEMPT_AUTHORIZED`, `CANCEL_TASK`, `EXECUTION_RELEASED_ACK`, `DELETE_TASK`, source refresh, and gateway responses.
- Removes Task B's temporary top-level snapshot `platform`, `videoId`, and `pageId` fields after Content, Background, and Offscreen consumers use `pageIdentity`.
- Router becomes authenticated transport only; coordinator owns all task lifecycle decisions.

- [ ] **Step 1: Write Content request/ACK and no-authority RED tests**

Replace old message-shape assertions in `tests/unit/content-script/video-summary-port.test.mjs` with deterministic factories:

```js
function createStartPayload() {
  return {
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity,
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          cues: [{ startMs: 0, endMs: 1000, text: 'hello' }],
        },
      ],
      mediaCandidates: [],
    },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { modelName: 'customModel' },
  }
}

const client = createVideoSummaryPortClient({
  pageIdentity,
  pageGeneration: 3,
  pageBridge,
  connect: () => port,
  createTaskId: () => 'task-1',
  createRequestId: (() => {
    let id = 0
    return () => `request-${++id}`
  })(),
  onEvent: (event) => events.push(event),
})

const started = client.startTask(createStartPayload())
assert.deepEqual(port.postedMessages[0], {
  type: 'START_TASK',
  requestId: 'request-1',
  taskId: 'task-1',
  pageIdentity,
  ...createStartPayload(),
})
for (const key of ['owner', 'generation', 'attempt', 'platform', 'videoId', 'mediaId']) {
  assert.equal(key in port.postedMessages[0], false)
}
port.emitMessage({
  type: 'START_ACK',
  requestId: 'request-1',
  taskId: 'task-1',
  status: 'started',
  fence,
})
assert.deepEqual(await started, { taskId: 'task-1', generation: 1, fence })
```

Add cancel-before-ACK, cancelling ACK, rejected ACK, duplicate ACK, attach replay, retry ACK loss/replay, stale attempt event, stale generation event, stale page generation, source refresh correlation, and disconnect rejection tests. Pending promises must reject with `VIDEO_SUMMARY_PORT_DISCONNECTED`; `ATTACH_ACK.status === 'not-found'` must reject with `TASK_UNAVAILABLE`.

- [ ] **Step 2: Write router authentication and Offscreen barrier RED tests**

Update every fake sender in router/RPC tests to include extension ID, tab ID, document ID, `frameId: 0`, and matching HTTPS URL. Add a counter around `ensureOffscreenDocument` and assert each invalid sender from Task C is disconnected while the counter remains zero.

In `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`, add `createRuntimeFixture()` beside the existing `createLogger()` and request-ID helpers. It must create a fake Offscreen port, inject a runner spy with `registerAttempt`, `authorizeAttempt`, `cancelGeneration`, `releaseAttempt`, and `deleteTask`, expose each call array, and provide `flush: () => new Promise((resolve) => setImmediate(resolve))`. Then add:

```js
test('Offscreen accepts registration before authorization and releases after terminal event', async () => {
  const fixture = createRuntimeFixture()
  fixture.port.emitMessage({ type: 'START_ATTEMPT', requestId: 'start-1', fence, mode: 'initial', payload })
  assert.deepEqual(fixture.port.postedMessages[0], {
    type: 'ATTEMPT_ACCEPTED',
    requestId: 'start-1',
    fence,
  })
  assert.deepEqual(fixture.runnerCalls.authorize, [])

  fixture.port.emitMessage({ type: 'ATTEMPT_AUTHORIZED', requestId: 'start-1', fence })
  await fixture.flush()
  assert.deepEqual(fixture.runnerCalls.authorize, [{ requestId: 'start-1', fence }])
  assert.equal(fixture.port.postedMessages.at(-2).type, 'TASK_EVENT')
  assert.equal(fixture.port.postedMessages.at(-1).type, 'EXECUTION_RELEASED')
})
```

Add a fake-clock case where an accepted attempt receives no authorization for 10,000 ms: assert generation cancellation/release and zero provider calls. Add `DELETE_TASK` twice and assert two `TASK_DELETED` replies. Send `EXECUTION_RELEASED_ACK` from the fake Background port to runtime and assert runtime stops retransmitting the matching release tombstone without deleting its generation checkpoint.

- [ ] **Step 3: Write end-to-end RED tests before changing production wiring**

Create `tests/integration/video-summary/protocol-lifecycle.test.mjs` with fake Content and Offscreen ports joined through the real router, coordinator, RPC, runtime, and runner. Cover:

1. Initial start allocates attempt 1 in Background; message order is `START_ATTEMPT`, `ATTEMPT_ACCEPTED`, `ATTEMPT_AUTHORIZED`, first `GATEWAY_REQUEST`.
2. Duplicate start request receives one fence and one execution.
3. Cancel before delayed Offscreen creation returns cancelled and invokes no runner method.
4. Cancel after registration but before authorization invokes no provider.
5. Terminal event followed by release frees the slot while attach still replays the retained checkpoint.
6. Another media in the same tab/platform starts after release.
7. Retry reacquires the slot with the same generation and attempt 2.
8. Generation cancel using the old attempt knowledge cancels attempt 2.
9. Disconnect grace expiry performs cancel, release, delete, and retained removal.
10. Background/Offscreen disconnect reports `VIDEO_SUMMARY_RUNTIME_RESTARTED` and does not resume.

Use only fake gateways and fake clocks; no network or credentials.

- [ ] **Step 4: Remove old protocol constants and wire the Content client/host**

Keep only stable port/path/storage/platform constants in `contracts.mjs`; import mutable message types and protocol constructors/parsers from `protocol.mjs`. Update host construction to pass full `pageIdentity` and `pageGeneration`. The client runs every Background message through `parseContentMessage` before correlation, tracks pending start/cancel/attach/retry requests by request ID, stores only the Background-returned fence, sends generation-level cancel, and filters events by full fence plus current page generation.

Do not retain production handling for old top-level identity or direct `START_TASK`/`RETRY_TASK` forwarding to Offscreen.

- [ ] **Step 5: Replace router lifecycle logic with authenticated coordinator transport**

`createVideoSummaryRouter` must accept `{ runtime, ensureOffscreenDocument, coordinator, logger }`. On connect, it validates port name only enough to select the channel, waits for the first parsed command to obtain `pageIdentity`, authenticates with Task C, and rejects/disconnects before `ensureOffscreenDocument` on failure. Once authenticated, bind the immutable context to that port and forward parsed commands to `coordinator.handleContentCommand`; never derive owner from message top-level fields.

On disconnect call `coordinator.handleContentDisconnect`. Forward tab removal to `handleTabRemoved`. Remove router-owned routes, grace timers, task replay, owner construction, and `debugRoutes()`.

- [ ] **Step 6: Wire authenticated Offscreen RPC and runtime**

Authenticate the dedicated Offscreen port before `videoSummaryOffscreenRpc.attachPort`. RPC parses every Offscreen message, forwards lifecycle messages to coordinator, and permits gateway/source-refresh dispatch only after coordinator confirms the exact executable fence and pending-RPC limit. Commands sent to Offscreen pass through `parseOffscreenCommand`.

Runtime calls `registerAttempt`, immediately posts `ATTEMPT_ACCEPTED`, and waits for exact `ATTEMPT_AUTHORIZED` before calling `authorizeAttempt`. It owns the 10-second unauthorized timer. Terminal task event is posted first; `releaseAttempt(fence)` follows in `finally`, then runtime inserts the fence in `pendingExecutionReleases`, posts `EXECUTION_RELEASED`, and sends it at most 10 total times including the initial send, spaced 1 second apart. Exact `EXECUTION_RELEASED_ACK` clears that entry/timer without deleting checkpoint state. `CANCEL_TASK` calls generation cancellation. `DELETE_TASK` calls idempotent deletion then posts `TASK_DELETED`.

- [ ] **Step 7: Remove temporary runner wrappers and wire Background startup/reset atomically**

After runtime callers use `registerAttempt`, `authorizeAttempt`, `cancelGeneration`, `releaseAttempt`, and `deleteTask`, delete Task E's temporary `start`, `retry`, and `cancel` wrappers and migrate their remaining tests to the fenced interface. Then wire Background startup/reset:


In `background/index.mjs`, construct one coordinator and inject authenticated transport callbacks. Before registering video-summary `onConnect`, await or gate on `closeVideoSummaryOffscreenDocument`; queued connections may proceed only after that promise resolves. An authenticated Offscreen disconnect calls coordinator runtime-reset handling, clears pending RPCs, and makes the next explicit start create a fresh document. Do not automatically replay queued attempts after reset.

The Offscreen state may hold only the current authenticated port and commands belonging to the coordinator's current synchronous send; remove the unbounded `pendingCommands` queue.

- [ ] **Step 8: Run focused Increment 1 tests**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/contracts.test.mjs \
  tests/unit/video-summary/protocol.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs \
  tests/unit/content-script/video-summary-port.test.mjs \
  tests/unit/content-script/video-summary-host.test.mjs \
  tests/unit/background/video-summary-port-auth.test.mjs \
  tests/unit/background/offscreen.test.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs \
  tests/unit/background/video-summary-router.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/integration/video-summary/protocol-lifecycle.test.mjs
```

Expected: PASS; all listed tests pass with zero failed, cancelled, or skipped tests.

- [ ] **Step 9: Run formatting, lint, complete tests, and production build**

Run in this order:

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Expected:

- `npm run pretty`: exits 0 and reports formatted files without syntax errors.
- `npm run lint`: exits 0 with zero ESLint errors.
- `npm test`: exits 0 with zero failed/cancelled tests.
- `npm run build`: exits 0 and produces all four browser variants and archives.

- [ ] **Step 10: Verify artifact separation and removed dual protocol**

Run:

```bash
test -f build/chromium/VideoSummaryOffscreen.html && \
test -f build/chromium/VideoSummaryOffscreen.js && \
test ! -e build/firefox/VideoSummaryOffscreen.html && \
test ! -e build/firefox/VideoSummaryOffscreen.js && \
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html && \
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.js && \
! rg -n "case 'START_TASK'|case 'RETRY_TASK'" src/pages/VideoSummaryOffscreen src/background/video-summary-offscreen-rpc.mjs
```

Expected: exits 0; Offscreen artifacts exist only in full Chromium, and no old direct execution handlers remain.

- [ ] **Step 11: Perform manual Chromium protocol smoke tests**

Load unpacked `build/chromium/`, then verify: Bilibili P1→P2 creates a new media identity; YouTube watch→watch changes identity; duplicate Start creates one execution; Cancel before start settles visibly; active Cancel frees the slot; completed/retryable attach replays; retry uses a higher attempt; DOM/content-port disconnect waits 15 seconds then deletes; Background restart and Offscreen restart show runtime-restarted failure; another video can start after terminal release. Inspect Content, service-worker, and Offscreen consoles and confirm no credentials, signed URLs, subtitle text, or prompts are logged.

Expected: every scenario follows the new protocol; no old direct Offscreen start path is observed.

- [ ] **Step 12: Inspect the final diff, stage every Task F file explicitly, and commit**

Run:

```bash
git diff --check
git status --short
git diff -- \
  src/video-summary/contracts.mjs \
  src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  src/content-script/site-adapters/youtube/video-page-bridge.mjs \
  src/content-script/video-summary-port.mjs \
  src/content-script/video-summary-host.mjs \
  src/background/video-summary-router.mjs \
  src/background/video-summary-offscreen-rpc.mjs \
  src/pages/VideoSummaryOffscreen/runtime.mjs \
  src/background/index.mjs
git add \
  src/video-summary/contracts.mjs \
  tests/unit/video-summary/contracts.test.mjs \
  src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  src/content-script/site-adapters/youtube/video-page-bridge.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs \
  src/content-script/video-summary-port.mjs \
  tests/unit/content-script/video-summary-port.test.mjs \
  src/content-script/video-summary-host.mjs \
  tests/unit/content-script/video-summary-host.test.mjs \
  src/background/video-summary-router.mjs \
  tests/unit/background/video-summary-router.test.mjs \
  src/background/video-summary-offscreen-rpc.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  src/pages/VideoSummaryOffscreen/runtime.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  src/video-summary/task-runner.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  src/background/index.mjs \
  tests/integration/video-summary/protocol-lifecycle.test.mjs
git commit -m "Wire hardened video summary protocol"
```

Expected: `git diff --check` is silent; the commit includes every listed Task F file and no unrelated file.

## Self-Review Record

- Spec coverage: Tasks A–F cover Increment 1 delivery items and required tests for identity, authentication, Background fences, authorization order, start cancellation, generation cancellation, release/delete separation, slot reuse, retry, attach replay, disconnect grace, watchdog reset, and bounded replay.
- Boundary review: Tasks A, C, and D are browser-independent or dependency-injected; Task B changes identity only; Task E changes runner interfaces only; Task F is the sole production cross-context wiring change.
- Type review: all tasks use `PageIdentity { platform, videoId, mediaId }`, owner `{ tabId, documentId, platform, mediaId }`, and fence `{ owner, taskId, generation, attempt }`; initial and retry attempts share one barrier.
- State review: coordinator primary state is limited to `activeSlots`, `retainedTasks`, `startRecords`, and `capabilities`; release never deletes checkpoints; deletion requires `TASK_DELETED` or runtime-reset fallback.
- Limit review: all numeric protocol, record, replay, grace, expiry, and watchdog limits match the approved design exactly.
- Document scan: every task has exact files, interfaces, checkbox steps, executable RED tests, precise commands with expected outcomes, GREEN requirements, and explicit staging/commit commands; no unresolved implementation markers remain.
