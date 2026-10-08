# YouTube Video Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ordinary YouTube watch pages the same enhanced subtitle/ASR, structured summary, timestamp seeking, retry, archive, export, and follow-up workflow as Bilibili.

**Architecture:** Generalize the Bilibili host, view, protocol, capability gate, and setting into a shared video-summary framework whose task owner is `(tabId, documentId, platform, videoId)`. Keep page parsing and player control behind site bridges. On YouTube, obtain subtitles from the current page session in this order: official transcript-panel DOM, native player `fetch`/XHR capture, Innertube `get_transcript`, then bounded timed-text URL replay. Normalize the first successful source into the existing offscreen task pipeline while retaining the legacy adapter outside the capability gate.

**Tech Stack:** JavaScript ES modules, Preact, SCSS, `webextension-polyfill`, Node 22 `node:test`, JSDOM, Webpack 5, Chromium MV3 `chrome.scripting` and Offscreen APIs, Volcengine AI MediaKit.

**Implementation status:** Implemented and validated. This document is retained as the as-built task record; the YouTube subtitle tasks below supersede the original direct timed-text-only plan.

## Global Constraints

- Enhanced summaries remain limited to the full Chromium build on Chrome and Edge 116+.
- Initial YouTube scope is ordinary `/watch?v=...` on-demand pages; exclude Shorts, live streams, embeds, and non-watch pages.
- One canonical `videoTranscriptionEnabled` setting controls enhanced Bilibili and YouTube summaries and preserves the old `bilibiliVideoTranscriptionEnabled` value during migration.
- Order authored subtitles before automatic subtitles and apply preferred-language matching within that source order.
- Never submit media to ASR without the existing per-run privacy, cost, upload, and cancellation confirmation.
- Preserve Firefox, Safari, minimal Chromium, unsupported-page, disabled-feature, and disabled-adapter legacy behavior.
- Never bypass login, payment, private-content, DRM, age, or regional restrictions.
- Never log watch HTML, player responses, subtitle/transcript text, prompts, signed URLs, cookies, task payloads, model output, or provider credentials.
- Cross-context values must remain structured-clone-safe; Background derives tab/document identity from `port.sender`.
- YouTube subtitle retrieval may open the official transcript panel or briefly change caption state, but must restore extension-owned UI/player changes and must never start ASR automatically.
- YouTube subtitle fallback order is official transcript-panel DOM, native player response capture, Innertube `get_transcript`, then bounded timed-text URL replay.
- MAIN-world functions passed through `chrome.scripting.executeScript({ func })` must remain self-contained after production bundling; `youtube-page-data.mjs` is excluded from Babel helper transforms and covered by a production-bundle serialization test.
- Do not add dependencies, permissions, a backend, or persistent jobs.
- Follow red-green-refactor for every production change.
- Do not commit, stage, rename, or delete files unless the user explicitly authorizes that action during execution; compatibility files may remain until authorization is received.

Before Task 1, run `git status --short` and preserve the uncommitted design documents. Run `npm ci` only if `node_modules/` is absent. Each commit block is an optional review checkpoint: execute it only after the user explicitly authorizes commits; otherwise run `git diff --check` and continue without staging. Before any planned rename or deletion, confirm authorization if the current request has not explicitly granted it.

---

### Task 1: Migrate the shared feature setting and capability gate

**Files:**
- Modify: `src/config/index.mjs:842-844,1205-2134,2141-2268`
- Modify: `src/video-summary/capabilities.mjs:1-25`
- Modify: `build.mjs:218-220`
- Rename: `src/popup/sections/BilibiliVideoTranscriptionSettings.jsx` → `src/popup/sections/VideoSummarySettings.jsx`
- Modify: `src/popup/sections/SiteAdapters.jsx`
- Modify: `src/popup/sections/GeneralPart.jsx`
- Modify: `src/_locales/en/main.json`
- Modify: `src/_locales/zh-hans/main.json`
- Modify: `src/_locales/zh-hant/main.json`
- Modify: `tests/unit/config/migrate-user-config.test.mjs`
- Modify: `tests/unit/video-summary/capabilities.test.mjs`
- Rename: `tests/unit/popup/bilibili-video-transcription-settings.test.mjs` → `tests/unit/popup/video-summary-settings.test.mjs`

**Interfaces:**
- Produces: canonical `defaultConfig.videoTranscriptionEnabled: boolean`.
- Produces: `isVideoSummaryEnabled(config)` and generic build global `__ENABLE_VIDEO_SUMMARY__`.
- Preserves: existing speaker-identification, output-token, and MediaKit credential fields as shared settings.

- [ ] **Step 1: Write failing migration and capability tests**

Add cases equivalent to:

