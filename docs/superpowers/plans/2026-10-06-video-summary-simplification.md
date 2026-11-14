# Video Summary Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Bilibili and YouTube one strict enhanced-summary capability gate and lifecycle, release non-retryable task resources, and delete proven-unused code without changing summary behavior or protocols.

**Architecture:** Keep capability policy in `src/video-summary/capabilities.mjs`, collect browser facts once in content code, and route both adapters through a shared host lifecycle controller. Keep extraction and identity in site bridges. Add explicit task release semantics while retaining checkpoints needed by summary-only retry.

**Tech Stack:** Node.js 22+, ES modules, Preact, `webextension-polyfill`, Node `node:test`, Webpack 5, ESLint, Prettier.

## Global Constraints

- Preserve model/provider behavior, prompts, result and persistence formats, localization, archive/export behavior, and all cross-context protocols.
- Enhanced mode requires the build flag, `videoTranscriptionEnabled`, Manifest V3, declared `offscreen` permission, Chromium 116+, and Chrome/Edge identity.
- Capability errors select the legacy adapter path.
- Site eligibility stays site-specific; site extraction stays in each bridge.
- Bridge subscriptions are the only enhanced video-identity signal; shared target monitoring handles DOM replacement only.
- Host disposal does not immediately cancel tasks; preserve the 15-second attachment grace period.
- Retain successful/checkpointed tasks for summary retry; release cancellation and non-checkpoint failure state.
- Add no dependencies, permissions, or protocol messages.
- Do not commit changes.

---

### Task 1: Strict shared capability gate

**Files:**
- Modify: `src/video-summary/capabilities.mjs`
- Create: `src/content-script/video-summary-capability.mjs`
- Modify: `src/popup/sections/VideoSummarySettings.jsx`
- Modify: `tests/unit/video-summary/capabilities.test.mjs`
- Create: `tests/unit/content-script/video-summary-capability.test.mjs`

**Interfaces:**
- Produce `isVideoSummaryAvailable(config, runtimeFacts): boolean`.
- Produce `isEnhancedVideoSummaryAvailable(config, dependencies?): boolean`.
- Runtime facts are `{ manifestVersion, hasOffscreenPermission, minChromeVersion, userAgent }`.

- [ ] Write matrix tests for disabled setting/build, MV2, absent permission, Chrome 115, Firefox/Safari, Chrome 116+, Edge 116+, malformed facts, and manifest access failure.
- [ ] Run:
  ```bash
  node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/capabilities.test.mjs tests/unit/content-script/video-summary-capability.test.mjs
  ```
  Expected: fail because the strict APIs do not exist.
- [ ] Implement the pure gate:
  ```js
  export function isVideoSummaryRuntimeSupported({
    manifestVersion,
    hasOffscreenPermission,
    minChromeVersion,
    userAgent,
  } = {}) {
    return (
      manifestVersion === 3 &&
      hasOffscreenPermission === true &&
      Number.parseInt(String(minChromeVersion || '0'), 10) >= 116 &&
      /(?:Chrome|Edg)\//.test(String(userAgent || ''))
    )
  }

  export function isVideoSummaryAvailable(config, runtimeFacts) {
    return (
      isVideoSummaryBuildEnabled() &&
      config?.videoTranscriptionEnabled === true &&
      isVideoSummaryRuntimeSupported(runtimeFacts)
    )
  }
  ```
- [ ] Implement `isEnhancedVideoSummaryAvailable` to read `Browser.runtime.getManifest()`, map the declared `offscreen` permission, pass `navigator.userAgent`, and return `false` on errors.
- [ ] Update popup facts from `hasOffscreenApi` to `hasOffscreenPermission`.
- [ ] Remove old `isVideoSummaryEnabled` and Bilibili alias after adapters migrate.
- [ ] Re-run focused capability and popup tests; expect PASS.

### Task 2: Shared enhanced-adapter lifecycle

**Files:**
- Create: `src/content-script/video-summary-adapter-controller.mjs`
- Create: `tests/unit/content-script/video-summary-adapter-controller.test.mjs`

