# Shared Bilibili and YouTube Video Summary Design

**Date:** 2026-10-04

**Status:** Implemented; updated to match the validated runtime on 2026-10-05

**Platforms:** Full Chromium build, Chrome and Edge 116+

**ASR provider:** Volcengine AI MediaKit

## 1. Purpose

Extend the enhanced Bilibili video-summary workflow to ordinary YouTube watch pages while turning
its reusable implementation into a platform-neutral video-summary framework. Bilibili and YouTube
must offer the same user-facing capabilities:

1. explicit native-subtitle track selection, preferring authored subtitles over automatic ones;
2. user-confirmed MediaKit ASR when no suitable subtitle exists or the user chooses ASR;
3. whole-video overview, key points, chapters, and key moments with source-derived timestamps;
4. a timestamped transcript with local seek actions;
5. cancellation, task reattachment, summary-only retry, archive, Markdown export, and follow-up chat.

The existing Bilibili behavior remains intact. Site-specific page parsing and player control stay in
site bridges; task execution, UI, messaging, and settings become shared.

## 2. Scope

### 2.1 Included

- Ordinary `https://www.youtube.com/watch?v=<videoId>` on-demand videos.
- Existing supported ordinary Bilibili video pages.
- Full Chromium package on Chrome and Edge 116 or newer.
- YouTube transcripts rendered by the official transcript panel, including the modern
  `PAmodern_transcript_view` and legacy searchable-transcript panels.
- Authored and automatic YouTube caption tracks exposed by the current page/player response when
  track-specific native capture succeeds.
- Explicit subtitle-track selection when multiple track-specific sources are available; panel and
  Innertube fallbacks produce one neutral transcript track.
- MediaKit ASR using playable YouTube audio candidates when the user confirms the operation.
- A shared feature setting migrated from the existing Bilibili setting.
- Platform-neutral host, view, port, ownership, errors, and build capability names.
- Existing legacy subtitle-summary behavior as the fallback outside the enhanced capability gate.

### 2.2 Excluded

- YouTube Shorts, live streams, premieres while live, and non-watch pages.
- Firefox, Safari, and the minimal Chromium package for the enhanced workflow.
- DRM, paid, private, age-gated, login-gated, or region-restriction bypasses.
- Browser-local speech recognition or a repository-operated media backend.
- Persistent jobs across browser restarts.
- Transcript embedding or retrieval-augmented follow-up questions.
- Automatic ASR submission without per-run confirmation.

Unsupported pages and environments retain the current adapter path. The enhanced implementation
must not weaken access checks imposed by YouTube or Bilibili.

## 3. Product Decisions

- One shared `videoTranscriptionEnabled` setting controls enhanced summaries on both sites.
- Migration preserves the stored value of `bilibiliVideoTranscriptionEnabled`; users who enabled
  Bilibili automatically receive the shared feature, while the default remains disabled.
- Free page-session subtitles are always preferred. The official YouTube transcript panel is the
  first source because YouTube itself satisfies current integrity/PO-token requirements and renders
  stable transcript data.
- If the official panel is unavailable, retrieval falls back to exact native player capture,
  Innertube `get_transcript`, and finally bounded timed-text URL replay.
- The UI lists all usable track-specific results and orders authored tracks before automatic tracks.
  Panel and Innertube fallbacks appear as one neutral transcript track.
- The initial selected track follows preferred-language matching within that source ordering.
- ASR remains manually selectable, but subtitle-discovery failure never starts ASR automatically.
- Every ASR run presents the existing privacy, upload, cost, and cancellation disclosure before any
  remote submission.
- Processing covers the complete available video and uses the existing chunked summary pipeline.
- The transcript stays in its source language; summaries use the configured preferred language.
- YouTube SPA navigation tears down the old page host and binds a new host only for a valid watch
  video. A matching in-flight task may reattach during the existing grace period.
- Closing, reloading, navigating away, or switching videos follows the existing page-bound task
  lifecycle; no new persistence guarantee is introduced.

## 4. Architecture

### 4.1 Shared `VideoSummaryHost`

Refactor the current Bilibili host into a platform-neutral controller. It accepts:

```js
{
  platform,
  bridge,
  targetElement,
  connect,
}
```

The host owns source loading, selected track state, ASR confirmation, task commands, rendering,
archive/export metadata, and follow-up chat. It must not know Bilibili or YouTube DOM/API details.
Host CSS classes, fallback error codes, archive labels, prompts, and file-name defaults use the
platform metadata rather than hard-coded Bilibili text.

