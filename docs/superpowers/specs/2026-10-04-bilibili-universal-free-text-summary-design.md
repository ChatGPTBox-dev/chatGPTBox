# Bilibili Universal Free-Text Summary Design

## 1. Summary

Replace the enhanced Bilibili summary pipeline's OpenAI-compatible tool-calling requirement with a
provider-neutral text-generation contract. Every currently configurable AI model uses the same
staged Markdown protocol:

1. Each transcript chunk produces a short local summary, a small set of key points, and optional
   segment-anchored candidate locations.
2. A final synthesis request combines those compact chunk results into an overview, key points,
   chapters, and key moments.
3. A tolerant local parser converts the Markdown into the existing UI result model. Valid
   `[segment:<id>]` markers become clickable video timestamps. Invalid or missing markers preserve
   their text but do not create a jump target.

The model remains free to write natural text within a documented template. It no longer needs to
call a function or produce a complete JSON object. This reduces output overhead, avoids brittle
schema failures, and permits web-account models such as Kimi Web to participate.

## 2. Goals

- Support every model that is currently configurable and usable for ordinary chat.
- Use the user's selected model without silently switching providers.
- Remove tool/function calling and whole-response JSON as video-summary requirements.
- Preserve clickable chapters and key moments through validated transcript segment IDs.
- Bound each response with fixed content limits and request-level token caps.
- Preserve useful model output when Markdown is incomplete or imperfect.
- Keep transcript acquisition, ASR, checkpoints, cancellation, security boundaries, archive, and
  download behavior.
- Return actionable login or execution-condition errors for web models.

## 3. Non-goals

- Adding new AI providers or models.
- Bypassing login, membership, regional, page-presence, or provider restrictions.
- Automatically falling back to another model or provider.
- Asking the model to calculate timestamps, coverage, or failed ranges.
- Adding user-configurable output-shape controls or detail presets.
- Repairing malformed output with an automatic extra model call.
- Changing the legacy Bilibili integration used when the enhanced feature is unavailable or off.

## 4. Current Problem

The enhanced pipeline currently calls `ModelGateway.invokeTool()` twice conceptually: once per
transcript chunk and once for final synthesis. The gateway resolves only OpenAI-compatible API
requests and requires structured tool calls. Web-account modes and dedicated provider adapters are
reported as unsupported before generation. For Kimi Web this produces
`MODEL_GATEWAY_UNSUPPORTED`, even though ordinary chat can already use that model.

The current schemas also require models to emit several nested arrays and fields in one tool call.
This increases output size and makes a partially useful response fail as a whole when the provider
or model does not follow the exact schema.

## 5. Architecture

### 5.1 Provider-neutral text gateway

The video-summary domain depends on this conceptual contract:

```js
describeCapabilities(modelIdentity)
generateText({
  requestId,
  taskId,
  modelSnapshot,
  messages,
  maxOutputTokens,
})
cancel({ requestId, taskId })
```

`generateText()` returns provider text plus safe completion metadata when available. It does not
return tool calls or require a response schema.

The summary runner knows nothing about provider families. Model routing remains behind the
background gateway:

- OpenAI-compatible APIs execute through their existing background core.
- Dedicated APIs such as Claude and Azure reuse their existing adapters through narrow isolated
  generation adapters.
- Web models that can execute in the background, including Kimi Web, use temporary isolated
  sessions.
- Web models that require a provider page reuse the existing trusted proxy context through a new
  video-summary request scope. They must not inherit ordinary chat's latest-request-wins state.

Adapter differences stay below the gateway. Transcript chunking, templates, parsing, result
construction, and retries remain provider-independent.

### 5.2 Model identity and immutable snapshots

The content script continues to send a structured-clone-safe snapshot containing the configured
model name and API-mode identity, but no secret. The gateway resolves credentials and execution
requirements in a trusted context.

A task uses an immutable model snapshot for each generation attempt. If the user changes models
and explicitly retries, unfinished requests use the new snapshot. Completed local chunk Markdown
may be reused because it contains no provider-specific state.

### 5.3 Isolated generation

Every generation request:

- has a task-scoped and request-scoped ID;
- uses a temporary session with no remote conversation history dependency;
- includes all required instructions and input in that request;
- does not mutate or persist a user-facing chat session;
- can be cancelled without affecting normal chat or another video task;
- never logs prompts, transcript text, answers, cookies, tokens, or API keys.

