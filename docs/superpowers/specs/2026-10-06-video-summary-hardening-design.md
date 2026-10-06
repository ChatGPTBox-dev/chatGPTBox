# Enhanced Video Summary Hardening Design

**Date:** 2026-10-06

**Status:** Needs revision review

**Applies to:** Full Chromium enhanced Bilibili and YouTube video summaries

## 1. Goal

Fix confirmed security, billing, cancellation, identity, lifecycle, resource, and output-integrity
problems without introducing persistent jobs or distributed transactions.

Keep four boundaries:

- adapters own page identity, source discovery, refresh, and seek;
- Background authenticates contexts, allocates task fences, owns one execution slot per site tab, and
  authorizes privileged operations;
- Offscreen executes ephemeral attempts and owns in-memory transcript checkpoints;
- gateways own credentials and narrow provider calls.

A Background or Offscreen restart fails local work. It does not resume tasks.

## 2. Non-goals

- Exactly-once execution or billing across runtime restarts.
- Persistent task recovery.
- A general privileged fetch/model proxy.
- Process-level isolation from Offscreen; it is trusted extension code. Capability checks prevent
  programming mistakes, cross-task confusion, and duplicate paid operations.
- Guaranteeing rollback after a provider request begins.
- Global Markdown-renderer changes.
- Legacy fallback behavior changes.
- Custom ChatGPT endpoint credential hardening; that provider-wide issue requires a separate design.

## 3. Identity

Each adapter returns one nested `PageIdentity`:

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

Bilibili CID distinguishes multipart media. Source snapshots carry an exactly equal copy. Messages do
not duplicate identity fields at the top level.

Background derives the owner from browser sender metadata and validated page identity:

```js
{ tabId, documentId, platform, mediaScope }
```

The task fence is:

```js
{ owner, taskId, generation, attempt }
```

Background alone allocates generation and attempt. Events and task-scoped RPCs carry the fence; stale
fences are ignored.

Page mount, snapshot, refresh, and seek use `PageIdentity + pageGeneration`, not a task fence.

## 4. Port Authentication

### 4.1 Content

Background accepts a content port only when:

- `sender.id === runtime.id`;
- `sender.tab.id` is an integer;
- `sender.documentId` is non-empty;
- `sender.frameId === 0`;
- sender URL is HTTPS and belongs to the expected Bilibili or YouTube origin;
- requested platform matches the origin.

Invalid ports are disconnected before Offscreen creation.

### 4.2 Offscreen

Background authenticates Offscreen using browser-provided context identity:

1. query `runtime.getContexts()` for `OFFSCREEN_DOCUMENT` and the exact extension URL;
2. require same extension ID, no sender tab, exact URL, and sender document ID matching that context.

Port name alone is insufficient. No nonce challenge is added because browser context type, exact URL,
extension ID, and document ID form the trust root.

On Background initialization, any existing video-summary Offscreen document is closed before new
video-summary ports are accepted. A fresh Offscreen is created on demand. If the authenticated
Offscreen disconnects, Background revokes capabilities, fails current executions with
`VIDEO_SUMMARY_RUNTIME_RESTARTED`, clears execution slots, and permits a later explicit restart.

## 5. Message Validation

Every message has an explicit schema and field allowlist. Reject non-plain data, unknown enums,
invalid IDs, functions, DOM objects, signals, credentials, arbitrary headers, or mismatched identity.

| Limit | Value |
| --- | ---: |
| ID, code, operation name | 128 UTF-16 code units |
| Video title or label | 1,000 code units |
| One subtitle cue | 20,000 code units |
| Subtitle cues | 20,000 |
| Total subtitle text | 16 MiB |
| Media candidates | 16 |
| Upload headers | 32 entries, 256 code units per key/value |
| Serialized content command | 24 MiB |
| Pending RPCs per task | 16 |

Aggregate validation runs before privileged work. Excess fails with
`VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED`.

## 6. Minimal Background State

Background keeps only four in-memory collections:

### 6.1 `activeSlots`

One entry per `(tabId, platform)`, containing only an executing attempt:

```js
{
  state: 'starting' | 'running' | 'cancelling',
  fence,
  pageIdentity,
  port,
}
```

A slot is released when the attempt emits `EXECUTION_RELEASED`. Completed, failed, and retryable state
never occupies an active slot.

### 6.2 `retainedTasks`

One entry per retained task generation:

