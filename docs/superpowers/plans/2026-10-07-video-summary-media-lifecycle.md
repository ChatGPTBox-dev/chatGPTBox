# Video Summary Media and Page Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Increment 2 of enhanced video-summary hardening with capability-bound paid operations, bounded cancellable RPC, governed media transfer and polling, terminal OPFS cleanup, page-mode reconciliation, and race-safe UI actions.

**Architecture:** Background owns exact-fence gateway capabilities, single-use submission reservations, and abortable provider calls; Offscreen owns attempt-local RPC promises, media sequencing, polling, and task-scoped OPFS. Content owns a page-generation-scoped `enhanced | legacy | none` handle and exposes only actions valid for the current retained or executing state.

**Tech Stack:** Node 22+, JavaScript ES modules, WebExtension MV3 and Offscreen APIs, Preact, `node:test`, `node:assert`, JSDOM, Webpack 5.

## Global Constraints

- **Dependency:** Complete `docs/superpowers/plans/2026-10-07-video-summary-protocol-hardening.md` before starting this plan; this plan consumes its canonical `PageIdentity`, task fence, authenticated ports, Background coordinator, unified attempt start, release/delete protocol, and retained-task lifecycle without a compatibility path.
- Enhanced summaries remain available only in the full Chromium MV3 build on Chrome/Edge 116+; Firefox, Safari, minimal builds, disabled settings, and unsupported pages retain legacy behavior.
- Background remains the sole owner of credentials, gateway capability authorization, provider task IDs, and paid-operation reservations.
- Offscreen receives no API key, cookie, arbitrary request header, or caller-owned privileged identity.
- Pending gateway RPCs are limited to exactly 16 per task generation; excess requests fail before posting with `VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED`.
- `requiredRequestOrigin` is metadata only. Offscreen does not synthesize `Origin`, `Referer`, cookies, or arbitrary headers; a local transport that requires headers Offscreen cannot set is ineligible for fallback.
- Initial and redirected local media URLs are independently revalidated before any response body is read.
- An ambiguous direct or uploaded-media submission consumes its reservation, returns `VIDEO_SUMMARY_SUBMISSION_UNKNOWN`, and is never automatically retried or converted to fallback.
- Cancellation revokes capability before aborting network work and starts no new stage after cancellation is observed; it does not promise rollback of an already accepted remote request.
- Every OPFS task directory is deleted on all terminal paths: success, retryable failure, terminal failure, explicit cancellation, navigation/disconnect deletion, runtime command rejection after directory creation, and startup crash recovery.
- No persistent cleanup journal, persistent task recovery, dual protocol, generic privileged fetch, new runtime dependency, or provider billing guarantee is introduced.
- Canonical duration must be finite, positive, and at most `10_800_000` ms; candidate mismatch tolerance is `max(2_000 ms, canonicalDurationMs * 0.01)`.
- Polling starts at 2 seconds, grows exponentially to 30 seconds, applies injectable ±20% jitter, clamps `retryAfterMs` to 2–30 seconds, stops after five consecutive transient failures, and has a two-hour total deadline.
- OPFS reserves `max(64 MiB, 10% of quota)` and enforces a 1 GiB streaming hard limit per task.
- Follow red-green-refactor for every production change. Do not begin a GREEN implementation until the named RED command fails for the stated reason.
- Run `npm run pretty`, `npm run lint`, `npm test`, and `npm run build` before completion.

## File Structure

### New modules

- `src/video-summary/media-policy.mjs` — pure canonical-duration, candidate-duration, initial/local URL, redirect, and upload-target validation.
- `tests/unit/video-summary/media-policy.test.mjs` — exhaustive policy boundary tests with sanitized production-shaped URLs.
- `tests/unit/video-summary/opfs.test.mjs` — quota, streaming limit, redirect, abort, task cleanup, and bootstrap cleanup tests.

### Modified boundaries

- `src/background/video-summary-coordinator.mjs` — exact-fence capability state and single-use reservation transitions.
- `src/background/video-summary-offscreen-rpc.mjs` — authorization, per-generation controller maps, cancellation, and safe responses.
- `src/background/media-kit-gateway.mjs` — signal-aware narrow MediaKit calls and validated upload target issuance.
- `src/background/model-gateway.mjs` — signal-aware current-attempt model calls.
- `src/background/index.mjs` — wires coordinator authorization and gateway cancellation.
- `src/video-summary/protocol.mjs` — gateway/cancel schemas and the 16-pending-RPC limit.
- `src/video-summary/contracts.mjs` — stable operation names only.
- `src/pages/VideoSummaryOffscreen/runtime.mjs` — task-scoped RPC accounting, abort propagation, and bootstrap cleanup barrier.
- `src/video-summary/media-pipeline.mjs` — submission consumption, fallback sequencing, and bounded polling.
- `src/video-summary/opfs.mjs` — quota reserve, conservative size estimate, 1 GiB stream cap, redirect validation, and cleanup primitives.
- `src/video-summary/task-runner.mjs` — independent bounded cleanup signal on every terminal path.
- `src/content-script/video-summary-adapter-controller.mjs` — one page-generation-scoped mode handle.
- `src/content-script/site-adapters/bilibili/index.mjs` — BVID+CID mode eligibility.
- `src/content-script/site-adapters/youtube/index.mjs` — watch/live/Shorts/unsupported mode eligibility.
- `src/content-script/video-summary-host.mjs` — stale-async guards, synchronous action latch, cancel/retry state.
- `src/content-script/video-summary-port.mjs` — generation-level cancel and retained retry ACK state.
- `src/components/VideoSummaryView/index.jsx` — disabled source controls and Cancel/Retry visibility.
- `src/components/VideoSummaryView/styles.scss` — disabled/busy/cancel action presentation.
- `src/_locales/en/main.json` — English Cancel, cancelling, reattaching, and transport-policy messages.

