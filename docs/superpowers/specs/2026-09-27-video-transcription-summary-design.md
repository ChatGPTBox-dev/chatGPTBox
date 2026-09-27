# Video Transcription and Structured Summary Design

**Date:** 2026-09-27

**Status:** Approved design

**Initial platform:** Chromium (Chrome and Edge)

**Initial ASR provider:** Volcengine AI MediaKit

## 1. Purpose

Extend the existing YouTube and Bilibili integrations so videos without usable subtitles can
still produce a structured summary. Users may explicitly choose either an available platform
subtitle track or speech recognition. Both paths produce the same three-layer result:

1. a whole-video summary and key points;
2. semantic chapters and key moments with clickable timestamps;
3. a collapsible, timestamped transcript with automatic speaker labels when available.

The feature processes the entire video without requiring real-time playback. It is scoped to
ordinary on-demand videos that the current browser profile can play. Live streams, DRM-protected
media, paid-content protection bypasses, private media that cannot be fetched normally, and
region-restriction bypasses are out of scope.

## 2. Confirmed Product Decisions

- Processing is whole-video rather than playback-time recording.
- The first release supports Chromium only. Firefox and Safari retain clean extension points but
  do not expose the feature.
- The first ASR implementation uses Volcengine AI MediaKit. The ASR layer remains provider-based
  so later providers do not change video-source or summary logic.
- Users provide their own MediaKit API key. No shared credential is embedded in the extension.
- The maximum supported duration is three hours, matching the documented MediaKit ASR limit.
- Users choose between existing subtitles and speech recognition for each run. If no subtitle is
  available, that choice is disabled with an explanation.
- Speech recognition uses automatic language detection and automatic speaker identification.
- The transcript remains in the detected source language. Chapters, key points, and the final
  summary use ChatGPTBox's current preferred language.
- Summary generation reuses the currently selected ChatGPTBox chat model.
- Results and media are not automatically persisted. Existing explicit archive and Markdown
  download actions remain the way to retain results.
- Closing the tab, navigating away, or switching to another video cancels local processing and
  cleans up temporary resources.
- FFmpeg WASM may be bundled, but it is loaded only when the extracted media is not accepted by
  MediaKit or an audio-only conversion is needed.

## 3. Existing Behavior Being Preserved

The current YouTube and Bilibili adapters obtain platform subtitles and turn all subtitle text
into one prompt for `ConversationCard`. The resulting page card is ephemeral. It is saved only
when the user explicitly archives it to the independent conversation page or downloads it.

The new workflow keeps this persistence behavior. It changes the video adapters so both native
subtitles and ASR results become canonical timestamped transcript segments before summarization.
This gives both choices the same output UI and avoids maintaining two unrelated summary paths.

## 4. Architecture

```text
Video page
  -> VideoSourceAdapter (YouTube or Bilibili)
  -> user selects native subtitles or speech recognition
  -> VideoTaskCoordinator in an Offscreen Document
       -> native subtitle loader
       OR
       -> direct media URL submission to AI MediaKit
            -> success: poll ASR task
            -> MediaKit download failure:
                 download to temporary OPFS storage
                 optionally normalize with FFmpeg WASM
                 request MediaKit signed upload URL through background
                 PUT media to signed URL
                 submit mediakit:// file reference
       -> normalize transcript segments
       -> hidden chunk summaries through the existing model router
       -> final summary synthesis
  -> VideoSummaryCard in the content script
```

### 4.1 MV3 responsibility split

The logical long-running task must not live only in the MV3 background service worker because
Chrome may suspend it. Responsibilities are therefore split as follows:

- **Content script:** mounts the UI, knows the current page/video identity, receives progress and
  result events, performs timestamp seeking, and issues cancellation.
- **Offscreen Document:** owns the ephemeral task state, polling timers, OPFS files, media
  preparation, and multi-step summary orchestration.
