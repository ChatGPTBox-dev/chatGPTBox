# Enhanced Video Summary Hardening Design

**Date:** 2026-10-06

**Status:** Approved design

**Applies to:** Full Chromium enhanced Bilibili and YouTube video summaries

## 1. Purpose

Harden the enhanced video-summary implementation against duplicate paid work, cross-context message
forgery, stale page identity, cancellation gaps, lost task state, unbounded media resource use, and
untrusted summary output while retaining the existing product boundary:

- enhanced summaries remain explicitly invoked;
- native subtitles and confirmed ASR feed the same summary pipeline;
- MediaKit and model credentials remain in Background;
- tasks remain ephemeral and are not restored after an extension runtime restart;
- Firefox, Safari, minimal builds, unsupported pages, and disabled settings retain the legacy path;
- archive and Markdown download remain explicit user actions.

This design directly upgrades the internal content/background/offscreen protocol. All extension
contexts ship together, so no old-protocol compatibility layer is required.

## 2. Scope

### 2.1 Included

- Make Background the authoritative coordinator for owner/task identity, task replacement, state
  replay, cancellation, and runtime epochs.
- Authenticate content and offscreen ports before granting protocol access.
- Replace Bilibili BVID-only ownership with multipart-aware media identity.
- Define strict command, event, source snapshot, and gateway payload schemas.
- Make cancellation propagate through model calls, source refresh, MediaKit calls, media download,
  upload, polling delays, and task cleanup.
- Add bounded MediaKit polling, duration limits, URL policy, OPFS byte limits, and deferred cleanup.
- Unify enhanced, legacy, and unsupported page lifecycle selection across SPA navigation.
- Make failed transcription checkpoints reattachable and summary-retryable.
- Preserve model message roles where the provider supports them and harden Web-provider prompts.
- Validate empty or truncated model output and correct transcript coverage calculation.
- Escape untrusted video-summary data when generating archived or downloaded Markdown.
- Add automated and manual validation for concurrency, restart, security, and resource limits.

### 2.2 Excluded

- Persisting or resuming tasks across Background or offscreen restarts.
- A project-operated media backend.
- Browser-local ASR, tab recording, or local file selection.
- Bypassing authentication, DRM, paid/private content, or regional controls.
- Global changes to the chat Markdown renderer.
- Changing provider credentials, settings storage formats, or existing archived session formats.
- Guaranteeing cancellation of an ASR job after MediaKit has accepted it.

## 3. Architectural Decision

Background becomes the authoritative task coordinator. Content owns page extraction and rendering;
offscreen owns task execution and ephemeral checkpoints; privileged gateways own credentials and
provider calls. Neither content nor offscreen may independently redefine task ownership.

The alternatives were rejected as follows:

- Making offscreen authoritative complicates Background service-worker restart detection and sender
  authentication.
- Applying local fixes without a coordinator leaves route replacement, state replay, and generation
  checks distributed across contexts and preserves the current race conditions.

The hardened ownership chain is:

```text
trusted top-frame content port
  -> Background TaskCoordinator
     -> authenticated offscreen port
        -> VideoTaskRunner
           -> narrow Background gateways
```

## 4. Canonical Identity

### 4.1 Page identity

Each bridge exposes a serializable `PageIdentity`. Protocol messages carry it only as the nested
`pageIdentity` field; source snapshots contain an exactly equal read-only copy. No message may also
carry independent top-level identity fields that could disagree.


```js
// Bilibili
{
  platform: 'bilibili',
  videoId: 'BV...',
  mediaScope: 'BV...:cid:<cid>',
  pageNumber: 2,
  pageId: '<cid>',
}

// YouTube
{
  platform: 'youtube',
  videoId: '<video-id>',
  mediaScope: '<video-id>',
  pageNumber: null,
  pageId: '<video-id>',
}
```

`mediaScope` identifies the concrete media object. Bilibili uses BVID plus CID; page number remains
metadata because CID is the stable multipart media identity. YouTube uses video ID.

### 4.2 Owner identity

Background derives the privileged owner from the authenticated content port and validated page
identity:

```js
{
  tabId,
  documentId,
  platform,
  videoId,
  mediaScope,
}
```

The route key is all five fields. `videoId` and `mediaScope` are intentionally redundant: the former
supports product display and cross-platform lookup, while the latter identifies the concrete media;
validators require them to agree with the platform identity. Caller-supplied `tabId`, `documentId`,
or owner objects are ignored. An authoritative tuple is exactly
`{ owner, taskId, generation, attempt, runtimeEpoch, offscreenInstanceId }`; initial Content requests
follow the non-authoritative envelope below.