```js
test('migrates the legacy Bilibili switch into the shared switch', async () => {
  await Browser.storage.local.set({ bilibiliVideoTranscriptionEnabled: true })
  const config = await getUserConfig()
  assert.equal(config.videoTranscriptionEnabled, true)
  const stored = await Browser.storage.local.get()
  assert.equal(stored.videoTranscriptionEnabled, true)
  assert.equal('bilibiliVideoTranscriptionEnabled' in stored, false)
})

test('canonical shared switch wins over the legacy value', async () => {
  await Browser.storage.local.set({
    videoTranscriptionEnabled: false,
    bilibiliVideoTranscriptionEnabled: true,
  })
  assert.equal((await getUserConfig()).videoTranscriptionEnabled, false)
})

test('generic capability gate requires the canonical switch', () => {
  assert.equal(isVideoSummaryEnabled({ videoTranscriptionEnabled: true }), true)
  assert.equal(isVideoSummaryEnabled({ bilibiliVideoTranscriptionEnabled: true }), false)
})
```

Also cover canonical `true/false`, legacy `true/false`, both missing, malformed values, idempotent reread, and storage-write failure preserving the legacy key for retry.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/config/migrate-user-config.test.mjs \
  tests/unit/video-summary/capabilities.test.mjs \
  tests/unit/popup/video-summary-settings.test.mjs
```

Expected: FAIL because `videoTranscriptionEnabled`, `isVideoSummaryEnabled`, and the renamed settings component do not exist.

- [ ] **Step 3: Implement canonical migration and generic gate**

Use this field-presence migration shape inside `migrateUserConfig`:

```js
const hasCanonicalVideoSwitch = typeof migrated.videoTranscriptionEnabled === 'boolean'
const hasLegacyVideoSwitch = typeof migrated.bilibiliVideoTranscriptionEnabled === 'boolean'
if (!hasCanonicalVideoSwitch && hasLegacyVideoSwitch) {
  migrated.videoTranscriptionEnabled = migrated.bilibiliVideoTranscriptionEnabled
  dirty = true
}
if ('bilibiliVideoTranscriptionEnabled' in migrated) {
  storageKeysToRemove.add('bilibiliVideoTranscriptionEnabled')
}
```

Fetch the legacy key explicitly after removing it from defaults, persist the canonical value before key removal, and make defaults include:

```js
videoTranscriptionEnabled: false,
bilibiliSpeakerIdentificationEnabled: true,
bilibiliSummaryMaxOutputTokens: 20_000,
```

Replace the capability implementation with:

```js
/* global __ENABLE_VIDEO_SUMMARY__ */

export function isVideoSummaryBuildEnabled() {
  return typeof __ENABLE_VIDEO_SUMMARY__ !== 'undefined' && __ENABLE_VIDEO_SUMMARY__ === true
}

export function isVideoSummaryEnabled(config) {
  return isVideoSummaryBuildEnabled() && config?.videoTranscriptionEnabled === true
}
```

Rename the Webpack define without changing its `!minimal` value. Make the popup render one shared settings block after the site list and read/write only `videoTranscriptionEnabled`.

- [ ] **Step 4: Run focused tests and formatting check**

Run the command from Step 2, then:

```bash
npx prettier --check src/config/index.mjs src/video-summary/capabilities.mjs \
  src/popup/sections/VideoSummarySettings.jsx src/popup/sections/SiteAdapters.jsx build.mjs
```

Expected: all focused tests PASS and Prettier reports all matched files use Prettier style.

- [ ] **Step 5: Commit**

```bash
git add build.mjs src/config/index.mjs src/video-summary/capabilities.mjs \
  src/popup/sections/VideoSummarySettings.jsx src/popup/sections/SiteAdapters.jsx \
  src/popup/sections/GeneralPart.jsx src/_locales/en/main.json \
  src/_locales/zh-hans/main.json src/_locales/zh-hant/main.json \
  tests/unit/config/migrate-user-config.test.mjs \
  tests/unit/video-summary/capabilities.test.mjs \
  tests/unit/popup/video-summary-settings.test.mjs
git commit -m "Generalize video summary settings"
```

---

### Task 2: Make task ownership platform-aware end to end

**Files:**
- Modify: `src/video-summary/contracts.mjs`
- Modify: `src/background/video-summary-router.mjs`
- Modify: `src/background/video-summary-offscreen-rpc.mjs`
- Modify: `src/pages/VideoSummaryOffscreen/runtime.mjs`
- Create: `src/content-script/video-summary-port.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-summary-port.mjs`
- Modify: `tests/unit/video-summary/contracts.test.mjs`
- Modify: `tests/unit/background/video-summary-router.test.mjs`
- Modify: `tests/unit/background/video-summary-offscreen-rpc.test.mjs`
- Modify: `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`
- Modify: `tests/unit/content-script/bilibili-video-summary-port.test.mjs`

**Interfaces:**
- Produces: `VIDEO_SUMMARY_PLATFORMS = ['bilibili', 'youtube']` and `createVideoSummaryOwner({ tabId, documentId, platform, videoId })`.
- Produces: `createVideoSummaryPortClient({ platform, videoId, pageBridge, connect, onEvent, onDisconnect })`.
- Every start/attach/cancel/retry/refresh command and event carries `platform` and `videoId`.

- [ ] **Step 1: Write failing cross-platform ownership tests**

Add assertions equivalent to:

```js
const bilibili = createVideoSummaryOwner({
  tabId: 1,
  documentId: 'doc',
  platform: 'bilibili',
  videoId: 'same-id',
})
const youtube = createVideoSummaryOwner({
  tabId: 1,
  documentId: 'doc',
  platform: 'youtube',
  videoId: 'same-id',
})
assert.notDeepEqual(bilibili, youtube)
```

In router/RPC/runtime tests, open Bilibili and YouTube routes with identical tab, document, video, and task IDs; assert events, refresh results, retry, cancel, and attach reach only the matching platform. Assert missing/unsupported platforms are rejected and caller-supplied tab/document owners remain ignored.

- [ ] **Step 2: Run protocol tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/contracts.test.mjs \
  tests/unit/background/video-summary-router.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/content-script/bilibili-video-summary-port.test.mjs
```