- **Background service worker:** is a stateless privileged broker. It reads the MediaKit API key,
  performs authenticated MediaKit requests, obtains signed upload URLs, and routes hidden model
  requests through the existing API machinery.

The service worker may be suspended between messages without losing the task. If the Offscreen
Document itself disappears, the task fails; the initial release does not persist or recover it.

## 5. Components and Interfaces

### 5.1 `VideoSourceAdapter`

Each supported platform implements a common interface:

```js
getVideoIdentity()
getMetadata(signal)
listSubtitleTracks(signal)
loadSubtitleTrack(track, signal)
resolveMediaCandidates(signal)
seekTo(startMs)
subscribeToVideoChange(listener)
```

The normalized source contains platform, stable video ID, title, duration, page URL, subtitle
tracks, and candidate audio/video streams with format and size information when available.

YouTube and Bilibili parsing stays platform-specific. No platform-specific response object may
cross into the ASR or summary modules.

### 5.2 `VideoTaskCoordinator`

The coordinator is implemented in the Offscreen Document and accepts one active task per tab.
A new task for the same tab cancels the previous task.

```js
start(taskRequest)
cancel(taskId, reason)
getState(taskId)
subscribe(taskId, listener)
```

It snapshots the selected chat model, preferred language, and summary settings at task start so
mid-task configuration changes cannot mix providers or output languages.

### 5.3 `MediaWorker`

The media worker:

- probes and downloads candidate streams;
- streams downloads into a task-scoped OPFS directory rather than retaining a complete Blob;
- uploads files using short-lived MediaKit signed URLs obtained by background;
- loads FFmpeg WASM only when the input cannot be submitted or uploaded as-is;
- reports byte-based progress for downloads and uploads;
- deletes every task-scoped file on completion, failure, or cancellation.

MediaKit credentials never enter this component.

### 5.4 `TranscriptionProvider`

The provider contract supports asynchronous and future immediate-response providers:

```js
prepareRemoteInput(source, signal)
submit(inputReference, options, signal)
poll(taskId, signal)
normalizeResult(rawResult)
classifyError(error)
```

The canonical result is:

```js
{
  durationMs,
  detectedLanguage,
  segments: [
    {
      id,
      startMs,
      endMs,
      text,
      speaker,
      confidence,
    },
  ],
}
```

### 5.5 `VolcengineMediaKitProvider`

The initial provider uses:

- `POST https://mediakit.cn-beijing.volces.com/api/v1/tools/asr-subtitles` to submit;
- `GET https://mediakit.cn-beijing.volces.com/api/v1/tasks/{task_id}` to query;
- `Authorization: Bearer {MediaKit_API_Key}`;
- `video_url` or `audio_url` for direct input;
- `mediakit://{file_id}` after the documented signed-upload flow.

Submission enables automatic language detection, `enable_speaker_info`, and `enable_confidence`.
The provider maps `subtitle_text`, seconds-based timestamps, speaker, and confidence into the
canonical transcript model.

The direct candidate URL is tried first. If the task fails with a MediaKit source-download error,
the coordinator performs exactly one fallback through local download and MediaKit upload. Other
permanent failures do not trigger a media re-upload.

### 5.6 `VideoSummaryOrchestrator`

The orchestrator calls the existing ChatGPTBox model router through ephemeral internal sessions.
Intermediate prompts and answers are not appended to user conversation history.

It provides:

```js
summarizeTranscript(transcription, modelSnapshot, preferredLanguage, signal)
```

and returns:

```js
{
  title,
  overview,
  keyPoints,
  chapters: [
    { startMs, endMs, title, summary },
  ],
}
```

### 5.7 `VideoSummaryCard`

This is a dedicated structured component rather than another generic assistant message. It owns:

- source-selection controls;
- processing stage and progress UI;
- cancellation and stage-specific retry actions;
- whole-video summary and key points;
- clickable chapter and key-moment timeline;
- collapsible timestamped transcript;
- explicit archive, Markdown download, and follow-up conversation actions.