---

### Task 1: Exact-Fence Gateway Capabilities and Single-Use Reservations

**Files:**
- Modify: `src/background/video-summary-coordinator.mjs`
- Modify: `src/background/video-summary-offscreen-rpc.mjs`
- Modify: `src/background/index.mjs`
- Modify: `src/video-summary/protocol.mjs`
- Modify: `src/video-summary/contracts.mjs`
- Modify: `tests/unit/background/video-summary-coordinator.test.mjs`
- Modify: `tests/unit/background/video-summary-offscreen-rpc.test.mjs`
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

**Interfaces:**
- Consumes from the protocol plan:
  ```js
  fencesEqual(left, right)
  parseOffscreenMessage(message)
  coordinator.handleOffscreenMessage(message)
  ```
- Produces:
  ```js
  coordinator.authorizeGatewayRequest({ fence, requestId, gateway, operation, args })
  coordinator.completeGatewayRequest({ fence, requestId, gateway, operation, outcome })
  coordinator.revokeGenerationCapability({ owner, taskId, generation })
  coordinator.revokeAttemptModelCapability(fence)
  ```
- `authorizeGatewayRequest` returns a structured-clone-safe object:
  ```js
  {
    args,
    reservation:
      | null
      | { kind: 'direct-submit' }
      | { kind: 'fallback-transition' }
      | { kind: 'upload-target' }
      | { kind: 'fallback-submit' },
  }
  ```
- Capability state is exactly:
  ```js
  {
    owner,
    taskId,
    generation,
    sourceChoice,
    asrConfirmed,
    candidateUrls,
    directSubmission: 'available' | 'consumed' | 'fallback-eligible',
    fallbackSubmission: 'unavailable' | 'target-issued' | 'consumed',
    uploadTarget: null | { url, method, headers, fileReference },
    providerTaskId: null | string,
    currentAttempt: null | { attempt, modelIdentity },
    revoked: boolean,
  }
  ```
- Gateway operations are limited to `submitDirectAsr`, `markFallbackEligible`, `requestUploadTarget`, `submitUploadedAsr`, `queryTask`, `describeCapabilities`, and `generateText`.

- [ ] **Step 1: Write failing capability and reservation tests**

Add table-driven tests that construct two generations and two attempts, then assert these exact outcomes:

```js
const cases = [
  ['native subtitle cannot submit ASR', nativeFence, 'mediakit', 'submitDirectAsr'],
  ['old attempt cannot call model', oldAttemptFence, 'model', 'generateText'],
  ['different candidate cannot be substituted', asrFence, 'mediakit', 'submitDirectAsr'],
  ['different provider task cannot be queried', asrFence, 'mediakit', 'queryTask'],
  ['different upload target cannot be submitted', asrFence, 'mediakit', 'submitUploadedAsr'],
  ['different model cannot be substituted', asrFence, 'model', 'generateText'],
]
for (const [name, fence, gateway, operation] of cases) {
  test(name, () => {
    assert.throws(
      () => coordinator.authorizeGatewayRequest({ fence, requestId: name, gateway, operation, args }),
      /VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED/,
    )
  })
}
```

Also assert before any fake gateway call:

```js
assert.equal(firstDirect.reservation.kind, 'direct-submit')
assert.throws(() => authorizeDirectAgain(), /VIDEO_SUMMARY_SUBMISSION_ALREADY_CONSUMED/)
assert.throws(() => requestUploadTarget(), /VIDEO_SUMMARY_FALLBACK_NOT_ELIGIBLE/)
markFallbackEligible({ providerTaskId: 'provider-task-1', providerCode: 'URL_DOWNLOAD_FAILED' })
assert.equal(authorizeUploadTarget().reservation.kind, 'upload-target')
assert.throws(() => authorizeUploadTarget(), /VIDEO_SUMMARY_UPLOAD_TARGET_ALREADY_ISSUED/)
assert.equal(authorizeFallbackSubmit().reservation.kind, 'fallback-submit')
assert.throws(() => authorizeFallbackSubmit(), /VIDEO_SUMMARY_SUBMISSION_ALREADY_CONSUMED/)
```

- [ ] **Step 2: Run the capability tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/video-summary-coordinator.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: FAIL because `authorizeGatewayRequest`, reservation transitions, and exact-fence gateway messages are absent.

- [ ] **Step 3: Implement minimal exact-fence authorization**

Use one synchronous authorization switch in the coordinator:

```js
function authorizeGatewayRequest({ fence, requestId, gateway, operation, args }) {
  const capability = requireExecutableCapability(fence)
  requireBoundedId(requestId)

  if (gateway === 'model') {
    requireCurrentAttemptModel(capability, fence, args?.modelSnapshot)
    return { args: structuredClone(args), reservation: null }
  }

  requireAsrCapability(capability)
  if (operation === 'submitDirectAsr') return reserveDirectSubmission(capability, args)
  if (operation === 'markFallbackEligible') return markFallbackEligible(capability, args)
  if (operation === 'requestUploadTarget') return reserveUploadTarget(capability, args)
  if (operation === 'submitUploadedAsr') return reserveFallbackSubmission(capability, args)
  if (operation === 'queryTask') return authorizeRecordedTaskQuery(capability, args)
  throw createProtocolError('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')
}
```

Reservation rules must execute before network I/O. `submitDirectAsr` changes `available → consumed`; `markFallbackEligible` alone changes `consumed → fallback-eligible` and requires the recorded provider task ID plus `URL_DOWNLOAD_FAILED` or `AUDIO_URL_DOWNLOAD_FAILED`; upload target changes `fallback-eligible → target-issued`; uploaded submission changes `target-issued → consumed`. Pending, active, completed, non-download-failure, and unknown submission outcomes never restore a consumed reservation.