```js
{
  owner,
  taskId,
  generation,
  pageIdentity,
  state: 'retained' | 'deleting',
  checkpointAvailable,
  latestEvent,
  terminalEvent,
  expiresAt,
}
```

This record owns replay state. Offscreen owns the corresponding transcript checkpoint. A retained task
may retry only when its `(tabId, platform)` execution slot is empty.

Terminal and retryable records expire 15 minutes after attempt terminal time, regardless of
attachment. Expiry sends `DELETE_TASK`, which removes the Offscreen checkpoint. Explicit cancel,
navigation grace expiry, tab removal, and runtime reset also delete the retained task.

### 6.3 `startRecords`

A bounded map keyed by `(documentId, taskId)`:

- stores the initial start request hash and response;
- identical replay returns the same response;
- conflicting content returns `VIDEO_SUMMARY_REQUEST_ID_CONFLICT`;
- pending and terminal records are capped at 128 per document;
- terminal records expire after 15 minutes.

A pending-start cancellation marker is stored in the same record and is never evicted while pending.

### 6.4 `capabilities`

One task-generation capability record containing source choice, ASR confirmation, validated candidate
URLs, upload reservation, provider task ID, and model identity by attempt. It contains only security
invariants and single-use reservations, not media-pipeline business state.

No other request journal, restart tombstone, cleanup registry, or protocol transaction log is added.

## 7. Unified Attempt Start

Initial start and summary retry use the same attempt protocol.

### 7.1 Fence allocation

For initial start, Background validates the content request, checks `(documentId, taskId)` idempotency,
requires an empty `(tabId, platform)` slot, allocates `generation` and `attempt = 1`, and creates the
retained task shell and capability.

For retry, Background validates the retained task and checkpoint, requires an empty execution slot,
and allocates `attempt + 1` under the same generation. Offscreen never allocates a fence.

### 7.2 Start protocol

Background reserves `activeSlots[(tabId, platform)]`, immediately writes synthetic `TASK_STARTED` to
the retained task, installs the exact attempt model capability, and sends:

```js
{
  type: 'START_ATTEMPT',
  requestId,
  fence,
  mode: 'initial' | 'retry-summary',
  payload,
}
```

Offscreen performs only local registration:

1. reject if the permanent task cancel latch is set;
2. reject a stale or duplicate conflicting fence;
3. bind an attempt controller to the generation checkpoint;
4. reply `ATTEMPT_ACCEPTED { requestId, fence }` without starting provider work;
5. wait for `ATTEMPT_AUTHORIZED { requestId, fence }`.

Background accepts the ACK only if the same slot/fence is still starting and not cancelled. It then
marks the slot running, marks the exact-fence capability executable, sends `ATTEMPT_AUTHORIZED`, and
returns `START_ACK` or `RETRY_ACK` to Content. `ATTEMPT_AUTHORIZED` and all later gateway RPCs use the
same authenticated Background↔Offscreen port; port FIFO guarantees authorization arrives before the
first RPC.

If acceptance times out or Cancel wins, Background revokes capability, sends `CANCEL_TASK`, and keeps
the slot cancelling until release or Offscreen reset. Offscreen times out an accepted but unauthorized
attempt after 10 seconds and releases it without provider work.

This has one authority: Background allocates the fence and authorizes execution; Offscreen only
registers or rejects it.

## 8. Initial Start Cancellation

Before receiving a fence, Content sends:

```js
{
  type: 'CANCEL_START',
  cancelRequestId,
  targetStartRequestId,
  taskId,
  pageIdentity,
}
```

Background records cancellation in the matching `(documentId, taskId)` start record. Every initial
start continuation checks that marker before slot reservation, before `START_ATTEMPT`, and after
`ATTEMPT_ACCEPTED`.

Background always settles the target start with one of:

```text
START_ACK(started, fence)
START_ACK(cancelled, null)
START_ACK(cancelling, fence)
START_ACK(rejected, null, errorCode)
```

The cancellation marker remains until that start reaches a terminal ACK, then for 15 minutes. Cancel
records share the start-record capacity but pending records are never evicted; when capacity is full,
new starts are rejected while cancellation remains available for existing pending records.

## 9. Task Cancellation and Release

After a fence exists, Content cancels by task ID and generation, not attempt:

```js
{
  type: 'CANCEL_TASK',
  taskId,
  generation,
}
```

Background ignores any caller-supplied owner, derives tab/document/platform from the authenticated
sender, and resolves the matching retained task before constructing the authoritative owner. It then
resolves the current active attempt, if any, revokes the whole generation capability, sets
its cancellation state, and forwards the current fence to Offscreen. This remains valid when Content
missed a retry ACK and still knows an older attempt.