### 4.3 Generation

Background keeps a monotonically increasing generation counter per `(runtimeEpoch, tabId, platform)`
slot for the lifetime of that Background instance; deleting a route does not reset its counter. A
replacement start first cancels generation N, then allocates N+1 from that slot counter. Each execution or retry within one retained task
also has a monotonically increasing positive integer `attempt`. Every asynchronous completion, state
mutation, gateway response, refresh result, and cleanup operation must prove that its tuple still
matches:

```text
runtimeEpoch + offscreenInstanceId + owner + taskId + generation + attempt
```

An old generation or attempt may finish cleanup, but it may not emit user-visible state, delete a
newer controller, release a newer checkpoint, or satisfy a newer RPC. Summary-only retry retains the
task and checkpoint but increments `attempt` before any new model call. Checkpoint ownership is
`runtimeEpoch + offscreenInstanceId + owner + taskId + generation`, while execution controllers and
pending RPCs add `attempt`. Retrying first
atomically aborts and drains the old attempt-owned resources, then binds the new attempt to the same
immutable transcription checkpoint. Old-attempt cleanup may delete only resources tagged with its
attempt and can never delete the generation-owned checkpoint.

Content requests do not invent authoritative fields. Before `START_ACK`, Content sends:

```js
{
  type: 'START_TASK',
  requestId,
  taskId,
  pageIdentity,
  payload,
}
```

Background derives owner, allocates generation and attempt, and returns:

```js
{
  type: 'START_ACK',
  requestId,
  status: 'started' | 'rejected',
  tuple,
  errorCode,
}
```

`started` requires a tuple and no error; `rejected` requires `tuple: null` and a stable error code.
Content may cancel a start awaiting acknowledgement by `requestId + taskId`; after acknowledgement,
commands use the full authoritative tuple. Background-to-Offscreen commands and
Offscreen-to-Background events always use the full tuple.

Background keeps a mutation ledger per authenticated `(tabId, documentId, platform)`, keyed by
`requestId`; it survives content-port replacement. Rejected entries expire after 15 minutes. A started task's live entry remains through task release;
release converts it to a terminal mutation tombstone retained for another 15 minutes or until
runtime-epoch termination. Replaying that request returns its original `START_ACK` and cannot create
work; Content then resolves current state through `ATTACH_TASK`. The ledger admits at
most 128 entries per document; when only live entries remain at the limit, new mutations fail with
`VIDEO_SUMMARY_REQUEST_LEDGER_FULL` rather than evicting an entry. Repeating an identical request
returns the cached ACK without restarting work. A new port that lacks an acknowledged tuple recovers an unacknowledged start by repeating the same
request ID; the live ledger entry returns the original ACK for the full task lifetime. A port with an
acknowledged tuple must attach it before issuing a new start. Reusing a request ID with different content fails with
`VIDEO_SUMMARY_REQUEST_ID_CONFLICT`. `CANCEL_ACK { requestId, status, tuple, errorCode }` is returned
after `TASK_RELEASED` or with status `cleanup-timeout` after quarantine.
`RETRY_TASK { requestId, tuple, modelSnapshot, fromStage }` authorizes with the current tuple and uses
a two-phase idempotent handshake under the slot lock:

1. Background records `pendingRetry { requestId, previousTuple, nextTuple, payloadHash }` and sends
   `RETRY_PREPARE`.
2. Offscreen validates the generation-owned checkpoint and payload without aborting, rebinding, or
   emitting progress. It records a bounded prepared entry and replies `RETRY_READY`, or replies
   `TASK_RETRY_REJECTED` without changing the old attempt.
3. After `RETRY_READY`, Background commits `route.attempt = nextTuple.attempt` and the mutation ledger
   before sending `RETRY_COMMIT`.
4. `RETRY_COMMIT` atomically aborts and drains old attempt resources, binds the next controller, and
   replies `TASK_RETRY_STARTED`; repeated identical commits return the same response.
5. Background returns a started `RETRY_ACK` only after `TASK_RETRY_STARTED`. If that response is lost,
   Background remains committed to `nextTuple`, resends the same commit, and reports `reattaching`
   rather than restoring the old attempt.

A prepare rejection or prepare timeout leaves the old retryable route and checkpoint unchanged. A
commit timeout marks the route `retry-start-unknown`; attach replays that state while Background
retries the exact commit. If reconciliation exceeds 10 seconds, Background sends a tuple-specific
cancel for `nextTuple` and enters the normal cancellation/quarantine path rather than rolling back.