- [ ] **Step 4: Wire authorization before gateway dispatch**

`video-summary-offscreen-rpc.mjs` must parse `{ requestId, fence, gateway, operation, args }`, call `authorizeGatewayRequest` synchronously, and invoke only the authorized operation/arguments. Route the result through `completeGatewayRequest` so only a successful direct/upload submission records its provider task ID; an error with unknown acceptance leaves the reservation consumed.

- [ ] **Step 5: Add capability lifecycle tests**

Assert cancellation revokes before fake fetch abort, attempt terminal removes only `currentAttempt`, retained checkpoints grant no gateway access, summary retry grants only the new attempt/model, task deletion removes the generation capability, and Offscreen reset clears all capabilities.

- [ ] **Step 6: Run the capability tests and verify GREEN**

Run the Step 2 command.

Expected: PASS; fake gateway call counts remain zero for every denied or duplicate operation.

- [ ] **Step 7: Commit**

```bash
git add src/background/video-summary-coordinator.mjs \
  src/background/video-summary-offscreen-rpc.mjs \
  src/background/index.mjs \
  src/video-summary/protocol.mjs \
  src/video-summary/contracts.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
git commit -m "Authorize video summary gateway operations"
```

---

### Task 2: Sixteen-RPC Limit and End-to-End Cancellation

**Files:**
- Modify: `src/pages/VideoSummaryOffscreen/runtime.mjs`
- Modify: `src/background/video-summary-offscreen-rpc.mjs`
- Modify: `src/background/media-kit-gateway.mjs`
- Modify: `src/background/model-gateway.mjs`
- Modify: `src/background/index.mjs`
- Modify: `src/services/apis/volcengine-mediakit.mjs`
- Modify: `src/video-summary/protocol.mjs`
- Modify: `src/video-summary/contracts.mjs`
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`
- Modify: `tests/unit/background/video-summary-offscreen-rpc.test.mjs`
- Modify: `tests/unit/background/media-kit-gateway.test.mjs`
- Modify: `tests/unit/background/model-gateway.test.mjs`
- Modify: `tests/unit/services/apis/volcengine-mediakit.test.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`

**Interfaces:**
- Consumes Task 1 exact-fence authorization.
- Produces protocol messages:
  ```js
  { type: 'GATEWAY_REQUEST', requestId, fence, gateway, operation, args }
  { type: 'CANCEL_GATEWAY_REQUEST', requestId, fence }
  { type: 'GATEWAY_RESPONSE', requestId, fence, ok, result?, error? }
  ```
- Produces Offscreen helper:
  ```js
  requestGateway({ fence, gateway, operation, args, signal }): Promise<unknown>
  cancelPendingGatewayRequests({ owner, taskId, generation }): void
  ```
- Offscreen and Background store pending requests in nested Maps by owner fields → task ID → generation → attempt → request ID. No delimiter-joined composite key is used.
- The Offscreen pending map is grouped by generation and allows at most `VIDEO_SUMMARY_PROTOCOL_LIMITS.pendingRpcsPerTask === 16` unsettled requests.

- [ ] **Step 1: Write failing 16-request boundary tests**

Create 16 unresolved requests for one generation and assert all are posted. Issue request 17 and assert synchronous rejection without a seventeenth post:

```js
assert.equal(posted.filter(({ type }) => type === 'GATEWAY_REQUEST').length, 16)
await assert.rejects(
  requestGateway({ fence, gateway: 'model', operation: 'generateText', args: {}, signal }),
  /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
)
assert.equal(posted.filter(({ type }) => type === 'GATEWAY_REQUEST').length, 16)
```

Resolve one request and assert the next request can be posted. Create 16 requests under another generation and assert the limit is independent.

- [ ] **Step 2: Write failing cancellation tests for every boundary**

Assert task abort sends one cancel message per pending request and rejects local promises with `AbortError`. In Background fakes, hold refresh, upload-target creation, direct submission, uploaded submission, query, and model generation; assert exact-fence cancellation aborts each signal. In runner tests, assert cancellation while waiting does not begin the following stage.

- [ ] **Step 3: Run RPC and cancellation tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/unit/background/media-kit-gateway.test.mjs \
  tests/unit/background/model-gateway.test.mjs \
  tests/unit/services/apis/volcengine-mediakit.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs
```

Expected: FAIL because requests are not limited per generation, cancel messages are unsupported, and provider fetches do not consistently receive `signal`.

- [ ] **Step 4: Implement task-scoped pending accounting**

Use this lifecycle in Offscreen:

```js
function requestGateway({ fence, gateway, operation, args, signal }) {
  throwIfAborted(signal)
  const generationPending = getOrCreateGenerationMap(pendingGatewayRequests, fence)
  const attemptPending = getOrCreateNestedMap(generationPending, fence.attempt)
  if (countGenerationRequests(generationPending) >= VIDEO_SUMMARY_PROTOCOL_LIMITS.pendingRpcsPerTask) {
    return Promise.reject(createProtocolError('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED'))
  }
  const requestId = createRequestId()
  const promise = registerPendingRequest({ pending: attemptPending, requestId, fence, signal })
  postMessage({ type: 'GATEWAY_REQUEST', requestId, fence, gateway, operation, args })
  return promise
}
```

The abort listener posts `CANCEL_GATEWAY_REQUEST` before deleting local state. Response, abort, disconnect, and synchronous post failure remove listeners and delete an empty generation map.

- [ ] **Step 5: Implement Background controller ownership and provider abort**

For every accepted request, allocate an `AbortController` in nested Maps by fence fields and request ID. Handle cancel only when every fence field and request ID match. Cleanup must use identity protection:

```js
const requests = getOrCreateAttemptMap(controllers, fence)
const controller = new AbortController()
requests.set(requestId, controller)
try {
  return await gateway[operation](authorizedArgs, { signal: controller.signal })
} finally {
  if (requests.get(requestId) === controller) requests.delete(requestId)
  removeEmptyFenceMaps(controllers, fence)
}
```