Offscreen has a permanent generation cancel latch separate from attempt controllers. It is set outside
provider-drain waits, immediately aborts every known attempt, and prevents a delayed attempt handler
from starting provider work.

Attempt cleanup emits:

```text
EXECUTION_RELEASED(fence)
EXECUTION_RELEASED_ACK(fence)
```

`EXECUTION_RELEASED` removes only the active execution slot and attempt resources. It does not delete
the transcript checkpoint or retained result.

If explicit cancellation finds no active execution, Background atomically marks the retained task
`deleting` before sending `DELETE_TASK`; deleting tasks reject attach retry/start-from-checkpoint. The
retained record is removed only after `TASK_DELETED` or Offscreen reset.

Task deletion emits:

```text
DELETE_TASK(owner, taskId, generation)
TASK_DELETED(owner, taskId, generation)
TASK_DELETED_ACK(owner, taskId, generation)
```

`DELETE_TASK` instructs Offscreen to remove the checkpoint and generation resources. It does not
remove Background's retained record. Offscreen returns `TASK_DELETED` after local deletion; Background
then removes the matching `deleting` retained record and replies `TASK_DELETED_ACK`. Release and
deletion handlers are statelessly idempotent: missing Offscreen resources are treated as already
deleted, and a missing Background retained record still receives the same ACK.

If active execution does not release within 10 seconds after cancellation, Background closes and
recreates Offscreen, clears active slots and retained checkpoint claims, and reports runtime restart.
It does not start a second local execution while release is unknown.

## 10. Attempt Completion and Retry

Offscreen emits the terminal task event, then releases attempt resources with `EXECUTION_RELEASED`.
Background stores the bounded event in `retainedTasks` before delivering it and frees the active slot
on release.

- success retains result plus checkpoint for optional summary retry;
- failure with checkpoint retains retryable state;
- failure without checkpoint retains terminal error for replay but has no retry action;
- explicit cancel deletes the retained task after execution release.

A retry reuses section 7: Background allocates the next attempt, occupies the empty active slot,
installs only the next attempt's model capability, and sends `START_ATTEMPT`. There is no
`RETRY_ACCEPTED → RETRY_AUTHORIZED` fence transfer; `ATTEMPT_ACCEPTED → ATTEMPT_AUTHORIZED` is the
single start barrier for every attempt.

Old attempt cleanup is tagged by fence and cannot delete the generation checkpoint or a newer
controller. Provider drain has a separate 10-second timeout and cannot block the generation cancel
latch.

## 11. Replay, Disconnect, and Navigation

Background writes synthetic `TASK_STARTED` during active-slot reservation, before sending
`START_ATTEMPT`. Therefore attach during both starting and running always has an event.

`ATTACH_TASK` returns:

```js
{
  type: 'ATTACH_ACK',
  status: 'active' | 'retryable' | 'terminal' | 'not-found',
  fence,
  event,
}
```

`not-found` maps to `TASK_UNAVAILABLE`; it does not imply restart because expiry or normal deletion can
also remove a task.

A same-document/same-media disconnect gets a 15-second grace period. Grace expiry:

1. revokes generation capability;
2. sets Background cancellation state;
3. sends `CANCEL_TASK` for the current attempt, if active;
4. waits for `EXECUTION_RELEASED`, resetting Offscreen on timeout;
5. marks the retained task `deleting`, sends `DELETE_TASK`, and removes retained state only after
   `TASK_DELETED`; Offscreen reset is the fallback terminal cleanup.

Navigation to another document, video, or Bilibili CID follows the same cancellation/deletion path.
A new video cannot start in the tab-platform slot until active execution is released.

At most 32 retained tasks or 16 MiB of serialized replay state are kept. Oversized terminal output is
replaced with `VIDEO_SUMMARY_RESULT_TOO_LARGE`. Capacity occupied by live retained tasks rejects new
work rather than evicting active state.

## 12. Gateway Safety Invariants

Gateway capability checks protect task integrity and billing invariants; they do not claim an
adversarial sandbox against trusted Offscreen code.

Each capability binds:

- generation fence and current authorized attempt;
- source choice and recorded ASR confirmation;
- exact validated candidate URLs;
- at most one upload-target reservation;
- provider task ID returned by submission;
- model identity for the authorized attempt.

Rules:

