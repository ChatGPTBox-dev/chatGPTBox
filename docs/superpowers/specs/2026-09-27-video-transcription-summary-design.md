# Bilibili Video Transcription and Structured Summary Design

**Date:** 2026-09-27

**Status:** Needs review

**Initial platform:** Full Chromium build, Chrome and Edge 116+

**Initial ASR provider:** Volcengine AI MediaKit

## 1. Purpose

Add an explicitly invoked workflow for Bilibili videos that produces:

1. a whole-video summary and key points;
2. semantic chapters and key moments with clickable source-derived timestamps;
3. a collapsible timestamped transcript with automatic speaker labels when available.

The user chooses either an existing Bilibili subtitle track or speech recognition. Both choices
feed a common transcript and summary pipeline in the full Chromium build.

## 2. Scope

### 2.1 Initial release

- Bilibili ordinary on-demand videos only.
- Chrome and Edge 116 or newer.
- Full `build/chromium` distribution only.
- Volcengine AI MediaKit ASR with a user-provided API key.
- Existing OpenAI-compatible API model modes for hidden summary generation.
- Maximum video duration of three hours, matching the documented MediaKit ASR limit.
- Automatic source-language detection and speaker identification.
- Transcript in the source language; summary output in ChatGPTBox's preferred language.
- Page-bound, non-persistent tasks and results.

### 2.2 Explicitly deferred

- YouTube support.
- Firefox and Safari ASR support.
- The `chromium-without-katex-and-tiktoken` build.
- Live streams, DRM bypasses, paid-content protection bypasses, private media bypasses, and region
  restriction bypasses.
- Browser-local Whisper.
- A project-operated media backend.
- Web-login model modes and non-OpenAI-compatible dedicated API modes for hidden summaries.
- Persistent jobs, background completion notifications, and crash recovery.
- Transcript embedding or semantic retrieval for follow-up questions.

Firefox, Safari, the minimal Chromium build, and unsupported pages retain the existing subtitle
summary implementation unchanged.

## 3. Delivery Gate: Bilibili Media Feasibility Spike

Media extraction is the primary feasibility risk and must be validated before production UI or
the end-to-end feature is implemented.

The spike uses public and normally accessible logged-in Bilibili videos to determine:

- how to obtain DASH audio candidates and backup URLs from the current page/API context;
- whether candidate URLs require browser cookies, Referer, User-Agent, or other local-only state;
- whether URLs are short-lived and how their expiry can be derived or observed;
- whether byte ranges and `Content-Length` are consistently available;
- whether AI MediaKit can fetch a Bilibili CDN URL from its own network;
- whether a locally downloaded Bilibili audio object is accepted by the MediaKit upload and ASR
  path without remuxing;
- whether FFmpeg remuxing or transcoding is actually necessary;
- realistic OPFS space requirements and failure behavior for long audio.

The spike produces captured response shapes, fixture samples with credentials and signed values
removed, compatibility results, and a written go/no-go conclusion. It does not ship user-facing
ASR functionality.

If neither direct MediaKit fetching nor local download plus MediaKit upload is reliable, work
stops after the spike and the result is reported. The initial release does not fall back to tab
recording, local file selection, or a backend service.

Only transport paths proven by the spike enter the implementation plan. FFmpeg is included only
if the spike demonstrates that MediaKit rejects the source container or codec.

## 4. Product Decisions

- Processing covers the complete video without requiring real-time playback.
- The user must explicitly select and confirm speech recognition before any paid or upload call.
- If native subtitles exist, the user may still choose ASR.
- If native subtitles do not exist, that choice is disabled with an explanation.
- The current chat model is used for summaries only when `ModelGateway` reports support.
- If the current model is unsupported, ASR still completes and shows the transcript; after the
  user selects a supported model, “retry summary” resumes without another ASR task.
- Audio, transcript, chapters, and summaries are not automatically persisted.
- Existing explicit archive and Markdown download actions remain the retention mechanisms.
- Closing, reloading, navigating, switching video, or disconnecting the page cancels local work.
- Cancellation cannot guarantee cancellation of an ASR job already accepted by MediaKit and may
  not prevent remote charges; the UI discloses this before submission.