Pass `signal` through key lookup, upload-target request, direct/uploaded submission, query, upload, and model generation. Check `throwIfAborted(signal)` before each network call and after each awaited response parse. Generation cancellation first revokes capability, then aborts every matching controller.

- [ ] **Step 6: Run RPC and cancellation tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; request 17 is never posted, cancellation reaches all named boundaries, stale cancellation cannot abort a newer request reusing an ID, and no post-cancel stage begins.

- [ ] **Step 7: Commit**

```bash
git add src/pages/VideoSummaryOffscreen/runtime.mjs \
  src/background/video-summary-offscreen-rpc.mjs \
  src/background/media-kit-gateway.mjs \
  src/background/model-gateway.mjs \
  src/background/index.mjs \
  src/services/apis/volcengine-mediakit.mjs \
  src/video-summary/protocol.mjs \
  src/video-summary/contracts.mjs \
  src/video-summary/task-runner.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs \
  tests/unit/background/media-kit-gateway.test.mjs \
  tests/unit/background/model-gateway.test.mjs \
  tests/unit/services/apis/volcengine-mediakit.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs
git commit -m "Bound and cancel video summary RPCs"
```

---

### Task 3: Duration, Media URL, Redirect, and Upload Policy

**Files:**
- Create: `src/video-summary/media-policy.mjs`
- Create: `tests/unit/video-summary/media-policy.test.mjs`
- Modify: `src/content-script/site-adapters/bilibili/media-source.mjs`
- Modify: `src/content-script/site-adapters/youtube/media-source.mjs`
- Modify: `src/video-summary/media-pipeline.mjs`
- Modify: `src/video-summary/opfs.mjs`
- Modify: `src/background/media-kit-gateway.mjs`
- Modify: `tests/unit/content-script/bilibili-media-source.test.mjs`
- Modify: `tests/unit/content-script/youtube-media-source.test.mjs`
- Modify: `tests/unit/video-summary/media-pipeline.test.mjs`
- Modify: `tests/unit/video-summary/opfs.test.mjs`
- Modify: `tests/unit/background/media-kit-gateway.test.mjs`

**Interfaces:**
- Produces:
  ```js
  validateCanonicalDuration(durationMs): number
  validateCandidateDuration(canonicalDurationMs, candidateDurationMs): number
  validateInitialMediaUrl({ platform, url }): string
  validateLocalFetchRecipe({ platform, recipe }): object
  validateRedirectLocation({ platform, currentUrl, location }): string
  validateUploadTarget(target): object
  localFetchRequiresUnsupportedHeaders(recipe): boolean
  ```
- `validateLocalFetchRecipe` permits metadata keys `primaryUrl`, `backupUrls`, `credentialMode`, and `requiredRequestOrigin`; it rejects a `headers` key or any extra key.
- `validateUploadTarget` returns a clone containing exact `url`, `fileReference`, `method: 'PUT'`, and at most 32 allowlisted headers.

- [ ] **Step 1: Write failing pure policy tests**

Cover `NaN`, infinities, zero, negative, and `10_800_001`; accept `10_800_000`. Accept candidate difference equal to `max(2_000, 1%)` and reject one millisecond more. For Bilibili accept `https://upos-sz-mirrorcos.bilivideo.com/path`; for YouTube accept `https://rr1---sn.example.googlevideo.com/path`. Reject HTTP, credentials, fragments, non-default ports, localhost/IP literals, suffix confusion such as `bilivideo.com.evil.test`, and cross-platform CDN hosts.

Assert this metadata-only rule:

```js
const recipe = validateLocalFetchRecipe({
  platform: 'youtube',
  recipe: {
    primaryUrl: 'https://rr1---sn.example.googlevideo.com/audio',
    backupUrls: [],
    credentialMode: 'omit',
    requiredRequestOrigin: 'https://www.youtube.com/',
  },
})
assert.equal(recipe.requiredRequestOrigin, 'https://www.youtube.com/')
assert.equal('headers' in recipe, false)
assert.equal(localFetchRequiresUnsupportedHeaders(recipe), false)
assert.throws(
  () => validateLocalFetchRecipe({ platform: 'youtube', recipe: { ...recipe, headers: { Origin: 'x' } } }),
  /VIDEO_MEDIA_LOCAL_HEADERS_UNSUPPORTED/,
)
```

- [ ] **Step 2: Write failing redirect and upload tests**

Assert local fetch uses `redirect: 'manual'`. A 302 with no location, HTTP location, credentials, non-default port, wrong suffix, or platform crossover fails before `response.body.getReader()`. A relative or absolute redirect to the same approved CDN family is refetched with `redirect: 'manual'` and revalidated again. Cap redirects at five.

For upload targets reject non-HTTPS, credentials/non-default ports, wrong MediaKit/object-storage host, method other than `PUT`, more than 32 headers, non-allowlisted headers, oversized keys/values, `credentials` other than `omit`, and redirect mode other than `error`.

- [ ] **Step 3: Run policy tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/media-policy.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/video-summary/opfs.test.mjs \
  tests/unit/background/media-kit-gateway.test.mjs
```

Expected: FAIL because `media-policy.mjs` does not exist and current local fetch follows redirects without independent validation.

- [ ] **Step 4: Implement pure policy and integrate before paid work**

Use URL parsing with exact-host-or-subdomain checks:

```js
function isExactHostOrSubdomain(hostname, suffix) {
  const normalized = hostname.toLowerCase()
  return normalized === suffix || normalized.endsWith(`.${suffix}`)
}