Expected: FAIL because owners and route keys omit `platform`.

- [ ] **Step 3: Implement the generic contract and route keys**

Use explicit validation:

```js
export const VIDEO_SUMMARY_PLATFORMS = Object.freeze(['bilibili', 'youtube'])

export function assertVideoSummaryPlatform(platform) {
  if (!VIDEO_SUMMARY_PLATFORMS.includes(platform)) {
    throw new Error('VIDEO_SUMMARY_PLATFORM_INVALID')
  }
  return platform
}

export function createVideoSummaryOwner({ tabId, documentId, platform, videoId }) {
  return { tabId, documentId, platform: assertVideoSummaryPlatform(platform), videoId }
}
```

Rename port string values to `video-summary` and `video-summary-offscreen`. Include `platform` in router and refresh keys:

```js
function routeKeyOf({ tabId, documentId, platform, videoId }) {
  return `${tabId}:${documentId}:${platform}:${videoId}`
}
```

Bind each offscreen `taskId` to its full owner on `START_TASK`; reject attach/retry/cancel/refresh commands unless the supplied owner equals the binding. Move the port client to the shared path and keep the old Bilibili module as a temporary re-export:

```js
export { createVideoSummaryPortClient } from '../../video-summary-port.mjs'
```

- [ ] **Step 4: Run protocol tests**

Run the Step 2 command. Expected: all protocol, router, RPC, runtime, and port tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video-summary/contracts.mjs src/background/video-summary-router.mjs \
  src/background/video-summary-offscreen-rpc.mjs \
  src/pages/VideoSummaryOffscreen/runtime.mjs src/content-script/video-summary-port.mjs \
  src/content-script/site-adapters/bilibili/video-summary-port.mjs \
  tests/unit/video-summary/contracts.test.mjs \
  tests/unit/background/video-summary-router.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/content-script/bilibili-video-summary-port.test.mjs
git commit -m "Add platform-aware video task ownership"
```

---

### Task 3: Generalize media refresh, native-track selection, and errors

**Files:**
- Modify: `src/video-summary/media-pipeline.mjs`
- Modify: `src/video-summary/opfs.mjs`
- Modify: `src/video-summary/task-runner.mjs`
- Create: `src/video-summary/subtitle-tracks.mjs`
- Modify: `src/content-script/site-adapters/bilibili/media-source.mjs`
- Modify: `tests/unit/video-summary/media-pipeline.test.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Create: `tests/unit/video-summary/subtitle-tracks.test.mjs`
- Modify: `tests/unit/content-script/bilibili-media-source.test.mjs`

**Interfaces:**
- Produces: `orderSubtitleTracks(tracks)` and `selectPreferredSubtitleTrack(tracks, preferredLanguage)`.
- Source kinds: `author`, `automatic`, `bilibili-ai`, `unknown`.
- Refresh requests contain `expectedPlatform` and `expectedVideoId`.

- [ ] **Step 1: Write failing shared utility and identity tests**

Create tests using:

```js
const tracks = [
  { id: 'auto-en', language: 'en', sourceKind: 'automatic', cues: [{ text: 'a' }] },
  { id: 'author-ja', language: 'ja', sourceKind: 'author', cues: [{ text: 'b' }] },
  { id: 'author-en', language: 'en-US', sourceKind: 'author', cues: [{ text: 'c' }] },
]
assert.deepEqual(orderSubtitleTracks(tracks).map(({ id }) => id), [
  'author-ja',
  'author-en',
  'auto-en',
])
assert.equal(selectPreferredSubtitleTrack(tracks, 'en').id, 'author-en')
```

Cover exact locale, base-language match, stable ordering, malformed/empty cues, and all four source kinds. Update media tests so refreshed snapshots must match both expected fields; update task tests so a missing requested native track raises `VIDEO_NATIVE_SUBTITLES_NOT_FOUND` and never calls ASR.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/subtitle-tracks.test.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs
```

Expected: FAIL because shared subtitle utilities and platform refresh checks do not exist.

- [ ] **Step 3: Implement utilities and generic errors**

Implement source ranking without mutating callers:

```js
const SOURCE_WEIGHT = Object.freeze({ author: 0, automatic: 1, 'bilibili-ai': 2, unknown: 3 })

