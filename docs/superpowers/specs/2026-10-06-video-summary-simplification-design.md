# Shared Video Summary Simplification Design

**Date:** 2026-10-06

**Status:** Approved for implementation planning

## 1. Purpose

Simplify the enhanced Bilibili and YouTube video-summary implementation introduced on the current
branch while preserving user-visible behavior, wire contracts, persistence formats, summary output,
and legacy fallback behavior. The only intentional behavior changes are:

1. both adapters use the same strict enhanced-mode capability gate;
2. both adapters use one shared mount and navigation lifecycle;
3. terminal and disposed task resources are released according to an explicit retention policy.

## 2. Scope

### 2.1 Included

- Replace adapter-specific enhanced-mode checks with one shared predicate.
- Require the build flag, enabled user setting, Manifest V3, the `offscreen` permission, and a
  Chromium 116+ runtime before either adapter enters enhanced mode.
- Introduce one shared site-adapter controller for host mounting, target replacement, video changes,
  and disposal.
- Keep Bilibili and YouTube page extraction, identity parsing, subtitle/media discovery, and player
  seeking in their respective bridges.
- Make bridge navigation subscriptions the single video-change signal and remove duplicate
  adapter-owned URL polling.
- Preserve target-element recovery without recreating a healthy host.
- Release terminal task state that cannot be retried or reattached, while retaining summary
  checkpoints required by the existing retry action.
- Delete production code proven unused after tracing imports, build entries, manifests, ports,
  runtime messages, and tests.
- Update or delete tests that exist only for removed compatibility seams.

### 2.2 Excluded

- Changes to model selection, provider dispatch, MediaKit behavior, summary prompts, result format,
  settings storage, localization, or archive/export formats.
- Changes to the content/background/offscreen wire protocol.
- Reliable state replay after reattachment or browser/background restart.
- Immediate cancellation on host disposal; the existing 15-second router grace period remains.
- RPC abort propagation, queue expiry, MediaKit polling policy, and offscreen sender authentication.
- Combining Bilibili and YouTube extraction logic into one implementation.
- Changes to legacy subtitle-summary behavior except selecting it when the strict enhanced gate
  fails.

## 3. Capability Gate

Add one public capability decision that accepts user configuration and runtime facts. It returns
`true` only when all conditions hold:

- the non-minimal build enables enhanced video summaries;
- `videoTranscriptionEnabled` is `true`;
- the extension manifest is version 3;
- the manifest declares the `offscreen` permission;
- the manifest minimum Chrome version is at least 116;
- the user agent identifies Chrome or Edge.

Runtime fact collection belongs in one content-script helper, not in individual adapters. Any
manifest access failure is treated as unsupported. Both Bilibili and YouTube call this same helper.
Site eligibility remains separate: YouTube still excludes unsupported watch identities and live
content; Bilibili still excludes bangumi pages.

When the shared gate or site eligibility fails, the adapter follows its existing legacy path. This
prevents full Firefox builds from entering an enhanced flow whose offscreen artifact is intentionally
absent.

## 4. Shared Adapter Lifecycle

Introduce a shared controller used by both enhanced adapters. The controller accepts a narrow site
configuration:

```js
{
  platform,
  createBridge,
  findTargetElement,
  waitForTargetElement,
  isPageSupported,
}
```

The site adapter remains responsible for constructing the bridge and supplying its target lookup.
The controller owns:

1. waiting for a valid mount target;
2. mounting exactly one `VideoSummaryHost` for the current supported video identity;
3. subscribing to `bridge.subscribeToVideoChanges`;
4. disposing the old host and bridge subscription before a new mount;
5. recovering when the site replaces or temporarily removes the mount target;
6. preventing overlapping asynchronous mount attempts;
7. disposing all timers, subscriptions, and hosts when the controller is disposed.

The controller must not inspect Bilibili or YouTube URL formats, APIs, DOM beyond the supplied target
callbacks, live-stream state, or subtitle/media data.

### 4.1 Navigation

Each bridge remains the canonical source of video identity and emits only meaningful identity
changes. Bilibili includes multipart page identity in its change event. YouTube emits supported
watch identity changes and lets the site eligibility callback reject live or unsupported pages.

Adapter-level 500 ms URL polling is removed. Target recovery may use a shared bounded observation or
polling mechanism because target replacement is a DOM lifecycle concern, not a second navigation
signal. A healthy host whose identity and target are unchanged is never recreated.

### 4.2 Host Boundary

`mountVideoSummaryHost` continues to own source loading, user actions, rendering, task commands,
archive/export, and follow-up chat. It does not gain site-specific behavior. The obsolete
`mountBilibiliVideoSummaryHost` alias and Bilibili forwarding modules are removed after tests migrate
to the generic API.