function requireSafeHttpsUrl(value, allowedSuffixes) {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw createMediaPolicyError('VIDEO_MEDIA_URL_REJECTED')
  }
  if (!allowedSuffixes.some((suffix) => isExactHostOrSubdomain(parsed.hostname, suffix))) {
    throw createMediaPolicyError('VIDEO_MEDIA_HOST_REJECTED')
  }
  return parsed.href
}
```

Validate canonical duration, each candidate duration, all initial/backup URLs, and the local recipe before direct submission. Preserve `requiredRequestOrigin` only as data used to decide transport feasibility; never map it to a request header.

- [ ] **Step 5: Implement manual redirect revalidation and fallback disablement**

Fetch one URL at a time with `{ credentials: recipe.credentialMode, redirect: 'manual', signal }`. On redirect, resolve `Location` against the current URL, call `validateRedirectLocation`, and refetch; do not read the redirect response body. If the recipe declares `headers`, a non-allowlisted recipe field, or an explicit transport requirement not representable by `fetch(url, { credentials, redirect, signal })`, throw `VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED` and do not request an upload target or submit fallback.

- [ ] **Step 6: Run policy tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; policy rejection occurs before fake paid-operation counters increment, and every accepted redirect URL is validated before body access.

- [ ] **Step 7: Commit**

```bash
git add src/video-summary/media-policy.mjs \
  src/content-script/site-adapters/bilibili/media-source.mjs \
  src/content-script/site-adapters/youtube/media-source.mjs \
  src/video-summary/media-pipeline.mjs \
  src/video-summary/opfs.mjs \
  src/background/media-kit-gateway.mjs \
  tests/unit/video-summary/media-policy.test.mjs \
  tests/unit/content-script/bilibili-media-source.test.mjs \
  tests/unit/content-script/youtube-media-source.test.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/video-summary/opfs.test.mjs \
  tests/unit/background/media-kit-gateway.test.mjs
git commit -m "Validate video summary media transport"
```

---

### Task 4: Submission Consumption and Bounded MediaKit Polling

**Files:**
- Modify: `src/video-summary/media-pipeline.mjs`
- Modify: `src/background/video-summary-coordinator.mjs`
- Modify: `src/background/media-kit-gateway.mjs`
- Modify: `src/services/apis/volcengine-mediakit.mjs`
- Modify: `tests/unit/video-summary/media-pipeline.test.mjs`
- Modify: `tests/unit/background/video-summary-coordinator.test.mjs`
- Modify: `tests/unit/background/media-kit-gateway.test.mjs`
- Modify: `tests/unit/services/apis/volcengine-mediakit.test.mjs`

**Interfaces:**
- Consumes Task 1 reservation states and Task 2 abortable RPC.
- Produces:
  ```js
  createMediaPipeline({ mediaKitGateway, opfsStoreFactory, logger, clock, random })
  pollMediaKitTask({ taskId, signal, onEvent }): Promise<object>
  ```
- `clock` is:
  ```js
  { now(): number, sleep(ms, { signal }): Promise<void> }
  ```
- `random()` returns a number in `[0, 1]`; jitter multiplier is `0.8 + random() * 0.4`.
- Submission outcomes are classified as `accepted`, `documented-download-failure`, `definite-rejection`, or `ambiguous-consumed`.

- [ ] **Step 1: Write failing ambiguous-submission tests**

For direct and uploaded submissions, reject fetch `TypeError`, abort racing after request dispatch, invalid/missing provider body after a 2xx response, and connection loss after headers as `VIDEO_SUMMARY_SUBMISSION_UNKNOWN`. Assert the reservation remains consumed, direct submission is not repeated, upload fallback is not started, and `clientToken` is never used to infer provider idempotency.

```js
await assert.rejects(run(), /VIDEO_SUMMARY_SUBMISSION_UNKNOWN/)
assert.equal(calls.submitDirectAsr, 1)
assert.equal(calls.requestUploadTarget, 0)
assert.equal(calls.submitUploadedAsr, 0)
assert.equal(capability.directSubmission, 'consumed')
```

Only a completed provider response carrying the recorded task ID and documented terminal code `URL_DOWNLOAD_FAILED` or `AUDIO_URL_DOWNLOAD_FAILED` may call `markFallbackEligible`.

- [ ] **Step 2: Write failing fake-clock polling tests**

Use `random: () => 0.5` to assert delays `2_000, 4_000, 8_000, 16_000, 30_000, 30_000`. Use `random: () => 0` and `1` to assert 0.8× and 1.2× jitter. Assert `retryAfterMs` values below/above range become 2,000/30,000 ms. Assert no query or sleep occurs at zero delay, five consecutive transient errors fail, a successful pending response resets the transient counter, elapsed time reaching `7_200_000` fails, and abort during sleep issues no next query.

- [ ] **Step 3: Run pipeline and gateway tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs \
  tests/unit/background/media-kit-gateway.test.mjs \
  tests/unit/services/apis/volcengine-mediakit.test.mjs
```

Expected: FAIL because polling currently has a zero-delay microtask loop and submission failures do not preserve an explicit consumed/unknown state across all ambiguous outcomes.

- [ ] **Step 4: Implement explicit submission classification**

Reserve before dispatch. Return `accepted` only after validated provider acknowledgement. A documented terminal download failure transitions via `markFallbackEligible`; a definite pre-dispatch validation rejection may fail normally but does not restore a reservation already consumed by authorization. Map every unknown post-dispatch acceptance state to:

```js
const error = new Error('VIDEO_SUMMARY_SUBMISSION_UNKNOWN')
error.code = 'VIDEO_SUMMARY_SUBMISSION_UNKNOWN'
error.stage = 'submission-unknown'
error.submissionConsumed = true
throw error
```

The pipeline must immediately rethrow this error. It must not refresh, resubmit, create an upload target, upload, or query without a recorded provider task ID.

- [ ] **Step 5: Implement abortable bounded polling**