## 5. Architecture and Cohesive Modules

The initial release has five primary module boundaries.

### 5.1 `VideoPageBridge` — content script

This is the only module that reads Bilibili page state or controls the player. It:

- determines the current stable Bilibili video identity, including page number;
- loads native subtitle tracks;
- produces a serializable source snapshot and local fetch recipe;
- refreshes expired media candidates on request;
- seeks the current player to a requested timestamp;
- detects SPA video changes and document teardown.

Keeping source extraction and `seekTo` in the same module is intentional: both are operations on
the same page-owned integration boundary. No adapter object or function crosses an extension
message boundary.

### 5.2 `VideoTaskRunner` — Offscreen Document

The runner owns the ephemeral state machine, polling schedule, summary checkpoints, and task-local
abort controllers. It accepts serializable commands and emits serializable task events. It never
receives provider secrets.

Only one active task is allowed per owner document. A replacement task first cancels the previous
one and completes local cleanup.

### 5.3 `MediaPipeline` — Offscreen Document

The pipeline executes a source recipe proven by the feasibility spike. It:

- downloads media into a task-scoped OPFS directory;
- checks available quota before starting a local transfer;
- tracks byte-based progress when total size is known;
- uses MediaKit signed upload URLs obtained through Background;
- optionally loads packaged FFmpeg WASM only when the spike proves it necessary;
- deletes task-local files and terminates workers on every normal terminal path.

### 5.4 `MediaKitGateway` and `ModelGateway` — Background

These are narrow privileged gateways rather than general-purpose fetch proxies.

`MediaKitGateway` validates operation names and payloads, reads the MediaKit key, obtains upload
credentials, submits ASR tasks, and queries task state.

`ModelGateway` resolves the frozen model identity to an approved API implementation, executes an
independent stateless generation, and returns text or a structured error. It does not expose a
mutable `Session`, provider secret, or raw runtime `Port` to the caller.

### 5.5 `VideoSummaryView` — content script

The view renders state and sends commands. It does not perform media, provider, or model work. It
contains:

- native-subtitle versus ASR selection;
- real stage/progress display and cancellation;
- summary, key points, chapters, and key moments;
- collapsible transcript with speaker labels;
- local timestamp seeking;
- explicit archive, Markdown export, and summary-only retry actions.

## 6. Extension Context and Message Protocol

All cross-context contracts contain structured-clone-compatible data only. They never contain
functions, callbacks, `AbortSignal`, DOM nodes, adapter instances, or provider keys.

### 6.1 Ownership

Every task is identified by:

```js
{
  taskId,
  owner: {
    tabId,
    documentId,
    videoId,
  },
}
```

The content script supplies `taskId` and `videoId`. Background derives `tabId` and `documentId`
from `port.sender`; it never trusts caller-supplied owner fields.

### 6.2 Content-to-Background port

The content script opens a named long-lived port for one video-summary view. Commands are:

```text
START_TASK
ATTACH_TASK
CANCEL_TASK
RETRY_TASK
SOURCE_REFRESH_RESULT
```

Background replies with:

```text
TASK_EVENT
SOURCE_REFRESH_REQUEST
```

Seeking stays local: the view calls `VideoPageBridge.seekTo()` without routing through Offscreen.

### 6.3 Background-to-Offscreen protocol

Background forwards validated commands after stamping the owner. Offscreen emits progress,
checkpoint, result, warning, and terminal events containing both `taskId` and owner. Background
routes an event only to the still-connected matching owner port.

Each context maintains its own `AbortController` registry keyed by `taskId`. A `CANCEL_TASK`
message aborts local work in every context; an `AbortSignal` itself is never serialized.

### 6.4 Start payload

```js
{
  type: 'START_TASK',
  taskId,
  videoId,
  sourceChoice: 'native-subtitle' | 'asr',
  sourceSnapshot,
  settingsSnapshot: {
    preferredLanguage,
    speakerIdentification: true,
  },
}
```

The model snapshot is resolved and attached inside Background so model credentials never enter the
content or Offscreen payload.

If the service worker restarts, the content script reconnects its named port and sends
`ATTACH_TASK` with the current `taskId` and `videoId`. Background stamps the new sender identity,
asks Offscreen whether the task still exists for that exact owner, and rebuilds the route only on
an exact match. A failed attachment cancels the local view rather than adopting another task.