Host disposal clears snapshot retry timers, width observation, toolbar UI, port listeners, rendered
UI, and the container. It does not immediately cancel a task, preserving the existing navigation
reattachment grace period.

## 5. Task Resource Retention

The current runner retains checkpoints, command snapshots, and emit callbacks indefinitely. The
cleanup design distinguishes retryable from non-retryable terminal state:

- Active controllers are removed when an execution attempt settles.
- A successful result remains retryable because the UI exposes summary-only retry; its transcription
  checkpoint, sanitized command snapshot, and emit binding remain available while the router route
  is attachable.
- A failed result retains state only when a transcription checkpoint exists and the emitted event
  reports `checkpointAvailable: true`.
- Cancellation, owner expiry, tab removal, and failures without a transcription checkpoint release
  checkpoint, command, emit, controller, and owner bindings.
- When the router removes a route after explicit cancellation or the 15-second disconnect grace
  period, offscreen receives the existing `CANCEL_TASK` command and releases the task state.
- Offscreen owner bindings are removed through the same cancellation cleanup path.

The runner exposes one narrow task-release operation used internally by cancellation. No new wire
command is introduced. Retry behavior and the existing grace period remain unchanged.

## 6. Unused Code Removal

Delete code confirmed outside the production graph:

- `src/components/BilibiliVideoSummaryView/` and its superseded isolated test;
- Bilibili forwarding files for the shared host, port, and width controller;
- `BilibiliVideoTranscriptionSettings.jsx` and its old-path test;
- `mountBilibiliVideoSummaryHost` and `isBilibiliVideoTranscriptionEnabled` aliases;
- `openai-compatible-tool-call.mjs` and its dedicated tests;
- unused `pollMediaKitTask`;
- unused Bilibili parsing/selection helpers superseded by the active bridge and shared selector;
- redundant router gateway constructor parameters;
- the unused `VIDEO_SUMMARY_TASK_EVENT` runtime-message branch;
- unnecessary result-builder time re-exports after tests import the canonical time module.

Test inspection seams such as router route access may remain when they provide the narrowest stable
way to verify lifecycle cleanup. Functions passed to `chrome.scripting.executeScript`, legacy
adapter paths, duplicated trust-boundary validation, protocol constants, and manifest permissions
are active and must not be removed.

## 7. Error and Fallback Behavior

- Capability-detection errors select the legacy adapter path rather than surfacing a new UI error.
- Shared lifecycle mount failures dispose partial state and allow target recovery; they do not leave
  duplicate hosts or subscriptions.
- Snapshot, provider, ASR, summary, archive, and export errors retain their current codes and UI
  behavior.
- Unsupported YouTube pages and live streams keep the legacy path.
- Unsupported Bilibili pages keep their current exclusion or legacy path.
- No failure automatically starts paid ASR.

## 8. Testing

Add or update focused tests for:

- the complete shared capability matrix, including Firefox MV2, missing offscreen permission,
  Chromium below 116, non-Chromium user agents, disabled settings, and minimal builds;
- identical gate use by Bilibili and YouTube adapters;
- one host per identity and target;
- Bilibili multipart and YouTube SPA navigation through bridge subscriptions;
- target replacement and temporary target absence;
- disposal of subscriptions, timers, port listeners, and rendered hosts;
- task cleanup after cancellation, owner expiry, tab removal, and non-retryable failure;
- retention of checkpoints required by summary-only retry;
- legacy fallback when strict capability or site eligibility fails;
- absence of references to deleted modules and aliases.

Run repository-required validation after implementation:

1. focused tests during development;
2. `npm run pretty`;
3. `npm run lint`;
4. `npm test`;
5. `npm run build`;
6. inspect full Chromium for `VideoSummaryOffscreen.html/js` and confirm they remain absent from
   Firefox and minimal outputs.

Manual smoke testing should cover Bilibili multipart navigation, YouTube SPA navigation, enhanced
summary startup, legacy fallback in an unsupported environment, summary-only retry, and extension
reload/reinjection.

## 9. Success Criteria

- Both sites make the enhanced-mode decision through the same strict capability gate.
- Unsupported runtimes never suppress the legacy summary path.
- Shared lifecycle code owns mounting and navigation without duplicate adapter URL polling.
- Site bridges retain all site-specific extraction and player behavior.
- Terminal non-retryable tasks and disposed UI resources do not remain indefinitely.
- Existing task protocol, retry behavior, output, persistence, and user-facing features remain
  compatible.
- Confirmed unused compatibility and abandoned implementation code is removed.
- Formatting, lint, tests, and production build pass.