Use the exact order: abort check → deadline check → sleep at least 2 seconds → abort check → query → classify result. Exponential delay applies to pending responses; a valid `retryAfterMs` replaces the exponential base after clamping, then receives jitter. Transient errors increment a consecutive counter and use the same bounded delay; any valid response resets the counter. Before a sleep that would cross the deadline, sleep only to the deadline and then fail with `MEDIAKIT_POLL_DEADLINE_EXCEEDED` without another query.

- [ ] **Step 6: Run pipeline and gateway tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; there is no zero-delay path, the fifth consecutive transient failure terminates, the two-hour deadline is exact, abort prevents the next query, and ambiguous submission has one consumed attempt and no retry/fallback.

- [ ] **Step 7: Commit**

```bash
git add src/video-summary/media-pipeline.mjs \
  src/background/video-summary-coordinator.mjs \
  src/background/media-kit-gateway.mjs \
  src/services/apis/volcengine-mediakit.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/background/video-summary-coordinator.test.mjs \
  tests/unit/background/media-kit-gateway.test.mjs \
  tests/unit/services/apis/volcengine-mediakit.test.mjs
git commit -m "Bound MediaKit submission and polling"
```

---

### Task 5: OPFS Quota, Streaming Limit, and All-Terminal Cleanup

**Files:**
- Modify: `src/video-summary/opfs.mjs`
- Modify: `src/video-summary/media-pipeline.mjs`
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `src/pages/VideoSummaryOffscreen/runtime.mjs`
- Modify: `tests/unit/video-summary/opfs.test.mjs`
- Modify: `tests/unit/video-summary/media-pipeline.test.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Modify: `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

**Interfaces:**
- Produces:
  ```js
  estimateCandidateBytes(candidate): number
  createTaskOpfsStore({ rootDirectory, taskId, fetchImpl, estimateStorage, wait, taskFileName })
  cleanupVideoSummaryTaskDirectory({ rootDirectory, taskId, signal }): Promise<void>
  cleanupVideoSummaryTasksRoot({ rootDirectory, signal }): Promise<void>
  ```
- Store methods remain:
  ```js
  ensureQuota({ requiredBytes, candidate }): Promise<object>
  downloadCandidate({ candidate, signal, onProgress }): Promise<object>
  uploadBlob({ target, blob, signal, onProgress }): Promise<void>
  cleanup({ signal }): Promise<object>
  ```
- Constants are exactly `64 * 1024 * 1024` reserve bytes and `1024 * 1024 * 1024` task bytes.

- [ ] **Step 1: Write failing quota and stream tests**

Assert reserve is `max(64 MiB, quota * 0.1)`. Available writable bytes are `quota - usage - reserve`; reject when known content length or conservative estimate exceeds that value. For unknown length, estimate from finite duration and candidate bitrate, defaulting to a conservative 320 kbps when bitrate is absent. Stream a lying `content-length` and an unknown-length body past 1 GiB; assert `OPFS_TASK_SIZE_LIMIT_EXCEEDED`, reader cancellation, writable abort, and no upload-target request.

- [ ] **Step 2: Write failing all-terminal cleanup matrix**

In `tests/unit/video-summary/opfs.test.mjs`, define `createTerminalFixture(terminal)` before this matrix. The helper must create an in-memory OPFS root, one task directory/file, a task-scoped store, and a `finish()` callback that invokes the real success/failure/cancel/delete cleanup entry for the named path; `taskDirectoryExists()` must query the in-memory root and return false on `NotFoundError`. Then run one test per terminal path:

```js
for (const terminal of [
  'success',
  'retryable-failure',
  'terminal-failure',
  'explicit-cancel',
  'navigation-delete',
  'disconnect-delete',
  'command-rejection-after-directory-create',
]) {
  test(`deletes OPFS after ${terminal}`, async () => {
    const fixture = await createTerminalFixture(terminal)
    await fixture.finish()
    assert.equal(await fixture.taskDirectoryExists(), false)
  })
}
```

Also seed three children under `video-summary-tasks`, bootstrap Offscreen, and assert all are deleted before port connection or command acceptance. Make one deletion fail and assert bootstrap does not connect.

- [ ] **Step 3: Run OPFS lifecycle tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/opfs.test.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: FAIL because quota reserve/1 GiB enforcement and startup root cleanup are absent, and cleanup is currently local-fallback-only rather than terminal-generation-wide.

- [ ] **Step 4: Implement quota and streaming bounds**

Calculate required bytes before creating a task directory. During each chunk, check `bytesWritten + chunk.byteLength` against both writable quota budget and 1 GiB before `writable.write`. On overflow, cancel the reader and abort the writable. Pass task signal through download/upload, but never use it for terminal cleanup.

- [ ] **Step 5: Centralize terminal cleanup with an independent signal**

Create a fresh cleanup controller with a 10-second timeout after execution reaches any terminal event or receives `DELETE_TASK`. Cleanup is idempotent and treats `NotFoundError` as success. `EXECUTION_RELEASED` waits for bounded attempt cleanup but does not delete the transcript checkpoint; OPFS media is independent of that checkpoint and must already be removed. Cleanup failure emits a sanitized local code and forces runtime reset rather than leaving a successfully retained task claiming clean media state.

- [ ] **Step 6: Add the bootstrap cleanup barrier**

Before Offscreen connects to Background, open the dedicated root and recursively remove every child. Do not inspect task IDs or keep a journal. Only after all removals succeed may runtime port setup and task acceptance begin. A crash can leave files only until the next bootstrap.

- [ ] **Step 7: Run OPFS lifecycle tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; every terminal matrix row removes its directory, streams stop before writing byte `1_073_741_825`, bootstrap accepts no work before cleanup, and cleanup uses a non-aborted bounded signal.

- [ ] **Step 8: Commit**