### 5.4 Capability states

Capability reporting distinguishes:

- `supported`: an isolated text-generation adapter is available and current conditions permit it;
- `temporarilyUnavailable`: the model is supported but needs login, a provider page, or another
  recoverable runtime condition;
- `unsupported`: no safe isolated adapter exists.

The implementation goal is that every currently configurable chat model has either a successful
path or an actionable temporary-condition error. A model must not be rejected merely because it
lacks OpenAI-compatible tool calling.

## 6. Transcript and Summary Flow

Transcript acquisition remains unchanged:

1. Use the selected Bilibili native subtitle track, including discovered AI subtitles; or
2. Run the confirmed MediaKit ASR path and produce normalized timestamped segments.

The summary stages become:

1. Determine the model's input and output budgets.
2. Split the transcript into primary ranges with small before/after context.
3. Generate compact Markdown independently for each chunk.
4. Tolerantly parse and normalize each chunk response.
5. Send only compact normalized chunk results to final synthesis.
6. Tolerantly parse final Markdown.
7. Validate segment anchors and deterministically construct timestamps, chapters, coverage,
   warnings, and failed ranges.
8. Render parsed sections, with raw model text as a last-resort summary fallback.

The final model request never receives the complete transcript again.

## 7. Chunk Output Protocol

### 7.1 Input

Each chunk request includes:

- primary transcript segments;
- a small number of context-before and context-after segments;
- the ID and text for each segment;
- the preferred output language;
- an instruction that only primary segment IDs may be used as anchors.

Context segments are for understanding only and cannot become location anchors.

### 7.2 Template

The requested template is:

```md
## 分块摘要
不超过 300 字的摘要。

## 分块要点
- 要点一
- 要点二

## 候选定位
- [segment:native-12] 开始讨论核心问题
- [segment:native-25] 给出主要结论
```

The headings are emitted in the preferred language when practical. The parser recognizes a narrow
set of localized aliases rather than requiring Chinese headings.

### 7.3 Fixed limits

- Chunk summary: at most 300 characters.
- Chunk key points: at most 5.
- Each chunk key point: at most 120 characters.
- Candidate locations: at most 5.
- Each candidate description: at most 120 characters.

The application truncates excess entries and overlong fields after parsing. Prompt instructions
are advisory; local normalization is authoritative.

Candidate locations are evidence for final synthesis, not final chapters. A chunk remains useful
when the location section is absent or malformed.

## 8. Final Output Protocol

### 8.1 Input

The final request receives only normalized compact chunk results:

- local summaries;
- local key points;
- validated candidate location IDs and descriptions;
- source chunk order and covered primary ranges.

It does not receive full transcript text. It may use only segment IDs present in the supplied
candidate data.

### 8.2 Template

```md
## 整体摘要
视频的整体摘要。

## 核心要点
- 核心要点一
- 核心要点二

## 章节
- [segment:native-1] 开场与背景
  对本章节内容的简要说明。
- [segment:native-42] 核心方案
  对核心方案的简要说明。

## 关键时刻
- [segment:native-25] 作者提出核心结论
- [segment:native-78] 展示关键案例
```

### 8.3 Fixed limits

- Overview: at most 600 characters.
- Key points: at most 12.
- Each key point: at most 150 characters.
- Chapters: at most 20.
- Each chapter description: at most 150 characters.
- Key moments: at most 15.
- Each key-moment description: at most 120 characters.

These are built-in rules and do not add settings. Request-level token limits provide a second
bound. Chunk calls use a smaller token cap than synthesis. Both caps are limited by user/provider
configuration and advertised model capability.

The prompt does not ask the model to repeat transcript text, calculate millisecond timestamps,
produce chapter end positions, report coverage, or describe failures.

## 9. Tolerant Markdown Parsing

### 9.1 Recognized sections

The parser recognizes headings in any order and accepts a small alias table, including:

- overview: `整体摘要`, `摘要`, `Overview`, `Summary`;
- key points: `核心要点`, `要点`, `Key Points`;
- chapters: `章节`, `Chapters`;
- key moments: `关键时刻`, `Key Moments`;
- chunk equivalents for local summary, local points, and candidate locations.

Explanatory text before and after known sections does not invalidate the response.