## 7. Offscreen Document Management

The full Chromium build declares the `offscreen` permission and requires Chrome/Edge 116+.

Background owns `ensureOffscreenDocument()` with a shared in-flight creation promise. It uses
`runtime.getContexts()` to detect the singleton before calling `offscreen.createDocument()`. The
document declares the `BLOBS` and `WORKERS` reasons with a justification that it processes
user-requested media using OPFS and a packaged worker.

Offscreen creation, closure, and restart are explicit lifecycle events. On startup, the Offscreen
Document deletes every directory under its dedicated `video-summary-tasks/` OPFS namespace before
accepting new work. Any such directory is an orphan because tasks are intentionally not restored
after an extension or Offscreen restart.

## 8. Owner Lifecycle and Cancellation

Background maintains only a lightweight in-memory route:

```text
(tabId, documentId, videoId) -> (taskId, contentPort)
```

It is not the long-running task state. Cancellation is triggered by:

- the named content port disconnecting;
- `tabs.onRemoved` for the owning tab;
- a new document replacing the owning `documentId`;
- a Bilibili SPA video-identity change reported by `VideoPageBridge`;
- an explicit user command;
- replacement by a new task for the same owner.

Background sends cancellation to Offscreen and removes the route. Offscreen ignores every later
event from a cancelled or superseded task. The view likewise accepts events only when `taskId`,
`documentId`, and `videoId` match its current owner.

While a task is active, Offscreen performs a lightweight owner check through Background every ten
seconds. A missing route starts a fifteen-second reattachment grace period to allow service-worker
restart and content-port reconnection. If no exact `ATTACH_TASK` arrives before the grace period
ends, Offscreen cancels the task and cleans its temporary files.

Normal cancellation runs cleanup immediately. Browser or renderer crashes may skip `finally`;
startup orphan cleanup is the recovery mechanism for those paths.

## 9. Serializable Media Source Contract

`VideoPageBridge` produces distinct remote and local representations:

```js
{
  platform: 'bilibili',
  videoId,
  pageId,
  title,
  durationMs,
  nativeSubtitleTracks,
  mediaCandidates: [{
    id,
    mediaMetadata: {
      kind: 'audio' | 'video',
      container,
      codec,
      contentLength,
      durationMs,
    },
    remoteReference: {
      url,
      expiresAt,
    } | null,
    localFetchRecipe: {
      primaryUrl,
      backupUrls,
      expiresAt,
      credentialMode,
      rangeSupported,
      requiredRequestOrigin,
    },
  }],
}
```

`remoteReference` contains only a URL that is safe to give MediaKit. It never contains Cookie,
Referer, Authorization, or other browser credentials. `localFetchRecipe` is never submitted to
MediaKit and contains no raw cookie value; it describes how a trusted extension context performs
the local request.

If a candidate expires, Offscreen requests a fresh snapshot from the still-connected
`VideoPageBridge`. Background verifies the returned video identity before forwarding it.

## 10. AI MediaKit Provider Contract

The provider uses:

- `POST https://mediakit.cn-beijing.volces.com/api/v1/tools/asr-subtitles`;
- `GET https://mediakit.cn-beijing.volces.com/api/v1/tasks/{task_id}`;
- `Authorization: Bearer {MediaKit_API_Key}`;
- `video_url` or `audio_url` for a proven direct path;
- `mediakit://{file_id}` after the documented signed-upload flow.

Submission enables automatic language detection, `enable_speaker_info`, and
`enable_confidence`. A single logical submission receives one generated `clientToken`, reused for
every safe retry of that logical operation. An explicit user restart generates a new token.

The normalized transcription is:

```js
{
  durationMs,
  detectedLanguage: string | null,
  segments: [{
    id,
    startMs,
    endMs,
    text,
    speaker: string | null,
    confidence: number | null,
  }],
}
```

`detectedLanguage` is optional because the documented result does not guarantee it.

## 11. Operation-Specific Retry Semantics

Retries are defined per operation rather than by HTTP status alone.