```bash
git add src/video-summary/opfs.mjs \
  src/video-summary/media-pipeline.mjs \
  src/video-summary/task-runner.mjs \
  src/pages/VideoSummaryOffscreen/runtime.mjs \
  tests/unit/video-summary/opfs.test.mjs \
  tests/unit/video-summary/media-pipeline.test.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
git commit -m "Clean bounded video summary OPFS tasks"
```

---

### Task 6: Page-Mode Coordinator and Stale-Async Isolation

**Files:**
- Modify: `src/content-script/video-summary-adapter-controller.mjs`
- Modify: `src/content-script/site-adapters/bilibili/index.mjs`
- Modify: `src/content-script/site-adapters/bilibili/video-page-bridge.mjs`
- Modify: `src/content-script/site-adapters/youtube/index.mjs`
- Modify: `src/content-script/site-adapters/youtube/video-page-bridge.mjs`
- Modify: `src/content-script/video-summary-host.mjs`
- Modify: `tests/unit/content-script/video-summary-adapter-controller.test.mjs`
- Modify: `tests/unit/content-script/bilibili-adapter.test.mjs`
- Modify: `tests/unit/content-script/bilibili-video-page-bridge.test.mjs`
- Modify: `tests/unit/content-script/youtube-adapter.test.mjs`
- Modify: `tests/unit/content-script/youtube-video-page-bridge.test.mjs`
- Modify: `tests/unit/content-script/video-summary-host.test.mjs`

**Interfaces:**
- Consumes protocol-plan `PageIdentity` and `pageIdentitiesEqual`.
- Produces:
  ```js
  resolvePageMode({ config, capabilities, pageIdentity, pageState }): 'enhanced' | 'legacy' | 'none'
  createVideoSummaryAdapterController({
    getPageIdentity,
    resolveMode,
    mountEnhanced,
    mountLegacy,
    subscribeToPageChanges,
    findTargetElement,
    waitForTargetElement,
  })
  ```
- Mounted handles implement:
  ```js
  { dispose(): void, isConnected(): boolean }
  ```
- Every async page operation captures and checks:
  ```js
  { pageIdentity, pageGeneration }
  ```

- [ ] **Step 1: Write failing page-transition tests**

Cover YouTube `home → watch`, `watch A → watch B`, `watch → live`, `watch → Shorts`, and `watch → unsupported`; expect modes `none → enhanced`, enhanced replacement, then legacy/none according to existing adapter rules. Cover Bilibili same BVID P1→P2 with different CID and assert enhanced handle replacement. At every transition assert exactly one live disposable handle and exactly-once disposal of the old handle.

- [ ] **Step 2: Write failing DOM recovery and stale-async tests**

Keep the parent target but remove only the host child; `isConnected() === false` must trigger remount. Resolve old snapshot, target wait, source refresh, and seek promises after page generation advances; assert no old result mutates or mounts the current page and no stale seek executes.

- [ ] **Step 3: Run page lifecycle tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/video-summary-adapter-controller.test.mjs \
  tests/unit/content-script/bilibili-adapter.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-adapter.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs \
  tests/unit/content-script/video-summary-host.test.mjs
```

Expected: FAIL because the controller tracks only video ID/target identity, has no explicit three-mode owner, and cannot detect child-only host removal.

- [ ] **Step 4: Refactor to one mode handle**

Maintain `{ pageIdentity, pageGeneration, mode, handle, targetElement }`. On any adapter notification, increment generation, derive identity and mode, dispose the old handle before mounting a different identity/mode, and coalesce reconciliation requests without allowing two handles. Keep eligibility rules in site adapters: YouTube ordinary on-demand watch pages may be enhanced, while live/Shorts/unsupported pages use their existing legacy/none result; Bilibili identity compares BVID+CID.

- [ ] **Step 5: Guard every asynchronous continuation**

Use one predicate:

```js
function isCurrentPage(expectedIdentity, expectedGeneration) {
  return (
    !disposed &&
    pageGeneration === expectedGeneration &&
    pageIdentitiesEqual(getPageIdentity(), expectedIdentity)
  )
}
```

Check it after every await and before mount, state update, refreshed snapshot return, or seek. Polling recovery checks both target presence and `handle.isConnected()`; it does not infer connection from parent equality.

- [ ] **Step 6: Run page lifecycle tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; every transition has at most one handle, Bilibili CID changes remount, child-only removal recovers, and stale asynchronous work has zero current-page effects.

- [ ] **Step 7: Commit**

```bash
git add src/content-script/video-summary-adapter-controller.mjs \
  src/content-script/site-adapters/bilibili/index.mjs \
  src/content-script/site-adapters/bilibili/video-page-bridge.mjs \
  src/content-script/site-adapters/youtube/index.mjs \
  src/content-script/site-adapters/youtube/video-page-bridge.mjs \
  src/content-script/video-summary-host.mjs \
  tests/unit/content-script/video-summary-adapter-controller.test.mjs \
  tests/unit/content-script/bilibili-adapter.test.mjs \
  tests/unit/content-script/bilibili-video-page-bridge.test.mjs \
  tests/unit/content-script/youtube-adapter.test.mjs \
  tests/unit/content-script/youtube-video-page-bridge.test.mjs \
  tests/unit/content-script/video-summary-host.test.mjs