Clicking a timestamp invokes the active platform adapter's `seekTo()` method and scrolls the
current player into view.

## 6. User Flow

1. The video adapter detects the current YouTube or Bilibili on-demand video.
2. The card shows the video title and available source choices.
3. The user chooses native subtitles or speech recognition and confirms.
4. Native subtitles are loaded immediately, or a MediaKit task is started.
5. The card reports real stage information:
   - analyzing video;
   - downloading media;
   - preparing audio;
   - uploading media;
   - queued/transcribing;
   - summarizing chunk N of M;
   - synthesizing final summary.
6. The completed card shows the summary, timeline, and collapsed transcript.
7. The user may seek the video, ask a follow-up, archive the result, or download Markdown.

The UI does not invent percentages for MediaKit processing because its API does not expose an
exact completion percentage. Download/upload use byte-based progress and summary generation uses
completed-chunk counts.

## 7. Task State Machine

```text
idle
  -> resolving-source
  -> awaiting-user-choice
  -> loading-native-subtitles
     OR
     submitting-url
       -> transcribing
       -> downloading
       -> preparing-media
       -> uploading
       -> submitting-upload
       -> transcribing
  -> summarizing-chunks
  -> synthesizing-summary
  -> completed

Any active state -> cancelling -> cancelled
Any unrecoverable error -> failed
```

Unknown MediaKit non-terminal task states are treated as processing and logged in redacted form.
Polling uses jittered exponential backoff starting at five seconds and capped at thirty seconds.
The local task stops after two hours without a terminal MediaKit result. This timeout does not
promise that an already submitted remote job is cancelled.

MediaKit does not document remote task cancellation. The UI must therefore state that cancelling
stops local transfer, polling, conversion, and summarization, but a task already accepted by
MediaKit may finish remotely and may still incur provider charges.

## 8. Native Subtitle Path

Native subtitles are no longer flattened into a comma-separated prompt.

- YouTube timed text is parsed into timestamped cues.
- Bilibili subtitle `from`, `to`, and `content` fields are mapped directly.
- HTML entities and empty cues are normalized without losing cue boundaries.
- The resulting `TranscriptSegment[]` enters the same summary and display pipeline as ASR.

If a subtitle track disappears or fails to load after the user chooses it, the card reports the
failure and offers speech recognition; it does not start a paid ASR task automatically.

## 9. Hierarchical Summary Design

### 9.1 Chunking

Transcript chunks prefer natural sentence boundaries and target ten minutes. A chunk is closed
earlier when its transcript reaches 12,000 Unicode characters. Neighboring chunks repeat the last
two segments for continuity, and repeated segment IDs are removed before final synthesis. IDs,
rather than model-generated timestamps, preserve the source relationship.

### 9.2 Local extraction

Each segment has a stable ID such as `segment-128`. For each chunk, the model returns JSON-shaped
data containing:

- local summary;
- chapter candidates with start/end segment IDs;
- key moments with segment IDs;
- key points.

### 9.3 Final synthesis

Only local summaries and candidates are sent to the final synthesis request. The model returns the
final title, overview, deduplicated key points, and contiguous semantic chapters.

All displayed timestamps are derived in code from validated segment IDs. Model-provided free-form
time values are ignored. Invalid IDs, reversed ranges, overlapping chapters, and out-of-range
references are rejected or normalized.

### 9.4 Model-output fallback

Prompts request JSON, but the design does not assume every existing provider supports structured
output. A failed parse triggers one small repair request. If repair also fails, successful local
summaries are rendered as a degraded Markdown overview and the complete transcript remains
available.

## 10. Follow-up Questions

The “ask about this video” action opens a normal `ConversationCard`. Its initial context contains
the whole-video overview, key points, and chapter summaries. The complete transcript and hidden
chunking conversations are not injected. Transcript retrieval or embedding search is outside the
initial scope.