### 9.2 Segment marker syntax

The only machine-significant inline syntax is:

```text
[segment:<segment-id>]
```

Examples include `[segment:native-12]` and `[segment:asr-35]`. The parser extracts the marker and
keeps the surrounding human-readable text.

Validation rules:

1. A marker that resolves to an allowed transcript segment becomes a jump target using the
   segment's actual `startMs`.
2. A well-formed but unknown or disallowed ID preserves its text without a jump target and adds a
   non-blocking warning.
3. An entry without a marker preserves its text without a jump target.
4. For repeated valid IDs, the first useful occurrence wins; remaining entries are deduplicated by
   normalized text.
5. The original `[segment:...]` marker is not shown to users.

The model never supplies trusted timestamps. All jump positions come from the local transcript.

### 9.3 Missing or malformed sections

- Missing overview: use compact local summaries.
- Missing key points: deduplicate and merge local key points.
- Missing chapters: omit the chapter section.
- Missing key moments: omit the key-moment section.
- Unrecognized final structure: retain the raw response as readable summary text.
- Failed final synthesis: build a degraded result from chunk summaries, points, and validated
  candidates.
- Failed chunks: continue processing other chunks and report uncovered ranges.

There is no automatic repair generation. Parsing and fallback are deterministic and local.

## 10. Internal Result Model

The UI keeps a normalized object even though providers return free text:

```js
{
  status: 'complete', // complete | partial | degraded
  overview: 'Overall summary',
  rawSummaryText: 'Original model text',
  keyPoints: ['Point'],
  chapters: [
    {
      segmentId: 'native-12',
      startMs: 125000,
      endMs: 240000,
      title: 'Chapter title',
      summary: 'Chapter description',
    },
    {
      segmentId: null,
      startMs: null,
      endMs: null,
      title: 'Unanchored chapter',
      summary: 'Preserved text',
    },
  ],
  keyMoments: [
    {
      segmentId: 'native-35',
      startMs: 360000,
      point: 'Important moment',
    },
  ],
  transcriptSegments: [],
  coverage: {
    coveredDurationMs: 600000,
    totalDurationMs: 660000,
    ratio: 0.9091,
  },
  warnings: [],
  failedRanges: [],
}
```

Jumpability is derived from a valid `startMs`; it need not be persisted separately. For anchored
chapters, end positions are computed from the next valid chapter and covered transcript range.
Unanchored chapters retain text but have no timestamp button.

`rawSummaryText` is a presentation fallback and is sensitive content. It is not included in logs.
It is persisted only through the existing explicit archive or Markdown-download actions.

## 11. Status and Degradation

### 11.1 Complete

A result is `complete` when every chunk and final synthesis succeed and usable summary text exists.
A small number of invalid anchors only produces a warning; it does not make an otherwise complete
summary partial.

### 11.2 Partial

A result is `partial` when one or more transcript ranges fail or do not participate, while useful
summary content remains. Coverage and failed ranges identify the missing portion.

### 11.3 Degraded

A result is `degraded` when:

- final synthesis fails but local chunk summaries exist;
- final output has no recognized sections but useful raw text exists; or
- a task with existing checkpoint content becomes temporarily unable to call the selected model.

If the model is unavailable before any summary generation, the UI retains the transcript and
checkpoint but reports an actionable error rather than presenting `MODEL_GATEWAY_UNSUPPORTED` as a
summary warning.

Presentation fallback order is:

1. parsed final sections;
2. aggregated local chunk summaries and points;
3. raw final model text;
4. transcript only.

## 12. Retry and Cancellation

Retry resumes from existing transcript or ASR checkpoints and does not repeat media download,
upload, or transcription unnecessarily.

- Final synthesis failure: retry final synthesis only.
- Failed chunks: retry failed chunks, then synthesize again.
- Expired login: resume incomplete summary stages after login.
- Missing provider page: resume after the required page is available.
- Explicit model change before retry: use the new immutable model snapshot and reuse completed
  provider-neutral chunk Markdown.

Cancellation addresses only the matching `(taskId, requestId)` generation. It must not cancel
ordinary chat, another chunk, or another video task.

The pipeline does not automatically continue truncated output. It preserves parseable content,
marks the result partial or degraded, and permits explicit retry from the checkpoint.

## 13. UI and Export

The enhanced panel retains:

- overall summary;
- key points;
- chapters;
- key moments;
- transcript;
- archive;
- ask about video;
- Markdown download;
- retry summary.

A valid anchor renders the existing clickable timestamp control. An invalid or missing anchor
renders text without that control. User-facing warnings say that some time locations are
unavailable rather than exposing parser codes.

Login and runtime errors identify the selected model and the recovery action, such as signing in or
opening its provider page. The extension never silently changes providers.

Markdown export uses readable timestamps for valid anchors and plain text for unanchored entries.
Internal segment marker syntax is not exposed unless the unparsed raw response is the only usable
fallback.

## 14. Security and Privacy

- The Bilibili page and offscreen runtime receive model identity snapshots, not provider secrets.
- API keys, cookies, access tokens, and refresh tokens stay in their existing trusted contexts.
- Provider-page execution uses an operation allowlist and video-summary-specific request identity.
- Logs include safe metadata such as task, request, model family, stage, duration, completion state,
  and redacted error code only.
- Prompts, subtitles, model responses, sessions, authorization headers, and signed URLs are never
  logged.
- Existing activation, ASR confirmation, owner matching, URL validation, and OPFS cleanup rules
  remain in force.

## 15. Error Handling

The gateway normalizes errors into user-actionable classes without discarding provider-specific
translated messages:

- login required or login expired;
- provider page required;
- rate limit, network, or temporary service failure;
- output incomplete or provider output limit reached;
- task cancelled;
- adapter failure.

No automatic provider fallback occurs. Confirmed transient retry behavior remains bounded per task;
ambiguous paid calls are not silently repeated. Output-format problems use local fallback rather
than another paid repair call.

## 16. Testing Strategy

### 16.1 Parser unit tests

Cover:

- Chinese and English heading aliases;
- sections in different orders;
- explanatory prefixes and suffixes;
- valid, invalid, missing, disallowed, and duplicate segment IDs;
- multiline chapter descriptions;
- missing sections;
- ordinary article-style responses;
- truncation in every section;
- deterministic character and item limits;
- preservation of unanchored text;
- absence of raw text, prompts, and transcripts in logs.

### 16.2 Runner unit tests

Cover:

- chunk prompts request only a local summary, points, and candidates;
- final prompts receive compact chunk results rather than the transcript;
- chunk and final calls use distinct bounded output caps;
- one chunk failure does not stop later chunks;
- final failure builds a useful degraded result;
- invalid locations remain visible but not jumpable;
- coverage and failed ranges remain deterministic;
- retry reuses transcript or ASR checkpoints;
- a model change can reuse provider-neutral chunk output.

### 16.3 Gateway contract tests

Use a shared contract suite for each execution family:

- OpenAI-compatible API;
- dedicated API;
- background-capable web model, including Kimi Web;
- provider-page proxy web model.

Verify that each adapter:

- returns text;
- uses an isolated temporary session;
- leaves user sessions unchanged;
- cancels only the named request;
- reports login and page requirements accurately;
- does not expose credentials or content in logs;
- does not share ordinary chat's latest-request-wins state.

### 16.4 Integration and UI tests

Cover:

- native subtitle to clickable chapter flow;
- ASR to free-text summary flow;
- Kimi Web logged-in summary flow;
- malformed Markdown degradation;
- unanchored chapters and moments rendering without timestamp buttons;
- archive and Markdown download readability;
- actionable web-model runtime errors;
- legacy behavior in Firefox, Safari, minimal builds, unsupported runtimes, and when the feature is
  disabled.

## 17. Rollout and Completion Criteria

Implementation should proceed by execution family while keeping the provider-neutral protocol
stable. A provider family is complete only after passing the shared gateway contract and relevant
integration tests.

The feature is complete when:

1. The summary runner has no tool-calling or JSON-schema dependency.
2. Every currently configurable chat model has a tested isolated text path or an actionable
   recoverable-condition error.
3. Kimi Web can summarize while logged in without `MODEL_GATEWAY_UNSUPPORTED`.
4. Valid segment anchors produce clickable chapters and key moments.
5. Malformed or absent anchors preserve useful text without extra repair calls.
6. Fixed content limits and request token caps prevent unbounded single responses.
7. Existing security, ASR confirmation, checkpoint, cancellation, archive, and export guarantees
   remain intact.