Task lookup keys become `documentId:platform:videoId`, preventing equal IDs from different sites
from sharing an attachment slot.

### 4.2 Shared `VideoSummaryView`

Rename and generalize `BilibiliVideoSummaryView`. The view receives a list of normalized subtitle
tracks plus the selected track ID instead of one preselected Bilibili track. It renders:

- track label, language, and authored/automatic/AI source;
- subtitle and ASR source actions;
- the existing ASR confirmation;
- progress, warnings, actionable failures, structured results, transcript, and actions.

The same component and styles render on both sites. Site names may appear in localized labels, but
no platform behavior belongs in the component.

### 4.3 Site bridge interface

Each site implements the same page-owned interface:

```js
{
  getSnapshot(),
  refreshSnapshot({ expectedPlatform, expectedVideoId }),
  seekTo(startMs),
  getCurrentVideoId(),
  subscribeToVideoChanges(listener),
}
```

A source snapshot is structured-clone-safe:

```js
{
  platform,
  videoId,
  pageId,
  title,
  durationMs,
  nativeSubtitleTracks,
  subtitleDiscovery,
  mediaCandidates,
}
```

Every normalized subtitle track has a stable ID, display name, language, source classification,
and timestamped cues. Every media candidate contains only the fields already accepted by the
shared media pipeline, including expiry and request-origin information when available.

The Bilibili bridge retains WBI signing, AI-conclusion fallback, multipart identity, and its own
errors. The YouTube bridge owns all YouTube extraction, caption fetching, media URL handling,
player seeking, and navigation detection.

### 4.4 YouTube source bridge and subtitle acquisition

The YouTube bridge validates that the URL path is `/watch` and that `v` is a valid video ID. It
loads player data available to the page or fetched watch HTML, parses bounded embedded JSON rather
than using unbounded string slicing, and verifies that parsed identity matches the current URL.

It normalizes:

- title, duration, and playability status;
- caption descriptors, including language, display label, `vssId`, translation metadata, and
  automatic-caption classification;
- caption cues with `startMs`, `endMs`, and normalized text;
- audio-only adaptive formats and backup URLs suitable for the existing direct-fetch/upload
  pipeline.

Subtitle acquisition uses only data available to the current YouTube page session and runs in this
order:

1. **Official transcript panel DOM.** Background runs a restricted MAIN-world function that waits
   up to 15 seconds for YouTube's transcript control, expands the description when needed, opens the
   panel, and reads the first expanded panel containing segments. It supports both
   `PAmodern_transcript_view` and `engagement-panel-searchable-transcript`, duplicate hidden controls,
   localized labels such as `内容转文字`, legacy `ytd-transcript-segment-renderer`, and modern
   `transcript-segment-view-model` nodes. It deduplicates cues, derives end times, enforces 5 MiB and
   10,000-segment limits, and closes only UI opened by the extension.
2. **Native player capture.** For each concrete descriptor, install temporary MAIN-world `fetch` and
   XHR hooks before loading the exact captions track. Match video ID, language, source kind, and
   `vssId`; accept only non-empty bounded responses; then restore the original track and CC state.
3. **Innertube transcript.** Use only a `get_transcript` endpoint found under the searchable
   transcript engagement panel, supporting `getTranscriptEndpoint.params` and valid continuation
   forms.
4. **Timed-text replay.** As the last free fallback, preserve the signed base URL and copy only
   allowlisted page-observed integrity/client parameters. HTTP 200 with an empty body is a failure,
   not an empty transcript.

Panel or Innertube results form one neutral transcript track. Native capture and replay preserve
track-specific authored/automatic metadata. Failure of all free paths leaves ASR as an explicit
user action; it never triggers automatically.

`refreshSnapshot` re-parses the current player response and rejects a changed platform or video
identity. Every asynchronous subtitle stage is pinned to the snapshot video ID and rejects SPA
navigation. `seekTo` updates the active HTML video element and scrolls it into view. Navigation
subscription emits only when normalized watch-video identity changes; query-string changes unrelated
to `v` do not recreate the host.

### 4.5 MAIN-world execution boundary

Content code requests only allowlisted page operations through Background. Background validates a
top-frame sender on the matching `https://www.youtube.com/watch?v=...` tab, serializes operations by
`(tabId, documentId, videoId)`, and runs page functions with `chrome.scripting.executeScript` in the
MAIN world. Responses use a structured envelope:

```js
{ ok: true, data }
{ ok: false, errorCode, causeCode, stage }
```

Diagnostics never include transcript text, player payloads, signed URLs, PO tokens, cookies, or
headers. Chrome `InjectionResult.error` is handled explicitly rather than being mistaken for a null
result.

Functions passed through `executeScript({ func })` must remain self-contained after production
bundling. Babel's async-to-generator transform introduces bundle-local helpers that do not exist when
Chrome serializes a function into the page. Therefore `src/background/youtube-page-data.mjs` is
excluded from Babel transformation while retaining native async syntax supported by Chromium 116+.
A production Webpack regression test serializes and restores every injected function in an isolated
VM to catch future helper leakage.

### 4.6 Shared protocol and task ownership

Rename Bilibili-specific port names and constants to platform-neutral video-summary names. Every
content command carries `platform` and `videoId`; Background derives `tabId` and `documentId` from
`port.sender` and creates this owner:

```js
{
  tabId,
  documentId,
  platform,
  videoId,
}
```

Background and Offscreen validate both fields on start, attach, refresh, retry, cancellation, and
event routing. Source-refresh responses must match the complete owner identity. No DOM value,
function, `AbortSignal`, provider key, cookie, or raw player response crosses the boundary.

Existing task-runner, checkpoint, model gateway, MediaKit gateway, OPFS, result builder, Markdown,
and retry behavior remain shared. Generic pipeline errors use `VIDEO_*` names; extraction errors
remain site-prefixed and are translated at the UI boundary.

## 5. Adapter Integration and Fallback

Both site adapters evaluate the same capability gate:

1. build includes enhanced video summary;
2. manifest version is 3;
3. Offscreen API exists;
4. Chrome/Edge minimum version is at least 116;
5. `videoTranscriptionEnabled` is true.

When enabled on a valid page, the adapter mounts the shared host and bypasses `DecisionCard`. When
any gate fails, the adapter preserves the current legacy subtitle-summary implementation.

The YouTube enhanced host mounts in the visible watch-page secondary column. It waits for a stable
target, coalesces overlapping mount attempts, and recreates itself if YouTube replaces that node.
Subtitle discovery is automatic; users do not need to click CC or “内容转文字”. If an initial
snapshot completes before transcript controls render and contains zero tracks with `not-found` or
`unavailable`, the host retries once after one second. Disposal and video navigation cancel or
invalidate the retry. The host does not mount on Shorts, search, channel, embedded-player, or live
pages.

The build define is renamed from the Bilibili-specific name to a generic video-summary name while
retaining identical full/minimal package behavior. The full Chromium artifact continues to include
`VideoSummaryOffscreen.html` and `VideoSummaryOffscreen.js`; minimal builds continue to exclude
them.

## 6. Configuration Migration

Add `videoTranscriptionEnabled: false` to defaults and treat it as canonical. During config
normalization:

1. if `videoTranscriptionEnabled` is already a boolean, preserve it;
2. otherwise, if `bilibiliVideoTranscriptionEnabled` is a boolean, copy that value;
3. otherwise use the shared default;
4. persist the canonical field through the existing migration mechanism;
5. stop rendering or writing the legacy field after migration.

The popup replaces the Bilibili-only transcription settings block with a shared video-summary
settings block associated with both Bilibili and YouTube. MediaKit credentials, speaker detection,
and maximum output tokens remain shared. Disabling either site adapter still disables injection on
that site independently; the shared setting does not reactivate a disabled adapter.

## 7. Error Handling and Security

### 7.1 Actionable YouTube outcomes

The bridge distinguishes at least:

- invalid or changed watch-video identity;
- unavailable, private, restricted, or live content;
- malformed or missing player response;
- official transcript opener/panel timeout or empty panel;
- native-caption capture timeout or empty HTTP 200 response;
- Innertube transcript endpoint/request/parse failure;
- no usable subtitle tracks after all free fallbacks;
- page-script execution failure, reported only as safe `errorCode`, `causeCode`, and `stage`;
- no usable audio candidate;
- expired or rejected media source;
- missing player element for seeking.

The view maps expected failures to localized, actionable text. Unknown internal codes use a safe
generic message rather than exposing URLs, query parameters, player payloads, or provider data.

### 7.2 Sensitive data