- native-subtitle tasks cannot call ASR operations;
- direct ASR submission reserves the generation's direct-submit slot before network I/O;
- when query returns the documented terminal direct-download failure, Gateway may issue one opaque,
  random fallback permit bound to the generation and provider task ID; this is the only provider-code
  interpretation retained at the privileged boundary;
- pipeline decides whether to use that permit; upload-target creation validates but does not consume
  it, while fallback submission validates and consumes it; upload-target creation and fallback
  submission also have separate single-use reservations;
- ambiguous, pending, active, completed, or non-download-failure submissions cannot be repeated;
- upload uses only the exact Background-issued HTTPS target, `PUT`, allowlisted headers,
  `credentials: 'omit'`, and `redirect: 'error'`;
- query uses only the provider task ID recorded for that generation;
- model calls use only the current authorized attempt's model identity;
- cancellation revokes capability before network abort;
- attempt terminal state revokes model capability; task deletion removes the generation capability.

The media pipeline remains responsible for fallback sequencing, polling, and interpretation of
provider errors. Gateway stores only safety facts and single-use reservations.

## 13. Cancellation Semantics

The task AbortSignal reaches source refresh, gateway RPC, download, writable stream, upload,
submission, query, polling waits, and model generation. Gateway controllers are keyed by fence plus
request ID; `finally` deletes only the controller still stored under that key.

The guarantee is limited:

> After cancellation is observed, the extension does not actively begin a new stage. A network call
> already started, or whose result is unknown, may have been accepted and may incur cost.

Ambiguous submission maps to `VIDEO_SUMMARY_SUBMISSION_UNKNOWN` and is never automatically retried.
MediaKit `clientToken` is correlation metadata unless verified provider documentation proves
idempotency. No cross-Background-restart billing deduplication is promised.

Cleanup uses an independent bounded cleanup signal, not the aborted task signal.

## 14. Media Governance

### 14.1 URL and upload policy

Canonical media duration must be finite, positive, and at most `10_800_000` ms. Candidate duration may
differ by at most the greater of two seconds or 1%.

Initial URLs must be HTTPS, contain no credentials or non-default port, and match:

- Bilibili: exact `bilivideo.com` or subdomain;
- YouTube: exact `googlevideo.com` or subdomain.

New suffixes require sanitized production fixtures and tests. Direct MediaKit fetch is remote, so the
extension validates only the submitted initial URL and makes no provider-redirect claim.

Local fetch uses `redirect: 'manual'`; redirects are rejected unless revalidated before body read.
`requiredRequestOrigin` is metadata only. If transport requires headers Offscreen cannot set, local
fallback is disabled.

Upload-target validation requires HTTPS, an approved MediaKit/object-storage host, method `PUT`, no
credentials/non-default port, at most 32 allowlisted headers, `credentials: 'omit'`, and
`redirect: 'error'`.

### 14.2 Polling

MediaKit polling uses an abortable timer:

- minimum/initial delay: two seconds;
- exponential growth capped at 30 seconds;
- injectable ±20% jitter;
- `retryAfterMs` clamped to 2–30 seconds;
- five consecutive transient failures;
- total deadline: two hours.

There is no zero-delay path.

### 14.3 OPFS

Reserve the greater of 64 MiB or 10% of quota. Unknown lengths use a conservative duration/bitrate
estimate. Every task has a 1 GiB streaming hard limit.

Offscreen bootstrap deletes every child in the dedicated `video-summary-tasks` root before accepting
work. Task completion/cancellation also deletes its directory. No persistent cleanup journal is added.
A crash may leave a directory; the next bootstrap removes it.

## 15. Page Lifecycle and UI

A small page-mode coordinator owns one disposable handle and reevaluates
`enhanced | legacy | none` on adapter identity changes. Site rules stay in each adapter.

This covers YouTube home→watch, watch→watch, and watch→live/Shorts. Bilibili compares BVID+CID. Async
page operations verify `PageIdentity + pageGeneration`; task events verify the task fence separately.
The host exposes `isConnected()` for child-only DOM removal recovery.

Source actions are disabled while starting, running, cancelling, or reattaching. A synchronous latch
prevents double clicks. Running attempts expose Cancel. Retry appears only for completed or
retryable-failure retained tasks with a checkpoint. Async handlers update only the current page
generation.

## 16. Summary and Sink Safety

Video-summary API requests preserve system/user roles. Web-only providers receive fixed instructions
and a JSON-encoded untrusted transcript block. A random delimiter is not treated as a security
boundary. Video-summary model requests expose no tools.