git commit -m "Coordinate video summary page modes"
```

---

### Task 7: Race-Safe Cancel/Retry UI and Increment Verification

**Files:**
- Modify: `src/content-script/video-summary-host.mjs`
- Modify: `src/content-script/video-summary-port.mjs`
- Modify: `src/components/VideoSummaryView/index.jsx`
- Modify: `src/components/VideoSummaryView/styles.scss`
- Modify: `src/_locales/en/main.json`
- Modify: `tests/unit/content-script/video-summary-host.test.mjs`
- Modify: `tests/unit/content-script/video-summary-port.test.mjs`
- Modify: `tests/unit/components/video-summary-view.test.mjs`
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

**Interfaces:**
- Consumes protocol-plan start/cancel/attach/retry ACKs and Task 6 page generation.
- Produces host task phases:
  ```js
  'idle' | 'starting' | 'running' | 'cancelling' | 'reattaching' | 'complete' | 'failed'
  ```
- Produces view props:
  ```js
  sourceActionsDisabled: boolean
  canCancel: boolean
  canRetrySummary: boolean
  onCancelTask(): void
  onRetrySummary(): void
  ```
- `canCancel` is true only for a known executing generation in `starting`, `running`, or `cancelling`; the button is disabled once cancellation is latched.
- `canRetrySummary` is true only for `complete` or retryable `failed`, `checkpointAvailable === true`, no active attempt, and no pending action latch.

- [ ] **Step 1: Write failing view-state tests**

For `starting`, `running`, `cancelling`, and `reattaching`, assert subtitle select, subtitle action, ASR action, and ASR confirm are disabled. Assert running exposes `data-action="cancel-task"`; first click invokes cancel once and disables the button synchronously. Assert Retry is hidden for active/no-checkpoint/terminal-no-checkpoint states and visible for complete or retryable failure with checkpoint and no active attempt.

- [ ] **Step 2: Write failing host/port race tests**

Double-click native, ASR confirm, Cancel, and Retry in the same JavaScript turn; assert one protocol mutation each. Cancel while start has no fence must call `cancelStart`; after any `START_ACK` fence it must call generation-level `cancelTask({ taskId, generation })`. Hold a retry ACK, navigate to a new page generation, then resolve it; assert no stale state update. Reattach disables source actions until `ATTACH_ACK` resolves.

- [ ] **Step 3: Run UI tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/content-script/video-summary-host.test.mjs \
  tests/unit/content-script/video-summary-port.test.mjs \
  tests/unit/components/video-summary-view.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: FAIL because source controls remain enabled during work, no running Cancel action exists, and Retry visibility does not distinguish retained checkpoint state from an active attempt.

- [ ] **Step 4: Implement the synchronous action latch and generation-safe handlers**

Set `pendingAction` before the first await and clear it only if the captured page generation remains current. Derive state with:

```js
const busyPhase = ['starting', 'running', 'cancelling', 'reattaching'].includes(taskState.phase)
const sourceActionsDisabled = busyPhase || pendingAction !== null
const canCancel =
  ['starting', 'running', 'cancelling'].includes(taskState.phase) &&
  Boolean(taskState.taskId) &&
  pendingAction !== 'cancel'
const canRetrySummary =
  ['complete', 'failed'].includes(taskState.phase) &&
  taskState.checkpointAvailable === true &&
  taskState.activeAttempt !== true &&
  pendingAction === null
```

A pre-fence cancel targets the start request. A post-fence cancel uses only task ID and generation, so an old attempt number cannot block cancellation of the current retry. Async handlers compare captured `{ pageIdentity, pageGeneration }` before rendering.

- [ ] **Step 5: Implement accessible UI and English strings**

Pass `disabled={sourceActionsDisabled}` to all source/confirmation controls. Render Cancel only when `canCancel`; render Retry only when `canRetrySummary`. Add English source strings for `Cancel summary`, `Cancelling summary`, `Reattaching summary`, `Local media fallback is unavailable because this source requires unsupported request headers.`, and `The transcription submission outcome is unknown and was not retried.` Preserve English fallback for other locales.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run the Step 3 command.

Expected: PASS; each same-turn double action emits one mutation, source controls remain disabled through reattachment/cancellation, generation cancel works from an old attempt, and stale handlers do not render.

- [ ] **Step 7: Run full automated validation**

Run:

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Expected: all four commands exit 0. The full Chromium artifact contains `VideoSummaryOffscreen.html` and `VideoSummaryOffscreen.js`; minimal Chromium and both Firefox artifacts do not contain either file.

- [ ] **Step 8: Inspect artifact separation**

Run:

```bash
test -f build/chromium/VideoSummaryOffscreen.html && \
  test -f build/chromium/VideoSummaryOffscreen.js && \
  test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html && \
  test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.js && \
  test ! -e build/firefox/VideoSummaryOffscreen.html && \
  test ! -e build/firefox/VideoSummaryOffscreen.js && \
  test ! -e build/firefox-without-katex-and-tiktoken/VideoSummaryOffscreen.html && \
  test ! -e build/firefox-without-katex-and-tiktoken/VideoSummaryOffscreen.js
```

Expected: exit 0 with no output.

- [ ] **Step 9: Manually smoke-test the increment**

Load `build/chromium/` unpacked. Verify Bilibili P1→P2, YouTube home→watch→watch→live/Shorts, child-only host removal, duplicate source click, Cancel before start ACK, Cancel during download/upload/poll/model, retry from retained checkpoint, unsupported-header no-fallback behavior, redirected local URL rejection/revalidation, ambiguous submission no-retry behavior, disconnect/navigation cleanup, and Background/Offscreen restart failure. In the Offscreen inspector confirm the dedicated OPFS root is empty after every terminal path.

Expected: one live host, one paid submission reservation, no post-cancel next stage, no automatic retry after unknown submission, no fallback when headers are required, and no terminal OPFS task directory.

- [ ] **Step 10: Commit**

```bash
git add src/content-script/video-summary-host.mjs \
  src/content-script/video-summary-port.mjs \
  src/components/VideoSummaryView/index.jsx \
  src/components/VideoSummaryView/styles.scss \
  src/_locales/en/main.json \
  tests/unit/content-script/video-summary-host.test.mjs \
  tests/unit/content-script/video-summary-port.test.mjs \
  tests/unit/components/video-summary-view.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
git commit -m "Harden video summary lifecycle actions"
```