Offscreen serializes prepare, commit, and cancel operations per task generation. A cancel for
`nextTuple` creates a cancellation tombstone even if its controller has not been bound yet. Before
binding a controller or issuing any model call, commit checks that tombstone; when present, it skips
execution and returns `TASK_RELEASED` for `nextTuple`. If cancel arrives during drain or bind, the same
serialized operation aborts the new controller before it can call a provider. A late or repeated
commit after release returns the cached released response and cannot restart work. Prepared and
cancellation tombstones expire only after Background acknowledges the release or the runtime epoch
ends; they count toward the coordinator and pending-operation limits. Cancel and retry use the same
ledger idempotency and payload-conflict rules.

## 5. Port Authentication and Protocol Validation

### 5.1 Content port

Background accepts `VIDEO_SUMMARY_PORT_NAME` only when:

- `port.sender.id` equals the extension runtime ID;
- `sender.tab.id` is an integer;
- `sender.documentId` is non-empty;
- `sender.frameId === 0`; a missing frame ID, prerender, fenced frame, or subframe is rejected;
- the sender URL is HTTPS and matches the declared Bilibili or YouTube content-script origins;
- the requested platform matches the sender origin.

Invalid ports are disconnected before listeners or offscreen work are created.

### 5.2 Offscreen port

Background accepts `VIDEO_SUMMARY_OFFSCREEN_PORT_NAME` only when:

- `port.sender.id` equals the extension runtime ID;
- the sender has no tab or frame-owned page context;
- the sender URL exactly equals `runtime.getURL(VIDEO_SUMMARY_OFFSCREEN_PATH)`;
- it completes the current epoch challenge-response handshake.

After sender metadata passes, Background sends
`HELLO_CHALLENGE { runtimeEpoch, nonce }`. Offscreen replies
`HELLO_ACK { runtimeEpoch, offscreenInstanceId, nonce }`. Before the exact nonce and epoch match, the port may exchange
only these handshake messages. The nonce is single-use and expires after 5 seconds. An
unauthenticated port cannot replace the active offscreen port, flush queued commands, invoke a
gateway, or receive task data. An existing offscreen document reconnects through the same handshake;
it never learns the epoch from storage or caller-controlled messages.

### 5.3 Strict schemas

Protocol parsing uses explicit validators and field allowlists. Invalid payloads are rejected with a
safe protocol error and never spread into privileged commands. Validators enforce:

- known command, event, stage, source choice, platform, and gateway operation values;
- bounded IDs and strings;
- positive finite durations and timestamps;
- bounded arrays, transcript cue counts, text sizes, headers, and serialized payload size;
- exact owner, page identity, task, generation, and epoch matches;
- structured-clone-safe plain data only;
- no functions, signals, DOM objects, credentials, arbitrary headers, or caller-defined callbacks.

Gateway schemas are operation-specific. The allowlist remains necessary but is not sufficient.
Protocol limits are centralized and injectable for tests:

| Limit | Value |
| --- | ---: |
| IDs, codes, operation names | 128 UTF-16 code units |
| Video title and labels | 1,000 code units |
| One subtitle cue | 20,000 code units |
| Subtitle cues per snapshot | 100,000 |
| Media candidates per snapshot | 16 |
| Upload headers | 32 entries, 256 code units per key/value |
| Serialized content command | 32 MiB |
| Pending RPCs per task | 16 |
| RPC timeout | 30 seconds, except source refresh at 10 seconds |

Exceeded limits fail closed with `VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED` before privileged work.

## 6. Background Task Coordinator

### 6.1 Route state

Each owner route stores:

```js
{
  owner,
  taskId,
  generation,
  attempt,
  runtimeEpoch,
  offscreenInstanceId,
  port,
  phase,
  latestEvent,
  terminalEvent,
  checkpointAvailable,
  attachDeadlineAt,
  cancelState,
}
```

Port listener ownership is connection-scoped, not route-scoped. Replacing a task on the same port
must not remove that port's listeners. A listener is removed only when the port disconnects or is
explicitly rejected.

### 6.2 Starting and replacing tasks

`START_TASK` follows one serialized transaction under the `(tabId, platform)` slot lock:

1. validate sender, page identity, source snapshot, settings, and model snapshot;
2. acquire the tab-platform slot lock before reading either the slot index or owner routes;
3. if the slot has a route for any document or media scope, emit `CANCEL_TASK` for its exact tuple and
   mark it superseded;
4. wait for local cancellation acknowledgement; a cleanup timeout quarantines and blocks the slot;
5. allocate the next slot generation and route within the same lock;
6. emit the validated start command to the authenticated offscreen runtime;
7. return `START_ACK` with the authoritative tuple.