export function orderSubtitleTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track?.id && Array.isArray(track.cues) && track.cues.length > 0)
    .map((track, index) => ({ track, index }))
    .sort((a, b) =>
      (SOURCE_WEIGHT[a.track.sourceKind] ?? SOURCE_WEIGHT.unknown) -
        (SOURCE_WEIGHT[b.track.sourceKind] ?? SOURCE_WEIGHT.unknown) || a.index - b.index,
    )
    .map(({ track }) => track)
}
```

Select preferred language within each source rank. Replace generic `BILIBILI_*` pipeline errors with `VIDEO_MEDIA_CANDIDATE_NOT_FOUND`, `VIDEO_SOURCE_IDENTITY_CHANGED`, and `VIDEO_NATIVE_SUBTITLES_NOT_FOUND`; retain extraction-specific Bilibili errors. Make Bilibili's selector delegate to the shared utility.

- [ ] **Step 4: Run focused tests**

Run Step 2. Expected: all shared pipeline and Bilibili regression tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video-summary/media-pipeline.mjs src/video-summary/opfs.mjs \
  src/video-summary/task-runner.mjs src/video-summary/subtitle-tracks.mjs \
  src/content-script/site-adapters/bilibili/media-source.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/unit/video-summary/subtitle-tracks.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs
git commit -m "Generalize video subtitle processing"
```

---

### Task 4: Generalize the video-summary view

**Files:**
- Create: `src/components/VideoSummaryView/index.jsx`
- Create: `src/components/VideoSummaryView/styles.scss`
- Delete after migration: `src/components/BilibiliVideoSummaryView/index.jsx`
- Delete after migration: `src/components/BilibiliVideoSummaryView/styles.scss`
- Create: `tests/unit/components/video-summary-view.test.mjs`
- Delete after migration: `tests/unit/components/bilibili-video-summary-view.test.mjs`
- Modify: `src/_locales/en/main.json`
- Modify: `src/_locales/zh-hans/main.json`
- Modify: `src/_locales/zh-hant/main.json`

**Interfaces:**
- Consumes: `{ platform, subtitleTracks, selectedSubtitleTrackId, onSelectSubtitleTrack, onChooseSource, ...existingResultProps }`.
- Produces: selected track ID with `onSelectSubtitleTrack(id)` and source choice with `onChooseSource('native-subtitle' | 'asr')`.

- [ ] **Step 1: Write failing generalized component tests**

Copy the existing JSDOM setup, import `VideoSummaryView`, and test:

```js
render(
  h(VideoSummaryView, {
    platform: 'youtube',
    subtitleTracks: [
      { id: 'en-author', label: 'English', language: 'en', sourceKind: 'author', cues: [{}] },
      { id: 'en-auto', label: 'English', language: 'en', sourceKind: 'automatic', cues: [{}] },
    ],
    selectedSubtitleTrackId: 'en-author',
    onSelectSubtitleTrack: (id) => selected.push(id),
    onChooseSource: (choice) => choices.push(choice),
    taskState: { phase: 'idle' },
  }),
  container,
)
```

Assert both tracks and their source labels render, selecting automatic emits `en-auto`, ASR requires confirmation, and unknown errors render a localized generic message without exposing the raw code. Retain all existing structured result, timestamp, action, warning, Chinese, and retry assertions.

- [ ] **Step 2: Run the component test and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/components/video-summary-view.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `VideoSummaryView`.

- [ ] **Step 3: Implement the shared view and styles**

Replace the single-track source area with a controlled selector:

```jsx
<select
  value={selectedSubtitleTrackId || ''}
  onChange={(event) => onSelectSubtitleTrack(event.currentTarget.value)}
>
  {subtitleTracks.map((track) => (
    <option key={track.id} value={track.id}>
      {track.label} · {t(`Video Summary Source ${track.sourceKind}`)}
    </option>
  ))}
</select>
```

Keep ASR as a separate explicit action. Convert CSS classes and `--bilibili-video-summary-width` to generic names. Map known YouTube and provider errors to localized text and map all unknown values to `Video Summary Unknown Error`; never display raw error strings.

- [ ] **Step 4: Run tests and delete old component files**

Run Step 2. Expected: PASS. Search imports before deleting the old files:

```bash
rg "BilibiliVideoSummaryView" src tests
```

Expected: only the old host import remains; Task 5 replaces it. Keep compatibility re-exports if required to maintain a green intermediate commit rather than deleting immediately.

- [ ] **Step 5: Commit**

```bash
git add src/components/VideoSummaryView src/components/BilibiliVideoSummaryView \
  tests/unit/components/video-summary-view.test.mjs \
  tests/unit/components/bilibili-video-summary-view.test.mjs \
  src/_locales/en/main.json src/_locales/zh-hans/main.json src/_locales/zh-hant/main.json
git commit -m "Generalize the video summary view"
```

---

