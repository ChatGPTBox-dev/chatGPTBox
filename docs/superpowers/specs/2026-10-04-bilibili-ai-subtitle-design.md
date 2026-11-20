# Bilibili AI Subtitle Fallback Design

**Date:** 2026-10-04

**Status:** Approved for implementation planning

**Parent design:** `2026-09-27-video-transcription-summary-design.md`

## 1. Purpose

Reduce paid Volcengine AI MediaKit ASR usage by consuming subtitles that Bilibili has already
generated for eligible videos. Bilibili-provided subtitles enter the existing transcript and
structured-summary pipeline; MediaKit remains an explicit user-selected fallback when Bilibili has
no usable subtitle.

This design extends the full-Chromium Bilibili video-summary feature. It does not change the model
used to summarize a transcript and does not replace the existing structured result format.

## 2. Confirmed Current State and Interface Evidence

The current implementation already requests
`https://api.bilibili.com/x/player/wbi/v2?bvid=...&cid=...` with the page's login context and loads
every returned `subtitle.subtitles[].subtitle_url`. It then treats every loaded track as a generic
native subtitle and `VideoTaskRunner` always selects the first track.

This covers some Bilibili automatically generated subtitle tracks, but it does not cover videos
whose player response has no subtitle track while the separate Bilibili AI conclusion response has
AI subtitle segments.

The design investigation verified the following behavior on 2026-10-04 using the public example
video `BV1L94y1H7CV`, `cid=1335073288`:

- `/x/player/wbi/v2` returned an empty `subtitle.subtitles` array without a login session.
- An unsigned `/x/web-interface/view/conclusion/get` request returned outer code `-403`.
- A correctly WBI-signed request reached authentication and returned outer code `-101` when made
  without a Bilibili login session.
- The community-maintained Bilibili API documentation shows successful
  `model_result.subtitle[].part_subtitle[]` entries containing `content`, `start_timestamp`, and
  `end_timestamp`.

Therefore, only improving player-track selection is insufficient. The approved solution uses the
AI conclusion endpoint as a second Bilibili-owned subtitle source while treating the endpoint as an
undocumented, fallible integration.

## 3. Product Decisions

The source priority is:

1. a usable author-provided Bilibili subtitle track;
2. a usable Bilibili AI-generated player subtitle track;
3. a usable player subtitle track whose origin metadata is unknown;
4. usable AI subtitle segments returned by Bilibili's conclusion endpoint;
5. Volcengine MediaKit ASR, only after the existing explicit confirmation.

The extension consumes only subtitles Bilibili has already generated. It does not request or poll
for new Bilibili subtitle generation.

The extension does not automatically start summary generation or paid ASR. When a Bilibili
subtitle is available, the UI recommends and identifies it. The user may still deliberately choose
ASR when higher-quality transcription or speaker identification is desired.

Bilibili's own AI summary and outline are not used. The existing ChatGPTBox chunk summarization,
final synthesis, coverage calculation, timestamp validation, export, archive, and follow-up chat
behavior remain authoritative.

## 4. Architecture

### 4.1 `BilibiliWbiSigner`

Add a focused, browser-independent helper under the Bilibili site adapter. It:

- derives the WBI image and sub keys from the `/x/web-interface/nav` response;
- applies Bilibili's fixed permutation table and truncates the mixin key to 32 characters;
- adds a current Unix-second `wts`, strips the documented `[!'()*]` characters from values, sorts
  parameters lexicographically, URL-encodes them, and computes `w_rid` as MD5 of the canonical query
  plus mixin key;
- uses the already-installed `@noble/hashes` package rather than adding a dependency;
- caches only the derived mixin key in content-script memory;
- invalidates and refreshes that key once after an authorization/signature rejection, then stops.

The signer receives JSON and parameter data. It does not read cookies, DOM state, extension
storage, or global location, which keeps deterministic unit testing possible.

### 4.2 `VideoPageBridge`

`createBilibiliVideoPageBridge()` remains the only Bilibili network/page boundary. Source discovery
becomes a staged operation:

1. Load the video page and resolve the selected `bvid`, `cid`, duration, title, and optional uploader
   ID from `__INITIAL_STATE__`.
2. Load DASH audio candidates as today so ASR remains available if necessary.
3. Request player information and independently load each advertised subtitle body. A failed or
   malformed track is skipped instead of failing the complete source snapshot.
4. If at least one player track has usable cues, do not call the conclusion endpoint.
5. If no player track is usable, load `/x/web-interface/nav`, sign the conclusion parameters, and
   request `/x/web-interface/view/conclusion/get` with `credentials: 'include'`.
6. Normalize usable conclusion subtitle segments into one Bilibili AI track.