The UI also prevents duplicate starts, but Background enforces the invariant:

> At most one non-terminal task exists per owner.

Background also maintains a tab-platform slot index keyed by `(tabId, platform)`. A new top-frame
document or new `mediaScope` in the same slot immediately supersedes and cancels the previous route;
the 15-second reattachment grace applies only when both document ID and media scope are unchanged.
This prevents full-document navigation from leaving two paid tasks active in one site tab.

### 6.3 Event snapshots and attachment

The coordinator stores the latest safe event and terminal event before attempting delivery. When a
content port sends `ATTACH_TASK`, Background returns exactly one `ATTACH_ACK`:

```js
{
  type: 'ATTACH_ACK',
  requestId,
  status: 'active' | 'retryable' | 'terminal' | 'not-found' | 'runtime-restarted',
  tuple,
  event,
}
```

- `active` requires `tuple` and a progress event.
- `retryable` requires `tuple` and a failed event with an available transcript checkpoint.
- `terminal` requires `tuple` and a completed result or non-retryable failure.
- `not-found` requires `tuple: null` and `event: null` and tells content to clear its local attachment.
- `runtime-restarted` requires `tuple: null` and `event` containing only the stable restart code.

The acknowledgement `requestId` must equal the attach request. `tuple` is always the canonical
authoritative tuple and therefore contains owner, task ID, generation, attempt, runtime epoch, and
offscreen instance ID. Content keeps the last acknowledged tuple in page memory. An
attach request sends `previousRuntimeEpoch` and `previousOffscreenInstanceId`; if either differs
from the current authenticated runtime pair, Background returns `runtime-restarted`. Background keeps
a restart tombstone for each affected `(tabId, documentId, platform, mediaScope)` for 15 minutes, so
a page disconnected during offscreen replacement also receives `runtime-restarted`. A matching pair
with no route or tombstone returns `not-found`. This page-memory value is not persistent task recovery.

Events emitted while no page port is attached remain in the route snapshot and are replayed later.

### 6.4 Cancellation and expiry

`CANCEL_TASK` is idempotent and tuple-specific. Offscreen emits
`TASK_RELEASED { tuple, reason, cleanupStatus }` only after the runner controller, checkpoint binding,
owner binding, and tuple-owned pending RPCs are released. Cancellation removes the route after this
acknowledgement. If acknowledgement does not arrive within 10 seconds, the route enters `quarantined-cleanup` in its
active tab-platform slot. It cannot accept attach, retry, replacement, or user-visible task events;
only its matching late `TASK_RELEASED` may remove it. The slot rejects new starts with
`VIDEO_SUMMARY_CLEANUP_PENDING`, preserving the one-paid-task invariant. Quarantine therefore uses
the same route count/byte limits and cannot grow separately. After 2 minutes without release,
Background force-recreates the authenticated offscreen runtime, which changes `offscreenInstanceId`
and clears all ephemeral routes through the runtime-restart path before a new start is allowed. Disconnect retains the
15-second reattachment grace period. Grace expiry, tab removal, explicit cancellation, replacement,
and runtime restart all enter the same cleanup path.

A failed task with `checkpointAvailable: true` remains attachable and retryable. A completed result
and retryable failure are retained for 15 minutes after their last attachment, subject to a global
limit of 32 routes or 16 MiB of serialized safe event data. Before storing an event, Background
computes its serialized size. An event that would exceed the per-coordinator byte limit is replaced by
a bounded failure event `VIDEO_SUMMARY_RESULT_TOO_LARGE`, and its task enters non-retryable cleanup;
raw oversized data is never retained. Oldest detached routes are evicted first through the
cancellation cleanup path. If attached retained routes already consume the route or byte limit, a new
start is rejected with `VIDEO_SUMMARY_COORDINATOR_CAPACITY_EXCEEDED`; active or attached state is
never silently evicted. Archive and download actions do not extend retention.
Non-retryable failure releases immediately after its terminal event is safely recorded or delivered.

### 6.5 State transitions

The coordinator accepts only these transitions:

| Current state | Input | Next state | Retain checkpoint | User-visible result |
| --- | --- | --- | --- | --- |
| none | valid start | starting | no | `START_ACK` |
| starting/running/reattaching | progress | running | event-defined | latest progress |
| starting/running/reattaching | cancel | cancelling | until release | cancelling |
| cancelling | `TASK_RELEASED` | removed | no | cancelled/restartable |
| cancelling | 10-second release timeout | quarantined-cleanup in active slot | yes | cleanup-timeout |
| quarantined-cleanup | valid new start/retry/attach | unchanged | yes | `VIDEO_SUMMARY_CLEANUP_PENDING` |
| quarantined-cleanup | matching late `TASK_RELEASED` | removed | no | none |
| quarantined-cleanup | 2-minute quarantine deadline | runtime recreation and restart cleanup | no | runtime-restarted |
| any retained state | epoch/instance change | runtime-restarted notification, then active route removed | no | restartable failure |
| running | result | complete | yes | terminal result |
| running | failure with checkpoint | retryable-failure | yes | retry action |
| running | failure without checkpoint | failed then removed | no | terminal failure |
| retryable-failure/complete | retry summary | running with `attempt + 1` | yes | progress |
| any retained state | same-scope attach | unchanged | unchanged | `ATTACH_ACK` replay |
| any non-removed state | replacement/new media scope | cancelling/superseded | until release | new start waits |

Any command outside these transitions fails with `VIDEO_SUMMARY_STATE_CONFLICT`. An event from a
non-current tuple is discarded. `retryable-failure` is terminal for one attempt but not for the
retained task.

## 7. Runtime Epoch and Restart Semantics

Background creates a random `runtimeEpoch` at service-worker initialization. Each offscreen
bootstrap creates a random `offscreenInstanceId`. The challenge response authenticates both values,
and every authoritative tuple includes both. A changed runtime epoch or offscreen instance means
runner/checkpoint memory was lost and triggers the same explicit restart path.

If Background starts while an offscreen document already exists but no authenticated matching port
connects within 5 seconds, Background closes and recreates that offscreen document. The pre-handshake
command queue accepts at most 32 commands and 2 MiB of serialized data, and each command expires
after 10 seconds. Overflow and expiry fail with `VIDEO_SUMMARY_OFFSCREEN_UNAVAILABLE`. If a newly
authenticated `offscreenInstanceId` differs from the instance recorded by an existing route,
Background marks that route `runtime-restarted`; it never forwards attach, retry, or cancellation as
if the old runner still existed.

An epoch or offscreen-instance mismatch means ephemeral state cannot be trusted. The system:

1. rejects old messages and ports;
2. sends a bounded `runtime-restarted` notification to reachable page ports;
3. removes affected active routes and quarantine entries from coordinator memory;
4. cancels and releases runner state where possible without waiting for acknowledgement from a lost instance;
5. rejects all pending gateway and source-refresh RPCs;
6. cleans OPFS task directories;
7. lets the user explicitly start again.

No checkpoint, media blob, prompt, or result is persisted for crash recovery.

## 8. Source Refresh RPC

Source refresh requests use `requestId`, the authoritative task tuple, and a 10-second timeout.
Background replies with `SOURCE_REFRESH_ACK { requestId, tuple, delivered, errorCode }` before a page
result is expected. If the owner port is detached, `delivered` is false with
`VIDEO_SOURCE_REFRESH_UNAVAILABLE`; the request is not left pending for the grace period.
`SOURCE_REFRESH_RESULT { requestId, tuple, sourceSnapshot, errorCode }` resolves the operation. Every
malformed, mismatched, detached, cancelled, or expired branch settles and deletes its pending entry
with a stable error code.

Offscreen registers each pending request with:

- its tuple;
- an expiry timer;
- the task AbortSignal;
- a generation-safe resolver.

Cancellation, disconnect, epoch change, timeout, and mismatched refresh results all settle the
Promise. Content validates the complete current `PageIdentity`, not only BVID/video ID, before
returning a refreshed snapshot.

## 9. Media Safety and Resource Governance

### 9.1 Source validation

The privileged boundary validates the source snapshot before any network or paid operation:

- platform, video ID, and media scope match the owner;
- duration is finite, positive, and at most `10_800_000` ms;
- candidate media duration differs from page duration by no more than the greater of 2 seconds or 1%;
- remote and local URLs use HTTPS;
- Bilibili media hosts must equal or be subdomains of `bilivideo.com`; YouTube media hosts must equal
  or be subdomains of `googlevideo.com`; any additional CDN suffix requires a sanitized production
  fixture and explicit code/test update;
- localhost, IP literals, URL credentials, non-default ports, redirects outside the same allowlist,
  and unsupported schemes are rejected;
- Bilibili local fetch permits only `credentialMode: 'include'` and
  `requiredRequestOrigin: 'https://www.bilibili.com/'`; YouTube local fetch permits only the exact
  mode and origin emitted by its audited bridge fixture, with `omit` used when no credential is
  required;
- redirects are revalidated against the same platform policy before body consumption;
- upload submission references use only `mediakit://` values returned by the gateway.

MediaKit remains a narrow API wrapper, not a generic privileged fetch interface.