**Interfaces:**
- Consume `{ platform, createBridge, findTargetElement, waitForTargetElement, isPageSupported }`.
- Produce `{ start(): Promise<void>, dispose(): void }`.
- Inject `mountHost`, `setIntervalFn`, and `clearIntervalFn` for tests.

- [ ] Write tests proving one healthy host, navigation replacement, target-only replacement without a new bridge, temporary target absence/recovery, coalesced concurrent reconciliation, unsupported-page teardown/recovery, and complete disposal.
- [ ] Run the new test; expect `ERR_MODULE_NOT_FOUND`.
- [ ] Implement a serialized reconciliation loop with these invariants:
  ```js
  function replaceBridge() {
    unsubscribe?.()
    bridge = createBridge()
    unsubscribe = bridge.subscribeToVideoChanges(() => {
      void requestReconciliation({ replaceBridge: true })
    })
  }
  ```
  Navigation replaces the bridge; target recovery reuses it; generation checks reject stale waits; unchanged identity/target never remounts.
- [ ] Use one 500 ms shared target-recovery monitor only for target replacement/removal.
- [ ] Run the focused controller test; expect PASS.

### Task 3: Migrate both adapters

**Files:**
- Modify: `src/content-script/site-adapters/bilibili/index.mjs`
- Modify: `src/content-script/site-adapters/youtube/index.mjs`
- Modify: `tests/unit/content-script/bilibili-adapter.test.mjs`
- Modify: `tests/unit/content-script/youtube-adapter.test.mjs`
- Verify: both `video-page-bridge.mjs` files.

**Interfaces:**
- Both adapters call `isEnhancedVideoSummaryAvailable(userConfig)`.
- Both enhanced branches create the shared controller.

- [ ] Update loader hooks/tests to stub the shared gate and controller and assert platform, target lookup, eligibility, bridge creation, one `start`, enhanced return `false`, and legacy return `true`.
- [ ] Preserve tests for bangumi exclusion, YouTube malformed/Shorts/live pages, and YouTube page-data RPC envelopes.
- [ ] Run both adapter tests; expect failures against the old direct host lifecycle.
- [ ] Replace Bilibili enhanced polling with controller configuration for `#danmukuBox`; retain only legacy polling.
- [ ] Replace YouTube enhanced polling with controller configuration for `SECONDARY_COLUMN_SELECTOR`; retain only legacy polling.
- [ ] Run adapter, controller, and both bridge navigation tests; expect PASS.

### Task 4: Remove obsolete compatibility UI and aliases

**Files:**
- Modify: `src/content-script/video-summary-host.mjs`
- Modify: `tests/unit/content-script/video-summary-host.test.mjs`
- Rename: Bilibili-named shared port and width tests to generic names.
- Delete: `src/components/BilibiliVideoSummaryView/`
- Delete: `tests/unit/components/bilibili-video-summary-view.test.mjs`
- Delete: Bilibili `video-summary-host.mjs`, `video-summary-port.mjs`, and `video-summary-host-width.mjs` forwarding files.
- Delete: `src/popup/sections/BilibiliVideoTranscriptionSettings.jsx`
- Delete: its old-path test.

- [ ] Change host tests to call:
  ```js
  mountVideoSummaryHost({ platform: 'bilibili', bridge, targetElement, connect })
  ```
- [ ] Preserve disposal assertions and verify no `CANCEL_TASK` is posted on host disposal.
- [ ] Rename the shared tests and update platform-neutral test names.
- [ ] Run host, port, width, generic view, and settings tests; expect PASS.
- [ ] Delete aliases, forwarding files, superseded component/styles/tests, and popup shim/test.
- [ ] Search removed names and paths; expect no matches.

### Task 5: Explicit task retention and release

**Files:**
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Modify: `src/pages/VideoSummaryOffscreen/runtime.mjs`
- Modify: `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`

**Interfaces:**
- Runner retains `start`, `retry`, and `cancel`; add `release(taskId)`.
- Keep only retry-required command data: task ID, owner, settings snapshot, model snapshot.