A chunk succeeds only with meaningful parsed content. Empty, invalid, or length-truncated chunks become
failed ranges. Empty or truncated final output falls back to local summaries and yields
partial/degraded with `MODEL_OUTPUT_INCOMPLETE`, never complete.

The checkpoint stores the original chunk plan. Synthesis retry reuses successful chunks. Failed-range
retry reruns every new chunk whose primary segment ID interval intersects a failed range.

Coverage denominator is canonical media duration. Numerator is the union of canonical transcript cue
intervals belonging to successful chunk primary ranges. Failed/empty/truncated ranges are excluded;
intervals are clipped and ratio is clamped to `[0, 1]`.

Markdown is sink-specific:

- titles, session names, and question metadata remain plain strings and are not passed through a
  Markdown escaper;
- structured summary/transcript Markdown uses a dedicated serializer that escapes each text field for
  its exact heading, paragraph, or list context;
- archive tests use the application renderer; download tests use the repository parser;
- the design guarantees inert output in these two supported sinks, not every external Markdown viewer.

Logs contain stable local codes, HTTP status, bounded operation names, booleans, and sanitized request
IDs. They never contain provider bodies/messages, signed URLs, upload references, prompts, subtitles,
or credentials.

## 17. Delivery

Implement in three buildable increments:

1. **Protocol/coordinator:** canonical identity, browser-rooted authentication, schemas,
   `activeSlots`/`retainedTasks`, start records, unified attempt start, execution release/task delete,
   replay, disconnect behavior, and tests.
2. **Media/lifecycle:** gateway safety invariants, cancellation propagation, URL/upload policy,
   polling, duration/quota limits, bootstrap OPFS scan, page-mode lifecycle, and UI cancel/retry.
3. **Summary/sinks:** message roles/no-tools policy, output validity, retry ranges, interval coverage,
   sink-specific serialization, and logging redaction.

No temporary dual protocol ships.

## 18. Required Tests

- Reject forged content/offscreen ports using browser context identity.
- Bilibili P1/P2 have different identities.
- Initial and retry attempts receive Background-allocated fences.
- `ATTEMPT_AUTHORIZED` precedes the first gateway RPC on the same port.
- Cancel-before-start settles the target start and survives every await boundary.
- Generation-level cancel works when Content holds an old attempt.
- Active execution release does not delete retained checkpoint; `DELETE_TASK` does.
- Completed/retryable attempts release the active slot and allow another video to start.
- Retry reacquires the slot and uses unified attempt start.
- Attach during starting returns `TASK_STARTED`; not-found maps to `TASK_UNAVAILABLE`.
- Disconnect grace expiry revokes capability, cancels execution, and deletes retained task.
- Capability reservations prevent repeated direct/fallback submissions and cross-task substitution.
- Cancellation reaches refresh, download, upload, submission, query, waits, and model calls.
- Polling has minimum delay, clamp, backoff, failure limit, deadline, and abort.
- Duration mismatch and over-three-hour media fail before paid work.
- Unknown/misreported size stops at quota or 1 GiB; bootstrap removes crash leftovers.
- Empty/truncated output cannot be complete; changed-budget retry covers failed ranges.
- Overlapping cues never exceed 100% coverage.
- Supported archive/download sinks render malicious fields inert.
- API messages preserve roles; video-summary model calls expose no tools.
- Logs/RPC errors expose no sensitive fields.

Run `npm run pretty`, `npm run lint`, `npm test`, and `npm run build`; inspect artifact separation and
manually exercise Bilibili multipart, YouTube SPA, duplicate start, Cancel, checkpoint retry, DOM
remount, disconnect grace, Background/Offscreen restart, and MediaKit direct/upload paths.

## 19. Success Criteria

- Browser context identity roots privileged-channel authentication.
- One `(tabId, platform)` slot controls at most one executing attempt.
- Completed/retryable state never blocks the execution slot.
- Background is the sole fence allocator and attempt authorizer.
- Start/cancel/release/delete protocols are race-safe and idempotent.
- Gateway capabilities enforce task binding and single-use paid reservations without duplicating
  pipeline business logic.
- Cancellation starts no new stage after observation, without promising remote rollback.
- Runtime restart is explicit failure, not recovery.
- Polling, messages, RPCs, retained tasks, downloads, and OPFS are bounded.
- Retryable checkpoints survive execution release and support summary-only retry.
- Empty/truncated output, coverage, supported Markdown sinks, and logs meet their safety contracts.
- Legacy fallback and unsupported builds remain unchanged.