Neither cookies nor cookie-derived values are read into JavaScript or placed in a message. Browser
credential attachment is controlled solely by `fetch(..., { credentials: 'include' })`.

### 4.3 Subtitle source contract

Keep the existing serializable `nativeSubtitleTracks` snapshot property to avoid broad protocol
churn. Each track gains source metadata:

```js
{
  id: string,
  language: string,
  label: string,
  sourceKind: 'author' | 'bilibili-ai' | 'unknown',
  cues: [{
    startMs: number,
    endMs: number,
    text: string,
  }],
}
```

Player tracks preserve Bilibili's `lan`, `lan_doc`, and `ai_type` only long enough to derive safe
source metadata. Classification is deterministic: a positive numeric `ai_type`, or a `lan_doc`
containing `AI` or `自动生成`, produces `bilibili-ai`; numeric `ai_type === 0` without either label
marker produces `author`; an absent or unrecognized `ai_type` without a label marker produces
`unknown`. An unknown track is never falsely presented as author-provided.

Conclusion subtitle groups are flattened in response order, converted from seconds to integer
milliseconds, filtered for non-empty text and finite non-negative timestamps, sorted by start time,
and de-duplicated when all three normalized fields match. They are labeled `sourceKind:
'bilibili-ai'`. The documented response is Chinese, so the normalized language is `zh-CN` unless
Bilibili provides a more specific language field.

`sourceSnapshot` also contains a serializable discovery result:

```js
{
  subtitleDiscovery: {
    conclusionStatus:
      'not-needed' | 'available' | 'not-found' | 'login-required' | 'unavailable',
  },
}
```

No raw response, WBI key, signature, URL query string, cookie, or provider credential is retained in
the snapshot.

Conclusion status mapping is also deterministic. Outer code `-101` becomes `login-required`.
Outer code `-403` causes the single WBI-key refresh and retry; a repeated `-403` becomes
`unavailable`. Outer code `0` becomes `available` only when normalization yields cues and otherwise
becomes `not-found`. Network failures, malformed JSON, and every other response code become
`unavailable`.

### 4.4 Source selection and task execution

The page bridge orders usable tracks by `author`, then `bilibili-ai`, then `unknown`, preserving API
order within each group. The host displays the first ordered track as the recommended Bilibili
subtitle. The task start command includes its track ID so the runner does not depend on array
position.

`VideoTaskRunner` resolves the requested track ID and converts its cues to the same normalized
transcription used by MediaKit. If the selected track disappeared from a refreshed snapshot or has
no usable cues, it fails with a subtitle-source error; it never changes the request into ASR.

The rest of the task is unchanged: transcript chunks are summarized, structured tool output is
validated, final chapters and moments derive from transcript segment IDs, and partial/degraded
results retain coverage information.

This path must not call `MediaKitGateway`, read `mediaKitApiKey`, create OPFS files, upload audio, or
show ASR retention/cost confirmation.

### 4.5 UI behavior

The source choices remain explicit:

- When a Bilibili track is available, show a recommended action whose label identifies “Author
  subtitles”, “Bilibili AI subtitles”, or the original Bilibili label when classification is
  unknown.
- Keep “Run ASR” as a secondary override. Selecting it continues to show the existing remote
  retention and cancellation-cost confirmation.
- When no track is available because the user is logged out, explain that signing in to Bilibili
  may expose AI subtitles; also leave ASR available.
- When the conclusion endpoint reports no usable result or is temporarily unavailable, show a
  neutral “No Bilibili subtitles available” state and leave ASR available.
- Do not expose raw Bilibili status codes or promise that every video has AI subtitles.

Add these labels and explanations to the English locale first and translate the user-visible
Chinese variants without changing existing localization keys.

No new persistent user setting is required. Existing transcription enablement, preferred language,
speaker-identification, and maximum-output-token settings remain unchanged.

## 5. Error and Fallback Rules

| Condition | Behavior |
| --- | --- |
| One player subtitle body fails | Skip that track and continue loading other advertised tracks. |
| Player has at least one usable track | Use ordered player tracks; do not call the conclusion endpoint. |
| Player has no usable track | Attempt one signed conclusion request. |
| WBI key is stale or signature is rejected | Refresh the nav keys and retry the conclusion request once. |
| Bilibili login is required | Record `login-required`; do not throw away the audio fallback snapshot. |
| Conclusion response has no usable subtitle | Record `not-found`; leave ASR as an explicit choice. |
| Conclusion network/protocol failure | Record `unavailable`; leave ASR as an explicit choice. |
| Selected subtitle becomes invalid | Fail the task locally; never silently start ASR. |
| Bilibili subtitle succeeds but summary model is unsupported | Preserve the transcript and existing summary-only retry behavior. |