### Task 5: Generalize and directly test the host

**Files:**
- Create: `src/content-script/video-summary-host.mjs`
- Create: `src/content-script/video-summary-host-width.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-summary-host.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-summary-host-width.mjs`
- Create: `tests/setup/video-summary-host-loader-hooks.mjs`
- Create: `tests/unit/content-script/video-summary-host.test.mjs`
- Modify: `tests/unit/content-script/bilibili-video-summary-host-width.test.mjs`

**Interfaces:**
- Produces: `mountVideoSummaryHost({ platform, bridge, targetElement, connect })`.
- Produces: generic width controller using `--video-summary-width`.
- Task attachment key is `documentId:platform:videoId`.

- [ ] **Step 1: Add host loader hooks and failing host tests**

The hook must transform JSX, return an empty SCSS module, and narrowly stub Browser, FileSaver, FloatingToolbar, config/session functions, and position utilities only for imports from the shared host. Test with a fake bridge:

```js
const bridge = {
  getCurrentVideoId: () => 'same-id',
  getSnapshot: async () => ({
    platform: 'youtube',
    videoId: 'same-id',
    title: 'Synthetic video',
    nativeSubtitleTracks: tracks,
    mediaCandidates: [],
  }),
  refreshSnapshot: async () => {},
  seekTo: (startMs) => seeks.push(startMs),
}
```

Assert preferred selection, exact selected ID in `START_TASK`, no ASR start before confirmation, platform-separated reattachment, platform archive/file metadata, action callbacks, and full disposal.

- [ ] **Step 2: Run host tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/video-summary-host.test.mjs \
  tests/unit/content-script/bilibili-video-summary-host-width.test.mjs
```

Expected: FAIL because the shared host modules do not exist.

- [ ] **Step 3: Implement the shared host**

Define immutable metadata:

```js
const PLATFORM_METADATA = Object.freeze({
  bilibili: Object.freeze({ productName: 'Bilibili', fileNameFallback: 'bilibili-video-summary' }),
  youtube: Object.freeze({ productName: 'YouTube', fileNameFallback: 'youtube-video-summary' }),
})
```

Store `selectedSubtitleTrackId` in host state, initialize it with `selectPreferredSubtitleTrack`, and pass the full list into `VideoSummaryView`. Start native tasks with the controlled ID. Pass `platform` into `createVideoSummaryPortClient`, use `documentId:platform:videoId` for attachment, and derive archive prompt/session/file names from metadata. Keep the old Bilibili files as re-exports until Task 6 updates callers.

- [ ] **Step 4: Run host tests**

Run Step 2. Expected: all host and width tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content-script/video-summary-host.mjs \
  src/content-script/video-summary-host-width.mjs \
  src/content-script/site-adapters/bilibili/video-summary-host.mjs \
  src/content-script/site-adapters/bilibili/video-summary-host-width.mjs \
  tests/setup/video-summary-host-loader-hooks.mjs \
  tests/unit/content-script/video-summary-host.test.mjs \
  tests/unit/content-script/bilibili-video-summary-host-width.test.mjs
git commit -m "Generalize the video summary host"
```

---

### Task 6: Move Bilibili onto the shared framework without regressions

**Files:**
- Modify: `src/content-script/site-adapters/bilibili/video-page-bridge.mjs`
- Modify: `src/content-script/site-adapters/bilibili/index.mjs`
- Modify: `tests/unit/content-script/bilibili-video-page-bridge.test.mjs`
- Create: `tests/unit/content-script/bilibili-adapter.test.mjs`

**Interfaces:**
- Bilibili bridge implements `refreshSnapshot({ expectedPlatform, expectedVideoId })`.
- Adapter calls `mountVideoSummaryHost({ platform: 'bilibili', bridge, targetElement })`.

- [ ] **Step 1: Write failing Bilibili compatibility tests**

Add bridge tests asserting wrong `expectedPlatform` fails before network access and correct full identity refreshes. Add adapter tests asserting the shared gate mounts with platform `bilibili`, enhanced mode returns `false`, and disabled/unsupported modes return `true` and preserve the legacy path.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/bilibili-adapter.test.mjs
```

Expected: FAIL because Bilibili still imports its dedicated host/gate and does not validate platform.

- [ ] **Step 3: Update bridge and adapter**

Validate refresh identity first:

```js
async refreshSnapshot({ expectedPlatform, expectedVideoId }) {
  if (expectedPlatform !== 'bilibili') throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
  const currentVideoId = getBilibiliVideoIdentity(getLocationHref()).videoId
  if (expectedVideoId && currentVideoId !== expectedVideoId) {
    throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
  }
  return getSnapshot()
}
```

Import the generic capability and host in the adapter and pass `platform: 'bilibili'`. Preserve WBI, AI-conclusion, multipart, selectors, and legacy `inputQuery` behavior.

- [ ] **Step 4: Run Bilibili tests**

Run Step 2. Expected: all Bilibili tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  src/content-script/site-adapters/bilibili/index.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/bilibili-adapter.test.mjs
git commit -m "Use shared video summaries on Bilibili"
```