- [ ] Add tests proving successful/checkpointed failure retry, pre-transcription failure release, cancellation release, and explicit completed-task release.
- [ ] Run runner tests; expect failures because release semantics do not exist.
- [ ] Add:
  ```js
  function releaseTask(taskId) {
    controllers.get(taskId)?.abort()
    controllers.delete(taskId)
    checkpoints.delete(taskId)
    commands.delete(taskId)
    emits.delete(taskId)
  }
  ```
- [ ] Store a sanitized retry command instead of source snapshots, signed media URLs, or callbacks.
- [ ] Release failures only when no transcription checkpoint exists; retain result/checkpointed failures.
- [ ] Make `cancel` and `release` use `releaseTask`.
- [ ] Add offscreen tests proving cancel/non-checkpoint failure removes owner binding while result/checkpointed failure keeps retry ownership.
- [ ] Delete owner bindings after validated cancellation and non-checkpoint failure; add no protocol command.
- [ ] Run runner and offscreen tests; expect PASS.

### Task 6: Router and end-to-end lifecycle cleanup

**Files:**
- Modify: `src/background/video-summary-router.mjs`
- Modify: `src/background/index.mjs`
- Modify: `tests/unit/background/video-summary-router.test.mjs`
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

- [ ] Add integration assertions that disconnect expiry and tab removal release retry state, while reattachment inside 15 seconds preserves it and checkpoint retry does not rerun transcription.
- [ ] Run router and integration tests; expect lifecycle assertions to fail before cleanup wiring.
- [ ] Remove unused `mediaKitGateway` and `modelGateway` router parameters and all corresponding call-site fixtures.
- [ ] Remove the unused `VIDEO_SUMMARY_TASK_EVENT` runtime-message case; keep offscreen RPC event routing.
- [ ] Ensure existing cancellation paths reach runner/offscreen release.
- [ ] Run router, offscreen, and integration tests; expect PASS.

### Task 7: Delete abandoned implementation code

**Files:**
- Delete: `src/services/apis/openai-compatible-tool-call.mjs`
- Delete: its dedicated test.
- Modify: `src/services/apis/volcengine-mediakit.mjs`
- Modify: `src/content-script/site-adapters/bilibili/media-source.mjs`
- Modify: corresponding media-source test.
- Modify: `src/video-summary/result-builder.mjs`
- Modify: corresponding result-builder test.

- [ ] Search all candidate symbols before deletion and stop if a new production consumer exists.
- [ ] Delete the unused structured-tool module/test.
- [ ] Remove only unused `pollMediaKitTask`; retain submit/query/normalization APIs.
- [ ] Remove `extractBilibiliPlayInfo` and `selectPreferredBilibiliSubtitleTrack` plus only their direct obsolete tests.
- [ ] Import time helpers in tests from `src/video-summary/time.mjs`, then remove result-builder time re-exports.
- [ ] Run all directly affected unit tests; expect PASS.
- [ ] Search all removed names/paths; expect no matches.

### Task 8: Focused regression verification

- [ ] Run all video-summary, adapter, bridge, popup, component, router, offscreen, and integration tests with the browser shim.
- [ ] Search capability call sites and verify both adapters use the same content helper, only helper/popup collect runtime facts, and `hasOffscreenApi` is absent.
- [ ] Search `setInterval` and `subscribeToVideoChanges`; verify bridges own identity subscriptions, the controller owns target recovery, enhanced adapter branches have no identity interval, and legacy polling remains.
- [ ] Inspect `git diff --stat master...HEAD` and working-tree diff to confirm edits remain inside the approved video-summary scope.

### Task 9: Repository-required validation

- [ ] Run `npm run pretty`; expect exit 0.
- [ ] Run `npm run lint`; expect exit 0.
- [ ] Run `npm test`; expect all tests PASS.
- [ ] Run `npm run build` with a 10-minute timeout; expect exit 0.
- [ ] Inspect artifacts: full Chromium contains `VideoSummaryOffscreen.html/js`; Firefox and both minimal outputs do not.
- [ ] Run `git status --short` and `git diff --check`; expect only intended source/test/spec/plan changes and no whitespace errors.
- [ ] Report manual browser smoke testing as not run unless actually performed.