| Operation | Retry behavior |
|---|---|
| Query task GET | Honor `Retry-After`; otherwise jittered exponential delay from 5 to 30 seconds; stop after five consecutive transport/server failures or the two-hour task deadline |
| Refresh Bilibili source | Re-resolve once and only while owner identity still matches |
| Request upload URL | Retry once after a confirmed 429/5xx response; ambiguous network failure creates a new upload session but never an ASR task |
| Media PUT | Retry the complete upload once only when the signed URL is still valid; never claim resume support |
| Create ASR POST | Reuse the same `clientToken`; retry once after a confirmed 429/5xx or one ambiguous transport failure |
| Create ASR remains ambiguous | Enter `submission-unknown`; explain possible remote creation/charge and require explicit user action |
| Hidden model generation | Retry a failed chunk at most twice for confirmed transient failures; ambiguous paid requests are surfaced rather than silently repeated |
| JSON repair | One explicit repair request, reported as another model call |

No operation is described as exactly once. Local fallback is at-most-once per task, while remote
deduplication depends on MediaKit's documented `clientToken` behavior.

## 12. `ModelGateway`

The gateway contract is:

```js
describeCapabilities(modelIdentity)
generate({
  requestId,
  taskId,
  modelSnapshot,
  messages,
  maxOutputTokens,
  outputContract,
})
cancel({ requestId, taskId })
```

`modelSnapshot` is immutable and contains resolved provider/model/endpoint/settings identity but no
secret. Background resolves the relevant secret internally.

Initial support is limited to model modes backed by the existing OpenAI-compatible core. Web
modes, Bing foreground execution, Anthropic's dedicated API, Azure's dedicated API, and
Waylaidwanderer are reported as unsupported for hidden summaries until adapted and tested.

Every generation:

- has an independent correlation ID and abort controller;
- executes serially per video task;
- has no local or remote conversation history;
- cannot mutate a user-facing `Session`;
- returns plain text or a structured error;
- logs metadata only, never messages, prompts, answers, transcript, or provider secrets.

The gateway does not pass video-summary prompts through the current
`registerPortListener()` path, whose raw-message logging and latest-request-wins semantics are not
suitable for internal work.

## 13. Token-Bounded Hierarchical Summary

### 13.1 Input budget

`describeCapabilities()` returns a summary input budget. Known built-in models use explicit
capability metadata. Custom or unknown OpenAI-compatible models use a conservative 4,000-token
input budget.

For internal summaries, output tokens are capped at the lesser of the user's configured maximum
and 2,000. Prompt instructions and output reserve are subtracted before transcript packing.
Token estimates use the packaged encoder in the full Chromium build. A context-limit error causes
the failed primary range to be split in half and retried, down to a minimum of five transcript
segments; it does not increase the advertised model capacity.

### 13.2 Primary and overlap ranges

Each chunk has:

```js
{
  primarySegmentIds,
  contextBeforeSegmentIds,
  contextAfterSegmentIds,
}
```

At most two neighboring segments are included on each side. Prompts explicitly forbid emitting
chapters, key moments, or key points for overlap-only segments. Output outside the primary range is
discarded in code.

### 13.3 Local extraction

Each successful chunk returns:

```js
{
  primaryStartSegmentId,
  primaryEndSegmentId,
  localSummary,
  chapterStarts: [{ segmentId, title, summary }],
  keyMoments: [{ segmentId, point }],
  keyPoints,
}
```

Failed primary ranges are retained as explicit checkpoints and coverage gaps.

### 13.4 Final synthesis and deterministic chapters

The final model sees successful local summaries and candidates, not the full transcript. It
returns ordered chapter start segment IDs, titles, summaries, key points, and key moments.

Code constructs deterministic chapter ranges:

1. discard unknown or failed-range segment IDs;
2. sort and deduplicate chapter starts by transcript order;
3. set each chapter end to the segment immediately before the next valid start;
4. set the last chapter end to the last successfully covered segment;
5. attach leading covered segments to the first chapter;
6. keep failed ranges out of chapter coverage and expose them as warnings;
7. if no valid chapter start remains, create one code-generated fallback chapter for all covered
   segments.

Key moments are deduplicated by segment ID and always map to source timestamps. The model never
supplies free-form time values.