### 9.2 Cancellation propagation

The runner's attempt AbortSignal propagates through:

- source refresh;
- MediaKit gateway RPC;
- upload-target creation;
- direct ASR submission;
- task query;
- OPFS download and writable stream;
- signed upload fetch;
- polling waits and cleanup waits;
- model generation.

Every irreversible or paid step checks cancellation and generation immediately before and after the
operation. Cancellation before submission guarantees no later submission. Once MediaKit accepts a
job, the UI continues to disclose that remote cancellation and cost reversal are not guaranteed.

Background gateways keep request-scoped controllers keyed by the full tuple and request ID. Starting
a replacement request aborts the previous exact key. A `finally` block deletes a controller only if
the map still contains that same controller.

### 9.3 Submission ambiguity and idempotency

The stable MediaKit `clientToken` is the first 64 lowercase hexadecimal characters of the SHA-256
digest of canonical UTF-8 JSON containing `runtimeEpoch`, owner fields in fixed order, task ID, and
generation; attempt is excluded so an explicit retry cannot create a second provider job. Network
failures after a submission may have
reached the provider are mapped in Background to
`VIDEO_SUMMARY_SUBMISSION_UNKNOWN`. This error is preserved through RPC, is never automatically
retried, and tells the user that a remote task and charge may already exist.

### 9.4 Polling policy

Polling uses a signal-aware timer, not a microtask loop:

- initial delay: 2 seconds;
- exponential growth to a 30-second cap;
- jitter sampled through an injectable random source in the range ±20%;
- finite provider `retryAfterMs` is clamped to 0–30 seconds and overrides the computed delay;
- five consecutive transient query failures terminate with `MEDIAKIT_QUERY_RETRY_EXHAUSTED`;
- total ASR settlement deadline: 2 hours;
- cancellation settles the wait immediately.

Terminal, timeout, and provider failures use stable error codes.

### 9.5 OPFS quota and cleanup

Known media lengths are checked against available quota with a reserve of the greater of 64 MiB or
10% of quota before download. Unknown lengths use the smaller of `duration × declared bitrate / 8 ×
1.25` and the hard limit as the estimate. Every download enforces a 1 GiB hard task byte limit and
checks bytes while streaming. The writable is aborted and the task directory is cleaned immediately
on limit, quota, or identity failure. These limits are injectable in tests but not user-configurable.

Cleanup failure records only a random task-directory ID, creation time, and attempt count in
extension local storage. This is the sole persisted recovery metadata; it contains no owner, task
identity, media URL, transcript, prompt, result, or credential. The registry holds at most 128 entries
for seven days. Offscreen bootstrap cleans it before accepting work, and idle maintenance retries
remaining entries. Entries are removed only after confirmed deletion. This cleanup registry does not
resume a task and is compatible with the no-crash-recovery boundary.

## 10. Site Lifecycle

A shared page-mode coordinator selects exactly one mode on every meaningful page identity change:

```text
enhanced | legacy | none
```

It owns the active mode handle and disposes it before switching. This replaces the current split
where enhanced and legacy paths independently decide their lifetime.

- `enhanced` requires the strict runtime capability gate and supported page identity.
- `legacy` preserves the existing subtitle-summary prompt on pages where it remains applicable.
- `none` applies to unsupported pages such as live content or excluded Bilibili content.

YouTube navigation from home to watch, watch to another watch video, or watch to live/Shorts reruns
mode selection. Bilibili navigation uses the full multipart identity. Adapter bridges remain the only
modules that parse site URLs, page APIs, and player DOM.

The shared host controller monitors both the target element identity and a host-owned `isConnected`
health check. A site removing only the injected child causes a bounded remount without recreating a
healthy host.

Every asynchronous snapshot, mount, refresh, and seek operation verifies the complete authoritative
tuple (`runtimeEpoch + offscreenInstanceId + owner + taskId + generation + attempt`) where a task exists, and verifies the
current `PageIdentity + page-mode generation` before a task has started.

## 11. UI State and User Actions

The content host uses these phases:

```text
idle
loading-source
awaiting-asr-confirmation
starting
running
cancelling
reattaching
retryable-failure
failed
complete
runtime-restarted
```

Source selectors, start buttons, and ASR confirmation are disabled during `starting`, `running`,
`cancelling`, and `reattaching`. A synchronous host-side start latch prevents two handlers from
creating task IDs before the first render. Background remains the authoritative duplicate defense.

A Cancel action is visible during active work. It sends the authoritative tuple, enters
`cancelling`, and becomes idempotently disabled until acknowledgement or timeout.