- Never log watch HTML, player responses, caption contents, transcript text, signed URLs, cookies,
  task payloads, prompts, or credentials.
- Sanitize media URLs and gateway errors through existing redaction utilities.
- Keep MediaKit and model credentials in Background.
- Submit remote media only after explicit confirmation.
- Use only media and captions made available to the current page session.
- Preserve task-scoped OPFS cleanup on success, failure, cancellation, disconnect, and replacement.

## 8. Localization

English remains the source of truth. Add shared video-summary and YouTube-specific actionable error
strings to English, Simplified Chinese, and Traditional Chinese; other locales use English fallback.
Rename existing Bilibili-only generic strings where necessary without changing their meaning.
Platform product names remain `Bilibili` and `YouTube`.

## 9. Testing

### 9.1 YouTube unit tests

Add sanitized fixtures and tests for:

- watch URL and video-ID validation;
- bounded player-response extraction and identity mismatch rejection;
- authored versus automatic caption classification and ordering;
- preferred-language selection;
- timed-text parsing, entity decoding, repeated events, and timestamp preservation;
- audio candidate normalization, backup URLs, expiry, and request origin;
- unavailable/private/restricted/live statuses;
- official transcript-panel priority over all other sources;
- delayed/duplicate/localized transcript controls, including zero-layout-size `内容转文字` buttons;
- modern `PAmodern_transcript_view` and legacy searchable-transcript panel parsing;
- MutationObserver/poll cleanup, panel ownership, cue deduplication, and size/segment limits;
- exact native track capture through fetch/XHR plus CC/track restoration;
- Innertube `getTranscriptEndpoint.params` and continuation handling;
- HTTP 200 empty responses and allowlisted integrity/client parameter replay;
- structured page-data success/error envelopes and sanitized `InjectionResult.error` handling;
- production-bundle serialization of every MAIN-world function without Babel helper leakage;
- source refresh identity checks and rejection during every asynchronous fallback;
- SPA navigation deduplication, teardown, and bounded empty-snapshot retry;
- local seek behavior and missing-player errors.

Fixtures contain no live cookies, credentials, signed query values, or complete transcripts.

### 9.2 Shared unit tests

Generalize existing Bilibili host, view, width, port, contracts, router, task-runner, and error tests
to cover both platforms. Verify:

- ownership includes platform;
- subtitle track selection reaches `START_TASK`;
- ASR cannot start before confirmation;
- source refresh cannot cross platform/video owners;
- archive, export, follow-up, seek, retry, cancellation, and reattachment remain equivalent;
- Bilibili behavior and migration remain backward-compatible.

### 9.3 Integration tests

Extend fake end-to-end scenarios for YouTube:

1. authored subtitle to structured result;
2. automatic subtitle to structured result;
3. no subtitles, confirmed ASR, direct remote ingestion;
4. direct ingestion failure followed by OPFS upload fallback;
5. cancel and reconnect within the grace period;
6. expired source refresh;
7. summary failure followed by checkpoint-based retry;
8. navigation to another video without cross-routing events.

### 9.4 Validation

Run, in order:

```text
npm run pretty
npm run lint
npm test
npm run build
```

Inspect full Chromium output for the offscreen HTML/JS and standard artifacts. Confirm the minimal
Chromium output excludes the offscreen entry. Manual smoke testing loads the unpacked extension and covers one captioned YouTube watch video
whose official panel uses `PAmodern_transcript_view`, one authored/automatic track video, one video
requiring explicit ASR confirmation, Bilibili regression, SPA navigation, timestamp seeking,
cancellation, archive, export, and disabled/fallback behavior. Verify that subtitle discovery opens
and reads the transcript panel automatically without user interaction.

## 10. Acceptance Criteria

The feature is complete when:

- a supported YouTube watch page exposes the same enhanced panel and actions as Bilibili;
- users can select authored or automatic captions and receive timestamp-anchored structured output;
- videos without captions offer ASR only after explicit confirmation;
- shared tasks cannot cross site, tab, document, or video ownership boundaries;
- changing YouTube videos disposes or reattaches tasks without stale UI events;
- the legacy Bilibili setting migrates without changing the user's enabled state;
- unsupported browsers/builds/pages and disabled settings retain the legacy path;
- Bilibili's existing enhanced workflow has no functional regression;
- automated formatting, lint, tests, and production build pass;
- no sensitive media, transcript, prompt, URL-query, cookie, or credential data is logged.