---

### Task 7: Parse and normalize YouTube media safely

**Files:**
- Create: `src/content-script/site-adapters/youtube/media-source.mjs`
- Create: `tests/unit/content-script/youtube-media-source.test.mjs`
- Create: `tests/fixtures/youtube/watch-authored-and-auto.html`
- Create: `tests/fixtures/youtube/player-response-authored-auto.json`
- Create: `tests/fixtures/youtube/player-response-unavailable.json`
- Create: `tests/fixtures/youtube/timed-text-events.json`

**Interfaces:**
- Produces: `getYouTubeWatchIdentity(input)`, `extractYouTubePlayerResponse(html)`, `assertYouTubePlayerResponseIdentity(...)`, `assertYouTubePlayability(...)`, `normalizeYouTubeCaptionTracks(...)`, `parseYouTubeTimedText(payload)`, and `normalizeYouTubeAudioCandidates(...)`.

- [ ] **Step 1: Add sanitized fixtures and failing parser tests**

Fixtures must use synthetic IDs, `.invalid` hosts, fake expiry values, and short artificial cues. Test exact `/watch`, bounded video-ID validation, Shorts/embed/live rejection, balanced JSON with escaped braces/quotes, malformed/incomplete response errors, identity mismatch, playability status, caption ordering/classification, stable non-URL track IDs, timestamp parsing/entity decoding/deduplication, and HTTPS audio-only candidate normalization.

Representative assertion:

```js
const tracks = normalizeYouTubeCaptionTracks(playerResponse)
assert.deepEqual(tracks.map(({ sourceKind }) => sourceKind), ['author', 'automatic'])
assert.equal(tracks.every(({ id }) => !id.includes('http')), true)
assert.doesNotThrow(() => structuredClone(tracks))
```

- [ ] **Step 2: Run parser tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/youtube-media-source.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for YouTube `media-source.mjs`.

- [ ] **Step 3: Implement pure YouTube parsing**

Validate identity without accepting other routes:

```js
export function getYouTubeWatchIdentity(input) {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.pathname !== '/watch') return { videoId: null, supported: false }
  const videoId = url.searchParams.get('v') || ''
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { videoId: null, supported: false }
  return { videoId, supported: true }
}
```

Use a bounded balanced-JSON scanner modeled on Bilibili extraction, never `indexOf` plus an unbounded substring. Normalize caption descriptors without retaining base URLs in IDs. Parse JSON timed-text events (`events[].tStartMs`, `dDurationMs`, `segs[].utf8`) into valid cues. Normalize only HTTPS audio-only adaptive formats and backups with request origin `https://www.youtube.com/` and derived expiry.

- [ ] **Step 4: Run parser tests**

Run Step 2. Expected: all YouTube parser tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content-script/site-adapters/youtube/media-source.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs tests/fixtures/youtube
git commit -m "Parse YouTube video sources"
```

---

### Task 8: Implement the YouTube page bridge and page-owned subtitle acquisition

**Files:**
- Create: `src/content-script/site-adapters/youtube/video-page-bridge.mjs`
- Create: `src/background/youtube-page-data.mjs`
- Modify: `src/background/index.mjs`
- Modify: `build.mjs`
- Create: `scripts/build-module-rules.mjs`
- Create: `tests/unit/content-script/youtube-video-page-bridge.test.mjs`
- Create: `tests/unit/background/youtube-page-data.test.mjs`
- Create: `tests/unit/background/youtube-page-data-build.test.mjs`

**Interfaces:**
- Produces: `resolveYouTubeSourceSnapshot(...)` and `createYouTubeVideoPageBridge(...)` implementing the shared bridge interface.
- Produces: restricted messages `YOUTUBE_PAGE_PLAYER_RESPONSE` and `YOUTUBE_PAGE_CAPTURE_CAPTION`.
- Produces: capture modes `panelOnly`, `nativeOnly`, and `innertubeOnly`.
- Returns page-data envelopes `{ ok: true, data }` or safe failures `{ ok: false, errorCode, causeCode, stage }`.

- [x] **Step 1: Test the real subtitle-source order and identity boundaries**

Cover this exact source order:

1. official YouTube transcript-panel DOM once per snapshot;
2. native player `fetch`/XHR capture for each concrete authored/automatic track;
3. Innertube `get_transcript` once;
4. bounded timed-text URL replay as the last free fallback.

Tests also cover top-frame sender authorization, `(tabId, documentId, videoId)` serialization, SPA identity changes during every asynchronous stage, response size/segment limits, empty HTTP 200 bodies, state restoration, timeouts, and absence of sensitive logging.

- [x] **Step 2: Implement official transcript-panel extraction as the primary path**

Run the extractor in the page MAIN world. Expand the description and wait within one 15-second deadline for a matching opener. Support duplicate controls and localized labels including `Show transcript`, `Transcript`, `显示转录稿`, `顯示轉錄稿`, `文字稿`, and `内容转文字`.

Support both panel generations:

```text
target-id="PAmodern_transcript_view"
target-id="engagement-panel-searchable-transcript"
```

Select the expanded panel containing segments rather than the first matching panel. Parse legacy `ytd-transcript-segment-renderer` and modern `transcript-segment-view-model` nodes, including `ytwTranscriptSegmentViewModelTimestamp` and `ytAttributedStringHost[role="text"]`. Deduplicate `(startMs, text)`, derive cue ends from the next cue or player duration, enforce 5 MiB/10,000-segment limits, and close only a panel opened by the extension.

- [x] **Step 3: Implement native and protocol fallbacks without automatic ASR**

For `nativeOnly`, install MAIN-world `fetch` and XHR hooks before asking the player to load the exact track. Validate video ID, language, source kind, and `vssId`; accept only non-empty bounded responses; then restore the original caption track and CC state.

For `innertubeOnly`, use only the searchable-transcript engagement panel endpoint and support `getTranscriptEndpoint.params` or a valid `/youtubei/v1/get_transcript` continuation. URL replay preserves signed base parameters, adds JSON3 plus only allowlisted page-observed client/integrity parameters, validates non-empty content, and remains last.

- [x] **Step 4: Make page execution and diagnostics safe**

Background validates that the sender is the top frame of the matching `https://www.youtube.com/watch?v=...` tab. It serializes page operations per tab/document/video and never returns URLs, tokens, cookies, headers, or transcript bodies in diagnostics.

