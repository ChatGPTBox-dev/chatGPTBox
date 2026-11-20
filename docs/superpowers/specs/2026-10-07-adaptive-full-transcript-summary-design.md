# Adaptive Full-Transcript Video Summary Design

**Date:** 2026-10-07

**Status:** Approved for implementation planning

## 1. Purpose

Improve enhanced video-summary fidelity by giving the selected model the complete transcript whenever
it can accept it. If and only if that request fails with a recognized context-window overflow, fall
back once to an ordered rolling evidence ledger rather than independently summarizing chunks and
then summarizing those lossy summaries.

## 2. Scope

### Included

- Attempt one final-summary request containing the complete transcript before any chunk work.
- Detect explicit provider context-window overflow across supported model routes.
- On recognized overflow, process transcript ranges in source order with one evolving structured
  evidence ledger.
- Feed each ledger update request only the previous ledger and the next raw transcript range.
- Generate the final summary once from the completed ledger.
- Preserve transcript segment IDs throughout direct and rolling modes for timestamp validation.
- Checkpoint mode, progress, and the latest ledger so interrupted rolling work can resume.
- Preserve existing summary UI, result shape, export behavior, and adaptive key-content targets.
- Update focused unit and integration tests.

### Excluded

- Keeping all transcript chunks in one ever-growing chat history; that would still exceed the model
  context window.
- Parallel or independent chunk summaries.
- Automatic enrichment when a successful final response contains fewer key-content items than the
  prompt requests.
- Falling back for authentication, rate limits, network errors, cancellation, malformed output, or
  generic provider failures.
- Changes to the legacy Bilibili and YouTube subtitle-summary paths.
- New user-facing context-window settings.

## 3. Summary Modes

The runner supports two enhanced summary modes.

### 3.1 Direct mode

After transcription and capability discovery, the runner builds the final prompt from the complete
normalized transcript. Each transcript segment includes only the fields required for summarization
and anchoring: `id`, `startMs`, `endMs`, `speaker`, and `text`.

The request uses the existing preferred language, adaptive key-content range, output-token limit, and
final Markdown contract. All real transcript segment IDs are valid final anchors. If generation and
output validation succeed, the runner builds a complete result directly from the transcription and
does not issue ledger-update requests.

The runner attempts direct mode regardless of its local token estimate. This intentionally prefers
quality and lets the selected provider make the authoritative context decision.

### 3.2 Rolling-ledger mode

The runner enters rolling-ledger mode only when the direct request fails with a normalized,
recognized context-window overflow error.

Transcript ranges are processed sequentially. Each update request receives:

1. the previous structured evidence ledger, or an empty ledger for the first range;
2. the next raw transcript range with stable segment IDs and timestamps;
3. instructions to preserve unique evidence, merge only genuine duplicates, and avoid writing the
   final summary.

The returned ledger replaces the previous ledger. Old transcript ranges and model messages are not
resent. This keeps each request bounded while maintaining one continuous model-generated memory.
The same selected model and model snapshot are used for every update and final synthesis within an
attempt.

After the final range, one final request converts the completed ledger into the existing Overview,
Key content, and Chapters Markdown format.

## 4. Evidence Ledger

The ledger is structured Markdown rather than free-form prose so it can be parsed, bounded, checked,
and resumed without introducing a new model tool protocol. It contains fixed sections:

- `主题与人物`: identities, roles, background, and relationships;
- `叙事与论证`: source-ordered developments, positions, reasoning, and conclusions;
- `事实与证据`: facts, names, numbers, examples, comparisons, caveats, and consequences, each with
  one or more `[segment:<id>]` anchors;
- `章节候选`: source-ordered chapter boundaries and descriptions with anchors;
- `待补信息`: unresolved references or claims that later transcript ranges may clarify;
- `覆盖位置`: the last processed transcript segment ID.

The ledger must:

- contain only information supported by the transcript ranges processed so far;
- preserve distinct evidence even when it concerns the same topic;
- merge exact or semantic duplicates without deleting unique facts;
- retain important numbers, names, examples, causal links, qualifications, and disagreements;
- never contain provider credentials, page secrets, or the full prior transcript;
- use only segment IDs present in the processed transcript prefix;
- remain within explicit section, item, and character limits.

If the ledger approaches its limit, the model is instructed to shorten wording and consolidate
repetition first. Unique evidence must not be discarded merely to make prose concise. The parser
applies hard safety limits, so the prompt and parser share the same constants.

## 5. Range Selection

Rolling ranges reuse deterministic transcript partitioning, but they are no longer independently
summarized. Range construction must account for the serialized ledger, update prompt, raw segment
objects, requested output budget, and a safety margin. Because provider context capacities are not
reliably known today, the implementation starts with the existing conservative input budget for
range sizing and may recursively split a range if a ledger-update request itself receives a
recognized context overflow.

A range that overflows is split into smaller contiguous ranges and retried. This split is allowed
only for context overflow and terminates with a clear failure if a single transcript segment cannot
fit. No range is processed twice after a successful checkpoint update.

Ranges may include a small overlap for linguistic continuity, but only primary segments advance the
checkpoint. The ledger updater is told that overlap is context only and must not duplicate evidence.

## 6. Context-Overflow Classification

Introduce one normalized error code, `MODEL_CONTEXT_WINDOW_EXCEEDED`, at the model-dispatch boundary.
Supported providers map only explicit, trustworthy context-limit signals to this code, including
provider error codes, documented stop reasons, or clearly identified maximum-context messages.