### 13.5 Parse fallback

One failed JSON parse triggers one explicit repair request. If repair fails, successful local
summaries become a degraded Markdown overview. The transcript and all valid checkpoints remain
available.

## 14. Result and Checkpoint Contracts

```js
{
  status: 'complete' | 'partial' | 'degraded',
  title,
  overview,
  keyPoints,
  keyMoments: [{ segmentId, startMs, point }],
  chapters: [{ startSegmentId, endSegmentId, startMs, endMs, title, summary }],
  transcriptSegments,
  coverage: {
    coveredDurationMs,
    totalDurationMs,
    ratio,
  },
  warnings,
  failedRanges: [{ startSegmentId, endSegmentId, reason }],
}
```

The Offscreen task also retains an internal in-memory checkpoint:

```js
{
  transcription,
  successfulChunkResults,
  failedRanges,
  synthesisResult,
}
```

`VideoTaskRunner.retry(taskId, { fromStage })` initially accepts `summarizing` or `synthesis`.
These retries reuse the transcription and never create another MediaKit task. Retrying ASR is a
new explicitly confirmed task with a new `clientToken`.

## 15. Task State Machine

```text
idle
  -> resolving-source
  -> awaiting-user-choice
  -> loading-native-subtitles
     OR
     -> submitting-url
        -> transcribing
        -> downloading
        -> preparing-media
        -> uploading
        -> submitting-upload
        -> transcribing
  -> summarizing-chunks
  -> synthesizing-summary
  -> complete | partial | degraded

Any active state -> cancelling -> cancelled
Ambiguous ASR submission -> submission-unknown
Any unrecoverable error -> failed
```

Only transitions listed in a tested transition table are accepted. Task events include task ID,
owner, stage, progress kind, checkpoint availability, warnings, and a redacted error.

## 16. UI Behavior

- Show native subtitle and speech-recognition choices before processing.
- Display actual byte progress for known-length transfers.
- Display queue/processing state rather than invented percentages for MediaKit.
- Display completed chunk count during summary generation.
- Keep cancellation available during every active local stage.
- Show summary, key points, chapters, and key moments above a collapsed transcript.
- Clicking any valid timestamp seeks through `VideoPageBridge` and scrolls to the player.
- Mark partial/degraded output visibly and list uncovered transcript ranges.
- Allow summary-only retry when a transcription checkpoint exists.
- Allow explicit archive by serializing metadata, result, timeline, and transcript into one
  Markdown answer in a normal saved session.
- Allow Markdown download without persistence.
- “Ask about this video” starts a normal conversation with overview, key points, and chapter
  summaries only. Full transcript retrieval is deferred.

## 17. Storage and Credential Boundary

### 17.1 MediaKit key

The user selected the repository's existing `storage.local` BYOK risk model.

- Store `mediaKitApiKey` as a separate key.
- Do not add it to `defaultConfig`, `UserConfig`, `providerSecrets`, or generic config DTOs.
- Popup sets, replaces, and deletes it through `MediaKitGateway` messages.
- Production code reads it only inside `MediaKitGateway`.
- Never place it in content, Offscreen, task, or model messages.
- Existing full-config export includes it in plaintext. The export action must warn that the file
  contains API credentials; import may restore it.

This is a code-level boundary, not browser-enforced isolation: a trusted content script with the
`storage` API could intentionally read the key. The specification does not claim otherwise.

### 17.2 Temporary and final data

- Final transcript and summary stay in task/view memory.
- No automatic write is made to `Browser.storage.local.sessions`.
- OPFS media is task-scoped and deleted on terminal paths or next Offscreen startup.
- Object URLs are revoked and FFmpeg workers are terminated.
- Media uploaded to MediaKit may remain according to provider retention policy; disclose this
  before first ASR confirmation.

## 18. Logging Requirements

No new video path may log raw runtime messages, source URLs with signatures, upload URLs,
transcript content, summary prompts, model answers, or credentials.

- Log only task/correlation IDs, stage, duration, byte counts, HTTP status, provider request ID,
  and redacted error category.
- Apply redaction before every logging call.
- `MediaKitGateway` and `ModelGateway` use their own narrow handlers and do not use the raw logging
  in `registerPortListener()`.