## 11. Storage and Cleanup

- Final transcript, chapters, and summary live only in component/task memory.
- No automatic writes are made to `Browser.storage.local.sessions`.
- The user may explicitly archive the final output through the existing independent-panel flow;
  archiving serializes the title, overview, key points, chapters, and transcript as one Markdown
  answer in a normal saved session.
- The user may export a Markdown file containing metadata, summary, timeline, and transcript.
- OPFS uses a task-specific directory and deletes it in a `finally` cleanup path.
- Object URLs are revoked, streams are cancelled, and FFmpeg workers are terminated.
- An uploaded MediaKit object may remain according to MediaKit's server-side retention policy;
  the UI privacy notice must disclose this before the first ASR submission.

## 12. Error Handling and Retry Policy

| Failure | Behavior |
|---|---|
| Video over three hours | Reject before upload and explain the provider limit |
| Unsupported/live/DRM source | Do not attempt bypass; explain the unsupported scope |
| Source URL expired | Re-resolve once from the still-current video page |
| MediaKit cannot download URL | Fall back once to download plus signed upload |
| 401/403 | Do not retry; point to MediaKit key and permission settings |
| 429/500/503/504 | Retry with jittered exponential backoff |
| Unsupported media format | Load FFmpeg and normalize once |
| Download or upload interruption | Retry from scratch once; signed upload is not assumed resumable |
| ASR succeeds, summary fails | Show transcript and allow summary-only retry |
| One chunk summary fails | Retry it twice, then continue with a visible partial-result warning |
| Final JSON cannot be repaired | Render degraded Markdown from local summaries |
| User cancels or video changes | Abort local work and delete all temporary data |

Errors retain stage, HTTP status, provider request ID, and a safe user-facing explanation. API
keys, signed media URLs, transcript content, selection text, and summary prompts are redacted from
logs.

## 13. Security and Privacy

- The user explicitly confirms speech recognition before any paid or upload operation.
- The MediaKit key is stored using the repository's existing BYOK storage pattern, but only the
  background service worker reads the cleartext value.
- Content scripts and Offscreen Documents never receive the key.
- Background validates every message sender and permits only known MediaKit operations and
  validated HTTP(S) endpoints.
- Offscreen receives only short-lived signed upload URLs.
- Media and transcript content are sent only after the user invokes the feature.
- No shared project credential is permitted in source, build artifacts, or extension storage.
- The UI states that audio may be uploaded to Volcengine and that local cancellation may not
  cancel an already accepted remote job.

## 14. Build and Browser Impact

- Add the Chromium `offscreen` permission and an Offscreen Document entry point.
- Keep Firefox MV2 and Safari manifests free of the unsupported feature and permission.
- Copy Offscreen and FFmpeg assets only into Chromium output directories.
- Package all WASM and worker code with the extension; MV3 remote executable code is forbidden.
- Load FFmpeg dynamically only on the fallback path.
- Preserve both full and `without-katex-and-tiktoken` Chromium variants; the video feature is
  available in both, so the FFmpeg asset may increase both ZIP sizes.
- Avoid importing the FFmpeg runtime into `shared.js`, content-script, popup, or normal page
  bundles.

## 15. Configuration

Add a video transcription section under Modules or the existing site/video settings:

- enable video transcription;
- MediaKit API key;
- automatic speaker identification, enabled by default;
- privacy and provider-retention notice.

The initial release does not add a “validate configuration” button because the selected MediaKit
contract does not document a non-billable validation endpoint. Credentials are validated by the
first explicitly confirmed task.

No separate summary-model selector is added. The current selected model and preferred language
are used.

## 16. Testing

### 16.1 Unit tests