`checkpointAvailable` alone enables “Retry summary only”; a completed result is not required. Retry
uses the retained task and generation, increments attempt, freezes a new model snapshot, and never
reruns ASR.

All asynchronous actions have one safe error boundary. Snapshot, configuration, port, retry,
archive, toolbar, and download failures update the current generation only and cannot leave the UI
permanently loading. Safe errors contain codes, not page text, prompts, signed URLs, or credentials.

## 12. Model Request Integrity

Within the Video Summary `ModelGateway`, API-capable providers receive the original role-preserving
message list. The video-summary request path must not flatten `system` and `user` messages for
adapters that support structured messages. Shared provider changes require ordinary-chat regression
tests and may not alter existing chat request semantics.

Legacy Web providers that require one question receive:

- fixed trusted instructions before and after the data block;
- a random, request-scoped data delimiter;
- JSON-encoded transcript data inside that delimiter;
- an explicit statement that delimited content is untrusted data;
- no credential, session history, or unrelated page context.

This is a structural separation requirement, not a claim that prompt injection can be completely
prevented at the model layer.

The capability descriptor records whether structured roles are preserved so tests can enforce the
correct path.

Custom ChatGPT Web endpoints may receive account credentials only when their origin exactly matches
the trusted ChatGPT origin. Cross-origin custom endpoints must use separate explicit credentials and
must never receive ChatGPT cookies, access tokens, or device identifiers.

## 13. Summary Correctness

A chunk succeeds only when parsing yields meaningful summary text, a key point, or a valid anchored
candidate. Empty, whitespace-only, structurally invalid, or unusably truncated chunk output becomes
a failed range. Chunk `finishReason: 'length'` produces a stable incomplete warning or failure rather
than silently counting as complete.

A final synthesis succeeds only when it contains meaningful parsed content. Empty final output falls
back to retained local summaries and yields `degraded` or `partial`, never `complete`. A final
`finishReason === 'length'` always produces `partial` or `degraded` with
`MODEL_OUTPUT_INCOMPLETE`; it cannot produce `complete` and is not automatically continued.

The checkpoint stores the original chunk plan. A synthesis-only retry reuses every successful chunk.
When failed ranges exist and the model budget changes, the new plan reruns every chunk whose primary
segment interval intersects a failed range; successful non-intersecting chunks are retained. An empty
selection fails with `VIDEO_SUMMARY_RETRY_RANGE_NOT_FOUND` and cannot run synthesis unchanged.

Transcript coverage is the union of source time intervals belonging to every successful chunk-plan
primary range retained in `successfulChunkResults`; final synthesis wording and anchor selection do
not change coverage. Failed, empty, and truncated chunk ranges are excluded. Each interval is clipped to `[0, totalDurationMs]`; invalid, negative, or reversed
ranges are excluded. Covered duration is clamped to total duration and ratio to `[0, 1]`.

## 14. Markdown and Logging Safety

Video-summary Markdown generation routes every untrusted scalar through
`escapeVideoSummaryMarkdownText(value, context)`. The field matrix covers video title, session title
fragment, archive question title, status, preferred language, overview, raw summary text, key-point
text, key-moment text, chapter title, chapter summary, speaker label, and transcript text. Heading,
list-item, and paragraph contexts escape backslashes and CommonMark punctuation, encode `<`, `>`, and
`&`, neutralize autolinks and raw HTML, and collapse field-owned newlines so a value cannot create a
new block or close a fence. Fixed headings, list markers, and timestamp structure are added only after
escaping.

Tests render archived output through the application's actual Markdown renderer and parse downloaded
output with the repository's CommonMark pipeline. Untrusted fields may produce text nodes but no
`a`, `img`, `video`, `script`, or raw-HTML nodes. The global chat Markdown renderer is unchanged.

MediaKit and model logs contain only stable local error codes, HTTP status, bounded operation names,
booleans, and sanitized request-ID metadata. Provider error bodies and messages are never logged.
Request IDs and provider codes are character-filtered and length-limited before logging or RPC.

## 15. Implementation Waves

This is one design and one end-state, implemented in four reviewable waves:

1. **Protocol foundation and minimal coordinator:** authenticated epoch/instance handshake, request
   versus authoritative envelopes, strict schemas, nested page identity, media scope,
   generation/attempt, start/attach/source-refresh/cancel acknowledgements, minimal `TASK_RELEASED`,
   route state, and request deduplication needed to exercise the new protocol end to end.
2. **Full coordinator and cancellation:** tab-platform slot and owner routing, duplicate replacement,
   quarantine handling, event replay, retention bounds, restart handling, gateway controller races,
   and full abort propagation.