- Supporting a future model implementation requires auditing its internal logs first.

## 19. Error and Degradation Rules

| Failure | Result |
|---|---|
| Video exceeds three hours | Reject before paid submission |
| Unsupported/live/DRM source | Stop; do not attempt bypass |
| Media feasibility gate fails | Do not ship the ASR entry |
| Source expires | Request one identity-checked refresh |
| OPFS quota is insufficient | Stop before full download and explain required/available space |
| MediaKit cannot download a proven direct URL | Use the spike-approved upload path once |
| Unsupported source format | Use FFmpeg only if the spike approved that fallback |
| Invalid key or permission | Do not retry; link to settings |
| ASR submission is ambiguous | Enter `submission-unknown`; never silently create a new token |
| ASR succeeds and model is unsupported | Show transcript and offer summary after model switch |
| One chunk remains failed | Return `partial` with coverage and failed range |
| Final structure cannot be repaired | Return `degraded` with local summaries |
| Owner disappears | Cancel local work, suppress events, and clean temporary state |

## 20. Build and Feature Gating

- Set Chromium minimum version to 116.
- Add the `offscreen` permission only to the full Chromium manifest output.
- Add an Offscreen entry and FFmpeg assets only to the full Chromium output.
- Introduce a compile-time video-transcription capability flag for the full build.
- The minimal Chromium build omits the permission, entry, FFmpeg assets, settings, and runtime UI.
- Firefox and Safari do not expose the new UI and keep the legacy subtitle adapter path.
- Package all executable/WASM assets with the extension; do not load remote code.
- Keep FFmpeg out of `shared.js`, content-script, popup, and existing page bundles.

The current build reuses one compiled full bundle for Chromium and Firefox, so runtime capability
gating remains necessary in shared source. Output copying and generated manifest selection ensure
unsupported artifacts and permissions are absent from Firefox and minimal Chromium packages.

## 21. Configuration

The full Chromium settings UI adds:

- enable/disable Bilibili video transcription;
- MediaKit API key set/replace/delete controls;
- automatic speaker identification, enabled by default;
- plaintext-export warning;
- provider upload/retention and cancellation-cost notice.

There is no “validate key” action because the chosen MediaKit contract does not document a
non-billable validation endpoint. Validation occurs during the first explicitly confirmed task.

There is no separate summary-model selector. The current model is capability-checked at summary
time.

## 22. Testing

### 22.1 Feasibility evidence

- public and logged-in Bilibili media source fixtures with secrets removed;
- direct MediaKit fetch matrix;
- local download and upload matrix;
- container/codec and FFmpeg requirement matrix;
- URL expiry, Range, content length, and OPFS quota observations;
- documented go/no-go conclusion before feature implementation.

### 22.2 Unit tests

- source snapshot serialization and strict remote/local separation;
- owner stamping from `port.sender` and rejection of spoofed identity;
- message schema validation and routing;
- service-worker restart, exact owner reattachment, and attachment grace timeout;
- task transition table, replacement, cancellation, and stale-event suppression;
- Offscreen singleton creation and orphan cleanup;
- operation-specific retries, stable `clientToken`, `Retry-After`, and `submission-unknown`;
- MediaKit response/error normalization and optional detected language;
- speaker/confidence and seconds-to-milliseconds mapping;
- token-budget chunking, primary/overlap enforcement, and recursive split;
- deterministic chapter construction and failed-range coverage;
- complete, partial, degraded, and summary-retry contracts;
- ModelGateway support detection, immutable snapshots, serialization, and cancellation;
- key omission from DTOs/messages and content-aware log redaction;
- OPFS cleanup and absence of automatic session persistence.

### 22.3 Integration tests with fakes

1. Native Bilibili subtitles produce a structured result without ASR.
2. A proven direct reference completes MediaKit ASR.
3. A MediaKit download failure follows the spike-approved upload path once.
4. FFmpeg loads only if the spike established a required conversion.
5. Content port disconnect and `tabs.onRemoved` cancel the matching Offscreen task.
6. A new document/video cannot receive an old task event.
7. A service-worker restart preserves the Offscreen-owned task only when the same document sends
   `ATTACH_TASK` within the grace period; otherwise it cancels the orphan.