Only deterministic interface/protocol errors are logged. Logs must not contain subtitle text,
complete response bodies, signed URLs, WBI key material, cookies, prompts, or model output.

## 6. Security and Privacy

- Reuse the current Bilibili page login context; never extract or persist `SESSDATA` or other
  cookies.
- Restrict the new requests to fixed HTTPS Bilibili API origins and fixed paths. Caller-supplied
  URLs are not accepted by the signer or conclusion loader.
- Treat AI subtitles as page content. They enter the configured summary model only after the user
  explicitly starts the Bilibili-subtitle summary action.
- Preserve structured-clone-only message contracts and the background-derived
  `(tabId, documentId, videoId)` owner identity.
- Keep the MediaKit key in the existing background-only gateway. The zero-MediaKit-call property of
  every Bilibili subtitle path is an explicit test invariant.
- Do not persist discovered subtitle text automatically. Existing explicit archive and Markdown
  download actions remain the only retention paths.

## 7. Testing

### 7.1 Unit tests

- WBI permutation, canonical parameter ordering, forbidden-character stripping, URL encoding, MD5
  output, and caller-parameter immutability against a fixed fixture.
- Player subtitle classification, ordering, per-track failure isolation, cue normalization, and
  preservation of unknown metadata as `unknown`.
- Conclusion response flattening, seconds-to-milliseconds conversion, ordering, de-duplication,
  malformed-segment filtering, and empty response handling.
- Page bridge short-circuit when a player track is usable.
- Page bridge signed conclusion fallback when player tracks are empty or unusable.
- One key refresh/retry after a signature rejection, with no unbounded retries.
- Logged-out, not-found, and unavailable discovery statuses still return the audio source snapshot.
- Task runner selects the requested track ID and rejects a missing/empty selection without invoking
  MediaKit.
- View labels the recommended source correctly and retains explicit ASR confirmation.

### 7.2 Integration tests with fakes

1. An author subtitle completes transcription and summary without nav, conclusion, or MediaKit
   calls.
2. A player AI subtitle completes transcription and summary without conclusion or MediaKit calls.
3. Empty player tracks trigger a signed conclusion request; returned AI segments complete summary
   without MediaKit calls.
4. A login-required or unavailable conclusion response leaves ASR selectable but does not start it.
5. Explicitly confirmed ASR still follows the existing direct-download and upload-fallback paths.

### 7.3 Manual verification

- In a logged-in Chrome or Edge 116+ profile, verify a video with an author subtitle, a player AI
  subtitle, and a conclusion-only AI subtitle.
- Confirm the displayed source label and timestamp seeking for each path.
- Inspect network activity to verify the conclusion endpoint is skipped when a player track works.
- Inspect background/offscreen logs and MediaKit account activity to verify Bilibili subtitle paths
  make no MediaKit requests.
- Verify logged-out and unavailable cases keep ASR behind the existing confirmation.
- Recheck SPA navigation, reload/reattach, archive, Markdown export, and summary-only retry.

Repository validation remains `npm run pretty`, `npm run lint`, `npm test`, and `npm run build`,
followed by expected-artifact checks and relevant manual Chromium smoke tests.

## 8. Compatibility and Non-Goals

- The feature remains limited to the full Chromium Bilibili video-summary experience. Firefox,
  Safari, minimal builds, bangumi pages, live streams, and unsupported/protected media retain their
  current behavior.
- No new extension permission, host permission, dependency, remote executable code, backend, or
  credential store is introduced.
- No attempt is made to bypass Bilibili authentication, membership, paid-content, DRM, geographic,
  or creator restrictions.
- No Bilibili AI summary, outline, feedback, subtitle-generation trigger, or persistent subtitle
  cache is added.

## 9. Acceptance Criteria

- A usable author or player AI subtitle prevents any conclusion and MediaKit request.
- A video with no usable player track but usable conclusion AI subtitles completes the existing
  structured summary pipeline without a MediaKit request.
- A missing login, absent AI result, malformed subtitle, or Bilibili API failure never starts ASR
  automatically and still permits the user to choose confirmed ASR.
- The UI accurately identifies the selected Bilibili subtitle source and keeps ASR cost/retention
  confirmation unchanged.
- WBI signing is deterministic, request-scoped, and bounded to one key-refresh retry.
- Cookies, WBI key material, signed queries, raw subtitle responses, and subtitle text do not enter
  logs or persistent configuration.
- Bilibili subtitle tasks preserve the existing timestamp, structured summary, degradation,
  archive, export, cancellation, ownership, and summary-retry contracts.