3. **Media governance and page lifecycle:** polling, duration/URL validation, submission ambiguity,
   quota limits, cleanup registry, page-mode coordinator, host health, UI cancel, and checkpoint retry.
4. **Output correctness and hardening:** role preservation, output validation, retry chunk plan,
   coverage union, Markdown escaping, and safe logging.

Each wave must keep the repository buildable and include its own focused tests. Protocol producers
and consumers change atomically within a wave; no temporary old/new compatibility layer is shipped.

## 16. Testing

### 16.1 Protocol and security

- Reject offscreen ports with the right name but wrong extension ID, URL, tab, frame, or epoch.
- Reject content ports from wrong origins, subframes, mismatched platforms, and malformed senders.
- Reject unknown, oversized, non-plain, mismatched, and credential-bearing command payloads.
- Reject HTTP, localhost, IP-literal, credentialed, non-default-port, cross-platform, and redirected
  media URLs.
- Prove gateway operations cannot be invoked before offscreen authentication.

### 16.2 Concurrency and lifecycle

- Double-click and same-port repeated start create one task and cancel the predecessor.
- Old generation completion cannot delete, cancel, emit for, or satisfy the new generation.
- Same request key reentry cannot delete the replacement controller.
- Events produced during disconnection replay on attach.
- Retryable checkpoint failure survives host remount and supports summary-only retry.
- Grace expiry, tab removal, cancellation, replacement, and restart release all task resources.
- Background/offscreen restart produces `runtime-restarted`, rejects pending RPCs, and permits a new
  explicit start.

### 16.3 Sites and UI

- Bilibili P1 and P2 use different media scopes and never attach each other's tasks.
- YouTube home/watch/watch/live/Shorts SPA transitions select the correct mode and leave one handle.
- Removing only the host child remounts it once.
- Stale snapshot, refresh, and seek completions do not affect a new page identity.
- Active phases disable duplicate actions; Cancel is idempotent; action failures leave recoverable UI.

### 16.4 Media

- Reject missing, invalid, and over-three-hour durations before paid submission.
- Cancel during upload, direct submission, query, polling wait, and source refresh.
- Ambiguous submission maps to `VIDEO_SUMMARY_SUBMISSION_UNKNOWN` through the real RPC chain and is
  not retried.
- Polling follows fake-clock delays, `Retry-After`, jitter bounds, failure limits, and deadline.
- Unknown-size and misleading-size downloads stop at the hard byte limit and clean partial files.
- Deferred cleanup survives one failed deletion and succeeds on the next maintenance pass.

### 16.5 Summary and output

- Empty, invalid, injected, and length-truncated chunk/final outputs cannot report complete coverage.
- Retry with a changed model budget reruns every overlapping failed range.
- Overlapping transcript segments never produce coverage over 100%.
- Markdown payloads containing raw HTML, images, links, headings, lists, fences, and multiline speaker
  labels render as inert text in archived sessions and downloads.
- API providers preserve roles; Web providers keep transcript injection inside the untrusted boundary.
- Custom cross-origin ChatGPT endpoints receive no ChatGPT account credentials.

### 16.6 Required validation

Run:

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Confirm `VideoSummaryOffscreen.html/js` exist only in full Chromium output. Manual Chrome and Edge
smoke tests cover Bilibili multipart navigation, YouTube SPA mode changes, duplicate clicks, Cancel,
checkpoint retry, DOM remount, Background restart, offscreen restart, OPFS cleanup, and actual
MediaKit direct/upload behavior with sanitized diagnostics.

## 17. Success Criteria

- Unauthenticated extension contexts cannot invoke or replace the offscreen RPC channel.
- One owner has at most one active paid task; replacement and cancellation release the previous task.
- No old generation can mutate or delete newer task or gateway state.
- Bilibili multipart media never shares a task identity.
- A disconnected UI can recover current, retryable, or terminal state without losing events.
- Runtime restart fails ephemerally and explicitly rather than hanging or pretending to resume.
- Cancellation stops all local transfer, wait, and provider requests that have not already been
  accepted remotely.
- MediaKit polling, duration, URL access, OPFS bytes, queues, RPCs, and cleanup are bounded.
- Failed checkpoints remain summary-retryable without rerunning ASR.
- Empty or truncated model output cannot report a successful complete summary.
- Coverage stays between 0% and 100%.
- Archived/downloaded video Markdown treats page and model text as inert data.
- Provider credentials, signed URLs, prompts, subtitles, and raw provider errors do not cross or leak
  beyond their intended boundaries.
- Formatting, lint, full tests, production build, artifact checks, and required browser smoke tests
  pass.