Handle Chrome `InjectionResult.error` explicitly and expose only safe error codes/stages. Content code unwraps the response envelope and uses failures to continue the approved fallback chain.

- [x] **Step 5: Preserve self-contained MAIN-world functions in production builds**

Functions passed as `chrome.scripting.executeScript({ func })` must not be transformed into wrappers that reference bundle-local Babel/regenerator helpers. Exclude `src/background/youtube-page-data.mjs` from Babel through `scripts/build-module-rules.mjs`; Chromium 116+ supports the retained native async syntax.

`tests/unit/background/youtube-page-data-build.test.mjs` performs a production Webpack build, serializes all four page functions, restores them in an isolated VM, and rejects bundle-local `ReferenceError` failures.

- [x] **Step 6: Add bounded initial discovery retry**

If the initial snapshot completes before YouTube renders its transcript controls and returns zero tracks with `not-found`/`unavailable`, `VideoSummaryHost` retries once after one second. Disposal or video navigation cancels or invalidates that retry; there is no unbounded polling.

- [x] **Step 7: Run focused and repository validation**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/youtube-page-data-build.test.mjs \
  tests/unit/background/youtube-page-data.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs \
  tests/unit/content-script/video-summary-host.test.mjs
npm run pretty
npm run lint
npm test
npm run build
```

Expected: page functions remain self-contained in the production bundle, all subtitle-source and lifecycle tests pass, and the full Chromium extension can automatically open/read the official transcript panel without user interaction.

---

### Task 9: Integrate enhanced YouTube adapter lifecycle

**Files:**
- Modify: `src/content-script/site-adapters/youtube/index.mjs`
- Create: `tests/unit/content-script/youtube-adapter.test.mjs`

**Interfaces:**
- Enhanced path mounts `mountVideoSummaryHost({ platform: 'youtube', bridge, targetElement })` and returns `false`.
- Legacy `inputQuery` remains active when any capability condition fails.

- [ ] **Step 1: Write failing adapter lifecycle tests**

Assert enhanced mounting only on ordinary non-live watch pages, stable visible `#secondary` selection, disposal/remount on `v` change, no remount for unrelated query changes, remount if YouTube replaces the target node, correct platform/bridge arguments, enhanced `false` return, and fallback `true` return for disabled, MV2, minimal, unsupported browser/page, or disabled site adapter conditions.

- [ ] **Step 2: Run adapter tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/youtube-adapter.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs
```

Expected: FAIL because the adapter always uses its legacy polling path.

- [x] **Step 3: Implement enhanced lifecycle while retaining fallback**

At the start of `init`, validate ordinary watch identity and the shared gate. In enhanced mode, create/dispose the shared host around the visible secondary column and observe normalized video identity plus target replacement. Coalesce concurrent host creation while YouTube is replacing the secondary column. Pass restricted page-data requests through Background and unwrap structured success/error envelopes. In fallback mode, leave the existing `inputQuery` callable and preserve the adapter registry contract. Never log page/caption data.

Subtitle discovery is automatic: the user does not need to click CC or “内容转文字”. The MAIN-world panel extractor waits for the control, opens the appropriate modern/legacy transcript panel, reads it, and restores extension-owned state. The host performs one bounded retry if initial discovery finishes before YouTube renders the control.

- [x] **Step 4: Run adapter tests**

Run Step 2. Expected: all YouTube adapter and bridge tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content-script/site-adapters/youtube/index.mjs \
  tests/unit/content-script/youtube-adapter.test.mjs
git commit -m "Enable enhanced YouTube video summaries"
```