8. ASR succeeds with an unsupported model, then summary-only retry succeeds after model switch.
9. A failed chunk returns partial output without another ASR call.
10. An ambiguous ASR response never creates a new logical submission automatically.

### 22.4 Manual Chromium checks

- Chrome and Edge 116+;
- public and normally accessible logged-in Bilibili videos;
- native subtitle and ASR choices;
- proven direct/upload/FFmpeg paths from the feasibility matrix;
- timestamp seeking and speaker labels;
- cancellation, refresh, tab close, SPA video switch, and extension reload;
- OPFS cleanup, UI responsiveness, task suppression, and logs;
- unsupported summary-model degradation and summary-only retry;
- credential warning during full-config export;
- absence of feature UI and assets in minimal Chromium, Firefox, and Safari outputs.

### 22.5 Repository validation

Runtime and manifest changes require:

- `npm run pretty`
- `npm run lint`
- `npm test`
- `npm run build`
- expected artifact checks for all four browser variants
- manual Chrome and Edge extension smoke tests

## 23. Acceptance Criteria

- The media feasibility spike reaches a documented go decision before implementation proceeds.
- No ASR charge starts without explicit confirmation.
- A supported Bilibili video up to three hours produces timestamped transcript segments with
  automatic speaker labels through AI MediaKit.
- Native subtitles and ASR use the same structured pipeline in full Chromium only.
- Every task is owned by `tabId + documentId + videoId`; owner loss cancels local work.
- A service-worker restart can rebuild routing only through exact, time-bounded owner attachment.
- Only serializable messages cross extension contexts.
- No MediaKit key enters generic configuration DTOs or cross-context messages.
- ASR submission retries reuse one `clientToken`; unknown submission state is visible.
- Unsupported summary models preserve the transcript and permit summary-only retry after switch.
- Output explicitly distinguishes complete, partial, and degraded results.
- Chapter and key-moment timestamps always derive from validated transcript segment IDs.
- No audio, transcript, or summary is automatically persisted.
- Temporary OPFS data is cleaned on terminal paths and on the next Offscreen startup after a
  crash.
- The minimal Chromium, Firefox, and Safari artifacts retain their old behavior and do not contain
  the new permission, UI, or FFmpeg assets.

## 24. Alternatives Considered

### YouTube in the initial release

Deferred because signature cipher and `n` transformation, stream separation, and CDN restrictions
would make the first feasibility gate substantially larger. Its future implementation uses the
same message and normalized source contracts.

### Direct CDN URL only

Rejected as a general promise because Bilibili media URLs may be short-lived or require local
request context. It remains only if the feasibility spike proves it reliable for the supported
sample set.

### Self-hosted media backend

Deferred because it adds deployment, authentication, bandwidth, storage, and operational costs.
The gateways permit a later server transport without changing the view or transcript model.

### Doubao Voice Minutes

Deferred despite native chapters and summaries because it accepts only a server-downloadable
`FileURL` and provides no documented upload path or custom source headers. It cannot reliably
consume protected Bilibili CDN references without a media backend.

### Browser-local Whisper or tab recording

Deferred because model size, compute use, playback-time latency, and cross-browser behavior conflict
with the chosen first-release scope.

### Background-only credential storage

Rejected by product choice. A Background-owned IndexedDB would provide a stronger code boundary
but would not participate in existing config import/export. The selected `storage.local` design
matches current BYOK behavior and explicitly documents its plaintext and access limitations.

## 25. Official References

- [AI MediaKit speech-to-subtitle ASR](https://docs.volcengine.com/docs/Intelligentprocessing/VoicetoSubtitleASR?lang=zh)
- [Submit speech-to-subtitle task](https://docs.volcengine.com/docs/Intelligentprocessing/Submitspeech-to-subtitleASRtaskAPI?lang=zh)
- [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Chrome Runtime API](https://developer.chrome.com/docs/extensions/reference/api/runtime)
- [Doubao Voice Minutes API](https://docs.volcengine.com/docs/DoubaoVoice/DoubaoVoiceMinutes-APIAccessDocumentation?lang=zh)