- platform source normalization and native subtitle timestamp parsing;
- task-state transitions and rejection of illegal transitions;
- cancellation at every stage and stale-video event suppression;
- MediaKit request construction, response normalization, and error classification;
- direct URL failure and exactly-once upload fallback;
- speaker/confidence mapping and seconds-to-milliseconds conversion;
- transcript chunking, overlap deduplication, and segment-ID validation;
- local/final summary parsing, one-time repair, and degraded output;
- secret and content redaction from messages and logs;
- OPFS cleanup on success, failure, and cancellation;
- absence of automatic session-storage writes.

### 16.2 Integration tests with fakes

1. Native subtitles produce the structured three-layer result without ASR.
2. MediaKit accepts a direct media URL.
3. A provider download error triggers local download and signed upload.
4. An unsupported format triggers lazy FFmpeg processing.
5. ASR succeeds and summary fails, leaving a usable transcript.
6. Download, upload, polling, chunk summary, and final synthesis can each be cancelled.
7. Simulated service-worker restarts do not lose an Offscreen-owned task.
8. YouTube/Bilibili SPA navigation cannot display a stale result on the new video.

### 16.3 Manual browser checks

- Chrome and Edge, each with one captioned and one uncaptioned YouTube and Bilibili video;
- a logged-in but normally playable video;
- direct URL path, upload fallback path, and FFmpeg fallback path;
- clickable timestamps and speaker labels;
- cancellation, tab close, refresh, and video switch cleanup;
- OPFS removal, responsive page UI, and redacted logs in DevTools;
- Firefox/Safari hide the unsupported ASR entry while existing subtitle behavior still works.

### 16.4 Required repository validation

Because implementation will affect runtime code and the Chromium manifest, completion requires:

- `npm run pretty`
- `npm run lint`
- `npm test`
- `npm run build`
- expected Chromium and Firefox artifact checks
- manual Chrome/Edge extension smoke tests

## 17. Acceptance Criteria

- No paid request starts without explicit user confirmation.
- A supported video up to three hours can produce timestamped transcript segments with automatic
  speaker labels through AI MediaKit.
- Both native subtitles and ASR feed the same structured summary pipeline.
- Chapters and key moments seek to source-derived timestamps.
- Long transcripts are summarized hierarchically without one unbounded model prompt.
- The current model and preferred language are frozen for one task.
- Post-ASR failures preserve the transcript and expose stage-specific retry.
- Cancellation stops local work promptly and deletes all task-scoped local media.
- Nothing is automatically added to persistent conversation storage.
- No credential appears in content-script messages, Offscreen messages, logs, or build output.
- Existing non-video ChatGPTBox behavior and Firefox/Safari builds remain unaffected.

## 18. Alternatives Considered

### Direct CDN URL only

Rejected as the primary design because YouTube and Bilibili media URLs may be short-lived,
IP-bound, cookie-dependent, or protected by Referer checks. It remains the fast first attempt.

### Self-hosted media/BFF service

Deferred because it adds deployment, bandwidth, storage, user authentication, and operations. The
provider and source interfaces allow a BFF transport to replace the pure-extension path later.

### Doubao Voice Minutes

Deferred despite its native transcript, chapters, and summary because it accepts only a
server-downloadable `FileURL` and provides no documented upload flow or source-request headers.
It cannot reliably consume YouTube/Bilibili page or temporary CDN URLs without a media BFF.

### Browser-local Whisper

Deferred because model downloads, CPU/GPU use, memory, and Firefox/Safari compatibility greatly
increase the first-release scope. It can later implement the same `TranscriptionProvider`
contract.

## 19. Official Protocol References

- [AI MediaKit speech-to-subtitle ASR](https://docs.volcengine.com/docs/Intelligentprocessing/VoicetoSubtitleASR?lang=zh)
- [Submit speech-to-subtitle task](https://docs.volcengine.com/docs/Intelligentprocessing/Submitspeech-to-subtitleASRtaskAPI?lang=zh)
- [Doubao Voice Minutes API](https://docs.volcengine.com/docs/DoubaoVoice/DoubaoVoiceMinutes-APIAccessDocumentation?lang=zh)