---

### Task 10: Exercise both platforms through the full fake pipeline

**Files:**
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

**Interfaces:**
- Integration factories accept `platform`, `requiredRequestOrigin`, and full owner identity.
- Both platforms use the generic port constants and client.

- [ ] **Step 1: Add failing YouTube end-to-end scenarios**

Extend `createCandidate`, `createSourceSnapshot`, and `mountClient` with platform. Add tests for authored subtitle, automatic subtitle, confirmed direct ASR, direct failure plus OPFS upload, cancel/reattach, expired source refresh, checkpoint retry, and equal video IDs on different platforms.

The isolation test must use the same tab, document, task, and video ID but different platforms:

```js
assert.equal(bilibiliEvents.some(({ owner }) => owner.platform === 'youtube'), false)
assert.equal(youtubeEvents.some(({ owner }) => owner.platform === 'bilibili'), false)
```

- [ ] **Step 2: Run integration test and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: FAIL until all harness factories and refresh paths pass platform identity.

- [ ] **Step 3: Update the fake harness and expectations**

Use `VIDEO_SUMMARY_PORT_NAME`, pass platform into every client/start/owner, validate both expected refresh fields, and preserve all existing Bilibili scenarios. Do not mock away Background/offscreen ownership validation.

- [ ] **Step 4: Run integration test**

Run Step 2. Expected: all Bilibili and YouTube fake end-to-end scenarios PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/video-summary/end-to-end-fakes.test.mjs
git commit -m "Cover YouTube video summary workflows"
```

---

### Task 11: Remove compatibility names and verify production artifacts

**Files:**
- Modify: `src/content-script/video-summary-chatgpt-proxy.mjs`
- Modify: `src/content-script/index.jsx`
- Modify: `tests/unit/content-script/video-summary-chatgpt-proxy.test.mjs`
- Modify: `tests/unit/background/video-summary-chatgpt-proxy.test.mjs`
- Delete: obsolete Bilibili compatibility host/port/view files after all imports move
- Modify: any source/test file found by the stale-name scan

**Interfaces:**
- Generic proxy prefix: `video-summary-chatgpt-proxy:`.
- No generic framework symbol, port, build flag, config field, CSS class, or error retains a Bilibili-only name.
- Site-specific Bilibili parsing/WBI errors remain unchanged.

- [ ] **Step 1: Update proxy tests to expect generic naming**

Change prefix assertions to:

```js
assert.match(proxyMessage.requestId, /^video-summary-chatgpt-proxy:/)
```

Add a source scan assertion or perform the explicit scan in Step 2.

- [ ] **Step 2: Run tests and stale-name scans to establish RED/cleanup list**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/video-summary-chatgpt-proxy.test.mjs \
  tests/unit/background/video-summary-chatgpt-proxy.test.mjs
rg "bilibili-video-summary|__ENABLE_BILIBILI_VIDEO_TRANSCRIPTION__|bilibiliVideoTranscriptionEnabled|BilibiliVideoSummaryView" src tests build.mjs
rg "BILIBILI_(MEDIA_CANDIDATE_NOT_FOUND|VIDEO_IDENTITY_CHANGED|SUBTITLE_TRACK_NOT_FOUND)" src tests
```

Expected: proxy tests or scans reveal remaining generic Bilibili-only names. Legacy config migration reads and genuinely site-specific bridge errors are allowed only where documented.

- [ ] **Step 3: Complete cleanup and remove compatibility files**

Rename the proxy prefix and content-script filter, replace remaining imports with shared paths, remove compatibility re-exports after confirming no callers remain, and preserve only:

```text
bilibiliVideoTranscriptionEnabled  # migration input only
BILIBILI_*                         # Bilibili extraction/WBI/API errors only
```

- [ ] **Step 4: Run required repository validation**

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Expected: all commands exit 0. Allow the production build 5–10 minutes and do not interrupt bundling.

- [ ] **Step 5: Inspect artifacts**

```bash
test -f build/chromium/VideoSummaryOffscreen.html && \
  test -f build/chromium/VideoSummaryOffscreen.js && \
  test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html && \
  test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.js && \
  test -f build/chromium/manifest.json && \
  test -f build/chromium/background.js && \
  test -f build/chromium/content-script.js && \
  test -f build/chromium/popup.js && \
  test -f build/chromium/IndependentPanel.js
```

Expected: exit 0; full Chromium contains offscreen artifacts and minimal Chromium excludes them.

- [ ] **Step 6: Perform manual extension smoke tests**

Load `build/chromium/` unpacked and verify: one authored-caption YouTube video, one automatic-caption video, one no-caption video through confirmed ASR, SPA navigation, timestamp seek, cancel, archive, Markdown export, follow-up chat, disabled fallback, and Bilibili regression. Confirm no sensitive values appear in page, background, popup, or offscreen consoles.

- [ ] **Step 7: Commit final cleanup**

```bash
git add src tests build.mjs
git commit -m "Complete shared YouTube video summaries"
```