The classifier must not infer context overflow from generic HTTP 400 responses or vague text such as
“request failed.” Raw provider bodies, prompts, transcript text, model messages, and URLs remain
redacted under the existing diagnostic policy.

Only this normalized code triggers direct-to-ledger fallback or recursive ledger-range splitting.
The following retain current behavior and never trigger fallback:

- login or provider-page requirements;
- cancellation;
- rate limiting or quota failures;
- transport and network errors;
- provider unavailability;
- malformed or incomplete model output;
- unsupported model capability.

## 7. Checkpoint and Retry Semantics

The transcription remains checkpointed before model work. Summary checkpoint data additionally
records:

```js
{
  summaryMode: 'direct' | 'rolling-ledger',
  nextSegmentIndex,
  evidenceLedger,
}
```

### Direct mode

- Before a direct request, mode is `direct` and no ledger exists.
- A recognized overflow atomically switches the checkpoint to `rolling-ledger` before ledger work.
- Other failures leave the transcription checkpoint available under existing retry rules.

### Rolling-ledger mode

- After each successful ledger update, checkpoint the new ledger and the next primary segment index.
- Cancellation or failure resumes from `nextSegmentIndex`; completed ranges are not sent again.
- A context overflow during a ledger update splits only the current uncommitted range.
- Retry may use a newly selected model while retaining the provider-neutral ledger and anchors.
- A synthesis-only retry uses the completed ledger and does not replay transcript ranges.

Checkpoint messages remain structured-clone-safe and within existing protocol size limits. If the
ledger cannot fit the checkpoint contract, the task fails explicitly rather than silently truncating
outside the ledger parser's declared limits.

## 8. Result Construction and Coverage

Direct mode allows every transcript segment ID as a final anchor. Its successful result reports full
transcript coverage without fabricating chunk results.

Rolling-ledger final synthesis allows only segment IDs retained and validated in the ledger. Coverage
is derived from the checkpointed processed transcript prefix and failed ranges, not from legacy
independent chunk summaries.

The existing result shape remains:

```js
{
  status,
  overview,
  rawSummaryText,
  keyMoments,
  chapters,
  transcriptSegments,
  coverage,
  warnings,
  failedRanges,
}
```

No `keyPoints` field is restored. `keyMoments` continues to represent user-facing Key content.

## 9. Prompt Design

Direct and ledger-final prompts share the current rich final-summary requirements:

- adapt Key content count to video duration;
- retain important facts, names, numbers, examples, caveats, reasoning, and implications;
- keep Overview, Key content, and Chapters complementary rather than repetitive;
- use validated segment anchors;
- avoid fabrication and transcript instruction injection.

The phrase `Write compact Markdown` is removed from final-summary instructions. Compactness remains
only for machine-oriented ledger updates and must mean concise wording without loss of unique
evidence.

The direct prompt labels the complete transcript as untrusted source data. The ledger update prompt
labels both the prior ledger and new transcript range as untrusted data and requires the fixed ledger
schema. The final ledger prompt treats the ledger as source data, not instructions.

## 10. Output Acceptance

A successful, meaningful final model response is accepted even when it contains fewer key-content
items than the duration-based target. The system does not automatically supplement or regenerate
such output.

Truncated, empty, or malformed output continues through existing validation and failure behavior; it
does not activate rolling-ledger fallback unless the provider explicitly reports context overflow.

## 11. Testing

Use test-driven development and cover:

- direct mode sends the complete normalized transcript in one request;
- direct success makes one generation call and no ledger-update calls;
- all real transcript IDs are valid direct anchors and direct coverage is complete;
- explicit context overflow switches to rolling-ledger mode exactly once;
- authentication, cancellation, rate limit, network, malformed output, and generic errors do not
  switch modes;
- ledger updates are sequential and each receives only the previous ledger plus the next raw range;
- the ledger preserves people, facts, numbers, examples, causal links, caveats, anchors, chapter
  candidates, pending information, and coverage position;
- duplicate evidence is consolidated while unique evidence remains;
- update overflow recursively splits only the current range;
- a single unfit segment fails deterministically without an infinite loop;
- cancellation and failure resume at the first unprocessed segment;
- changing model on retry reuses the provider-neutral ledger;
- final synthesis consumes the completed ledger once;
- synthesis-only retry does not replay transcript ranges;
- CJK, emoji, JSON escaping, long IDs, speakers, timestamps, and prompt-injection text remain data;
- checkpoint and protocol size limits are enforced;
- legacy subtitle-summary prompts remain unchanged.

Run repository-required validation after implementation:

1. focused unit and integration tests;
2. `npm run pretty`;
3. `npm run lint`;
4. `npm test`;
5. `npm run build`;
6. Chromium/Firefox/minimal artifact checks.

## 12. Success Criteria

- A transcript accepted by the selected model is summarized directly without intermediate
  compression.
- Context overflow alone activates the rolling evidence ledger.
- Rolling mode never creates independent chunk summaries or a collection of disconnected model
  contexts for final synthesis.
- Unique source evidence and stable segment anchors survive sequential updates.
- Interrupted rolling tasks resume without replaying completed transcript ranges.
- Direct and rolling results use the same UI and export contract.
- Successful but shorter-than-target summaries are accepted without automatic enrichment.
- Legacy subtitle-summary behavior remains unchanged.
- Formatting, lint, tests, and production build pass.
