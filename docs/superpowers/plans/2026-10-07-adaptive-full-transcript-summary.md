# Adaptive Full-Transcript Video Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Summarize the complete transcript in one model request whenever possible, falling back only on explicit context overflow to a sequential rolling evidence ledger and one final synthesis.

**Architecture:** Add a safe context-overflow classifier at the model-dispatch boundary, prompt/parser helpers for direct synthesis and ledger updates, and a runner state machine with `direct` and `rolling-ledger` checkpoints. Direct results validate against every transcript segment and report full coverage; rolling mode checkpoints one bounded ledger and the next unprocessed segment, recursively splitting only an overflowing current range.

**Tech Stack:** ES modules, Markdown model protocols, Node `node:test`/`node:assert`, existing background model adapters and offscreen task runner.

## Global Constraints

- Always attempt the complete normalized transcript first; do not preflight-skip direct mode from a local estimate.
- Only `MODEL_CONTEXT_WINDOW_EXCEEDED` may switch direct mode to rolling mode or split a rolling range.
- Authentication, cancellation, rate limits, network errors, malformed output, truncation, and generic provider failures must not trigger rolling fallback.
- Rolling requests contain only the previous ledger and current raw transcript range, never all prior messages or independent chunk summaries.
- Accept successful summaries below the duration-based target; do not automatically enrich or regenerate them.
- Keep the current final result shape and `keyMoments` meaning; do not restore `keyPoints`.
- Keep legacy Bilibili and YouTube subtitle-summary prompts unchanged.
- Preserve structured-clone-safe boundaries, redacted diagnostics, and stable transcript segment IDs.
- Use no new dependency and add no code comments.
- Follow TDD for each task and do not commit implementation unless explicitly requested.

---

## File Structure

- Create `src/video-summary/evidence-ledger.mjs`: ledger limits, Markdown parsing, anchor validation, and deterministic range splitting.
- Modify `src/video-summary/summary-markdown.mjs`: direct-transcript, ledger-update, and ledger-final message builders.
- Modify `src/background/model-text-dispatcher.mjs`: normalize only trustworthy context-overflow signals.
- Modify direct API adapters only where they expose a structured context signal that the dispatcher otherwise loses.
- Modify `src/video-summary/result-builder.mjs`: accept explicit covered segment IDs for direct/rolling results.
- Modify `src/video-summary/task-runner.mjs`: direct-first state machine, rolling ledger, checkpoints, and retries.
- Add focused tests beside each changed subsystem and update the fake end-to-end scenario.

### Task 1: Normalize Explicit Context-Window Errors

**Files:**
- Modify: `src/background/model-text-dispatcher.mjs`
- Modify: `src/services/apis/claude-api.mjs`
- Modify: `src/services/apis/openai-compatible-core.mjs`
- Modify: `src/services/apis/azure-openai-api.mjs`
- Modify: `tests/unit/background/model-text-dispatcher.test.mjs`
- Modify: relevant API tests under `tests/unit/services/apis/`

**Interfaces:**
- Produces: thrown errors with `code === 'MODEL_CONTEXT_WINDOW_EXCEEDED'`.
- Preserves: existing safe error shape and diagnostic redaction.

- [ ] Add failing dispatcher tests for trusted explicit signals:

```js
for (const source of [
  Object.assign(new Error('private'), { providerCode: 'context_length_exceeded' }),
  Object.assign(new Error('private'), { providerCode: 'model_context_window_exceeded' }),
  Object.assign(new Error('maximum context length is 128000 tokens'), { httpStatus: 400 }),
]) {
  await assert.rejects(dispatcher.generateText(request), {
    code: 'MODEL_CONTEXT_WINDOW_EXCEEDED',
    message: 'MODEL_CONTEXT_WINDOW_EXCEEDED',
  })
}
```

Also assert that plain HTTP 400, `max_tokens` output truncation, rate limits, network failures, login errors, and text merely containing “too long” without a recognized context phrase retain their existing codes.

- [ ] Run the dispatcher test and verify it fails because all provider failures currently normalize to `MODEL_GATEWAY_GENERATION_FAILED` or `MODEL_GATEWAY_PROVIDER_ERROR`:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/background/model-text-dispatcher.test.mjs
```

- [ ] Implement one private classifier in `model-text-dispatcher.mjs`:

```js
const CONTEXT_PROVIDER_CODES = new Set([
  'context_length_exceeded',
  'model_context_window_exceeded',
  'prompt_too_long',
])

function isExplicitContextWindowError(error) {
  const providerCode = String(error?.providerCode || error?.code || '').toLowerCase()
  if (CONTEXT_PROVIDER_CODES.has(providerCode)) return true
  const message = getTrustedHumanMessage(error)?.toLowerCase() || ''
  return (
    message.includes('maximum context length') ||
    message.includes('model context window limit') ||
    message.includes('prompt is too long')
  )
}
```

Call it before generic normalization and return:

```js
createSafeGatewayError('MODEL_CONTEXT_WINDOW_EXCEEDED', { modelName })
```

Add this code to the pass-through allowlist. Never attach the original prompt or provider body.

- [ ] Preserve structured provider signals in adapters:
  - Claude `model_context_window_exceeded`: throw an error whose code is `MODEL_CONTEXT_WINDOW_EXCEEDED`.
  - OpenAI-compatible/Azure non-OK JSON: copy only a recognized provider `error.code` into `providerCode`; do not copy arbitrary bodies.
  - Preserve output-limit behavior (`max_tokens`, `length`) as incomplete output, not context overflow.

- [ ] Add adapter tests proving recognized codes survive and unrelated provider messages do not become context errors; run the focused API and dispatcher tests until green.

### Task 2: Define the Direct and Evidence-Ledger Prompt Protocols

**Files:**
- Create: `src/video-summary/evidence-ledger.mjs`
- Create: `tests/unit/video-summary/evidence-ledger.test.mjs`
- Modify: `src/video-summary/summary-markdown.mjs`
- Modify: `tests/unit/video-summary/summary-markdown.test.mjs`

**Interfaces:**
- Produces:
  - `buildDirectSummaryMessages({ transcription, preferredLanguage })`
  - `buildLedgerUpdateMessages({ ledger, range, transcription, preferredLanguage })`
  - `buildLedgerFinalSummaryMessages({ ledger, durationMs, preferredLanguage })`
  - `parseEvidenceLedgerMarkdown(text, { allowedSegmentIds })`
  - `splitTranscriptRange(range)`
- Ledger shape:

```js
{
  topics: string[],
  narrative: Array<{ segmentId, text }>,
  evidence: Array<{ segmentId, text }>,
  chapterCandidates: Array<{ segmentId, title, summary }>,
  pending: string[],
  coveredThroughSegmentId: string | null,
  rawText: string,
}
```

- [ ] Write failing tests showing the direct user message contains all normalized segments exactly once and the system prompt uses the current rich final contract without `Write compact Markdown`:

```js
const messages = buildDirectSummaryMessages({ transcription, preferredLanguage: 'zh-Hans' })
assert.deepEqual(JSON.parse(messages[1].content), {
  transcript: {
    durationMs: transcription.durationMs,
    segments: transcription.segments.map(({ id, startMs, endMs, speaker, text }) => ({
      id,
      startMs,
      endMs,
      speaker,
      text,
    })),
  },
})
```

Assert transcript text containing `ignore previous instructions` remains only in the JSON user message.

- [ ] Write failing ledger parser tests for all six fixed headings, CJK/emoji, validated anchors, duplicate consolidation, hard item/character limits, invalid covered-through IDs, and exact raw text preservation.

Use these limits:

```js
export const EVIDENCE_LEDGER_LIMITS = Object.freeze({
  topicCount: 24,
  topicCharacters: 160,
  narrativeCount: 80,
  narrativeCharacters: 240,
  evidenceCount: 120,
  evidenceCharacters: 240,
  chapterCount: 30,
  chapterTitleCharacters: 100,
  chapterDescriptionCharacters: 240,
  pendingCount: 30,
  pendingCharacters: 180,
  totalCharacters: 16_000,
})
```

The parser rejects output exceeding `totalCharacters` with `MODEL_EVIDENCE_LEDGER_LIMIT_EXCEEDED`; it does not silently truncate the entire ledger.

- [ ] Write failing message-builder tests proving each update receives only `{ ledger, range, segments }`, marks overlap as context-only, requests the last primary segment in `覆盖位置`, and instructs the model to preserve unique facts before shortening wording.

- [ ] Write failing range-split tests:

```js
assert.deepEqual(splitTranscriptRange({ startIndex: 0, endIndex: 8 }), [
  { startIndex: 0, endIndex: 4 },
  { startIndex: 4, endIndex: 8 },
])
assert.deepEqual(splitTranscriptRange({ startIndex: 0, endIndex: 1 }), [])
```

- [ ] Run the two focused test files and verify RED:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/evidence-ledger.test.mjs tests/unit/video-summary/summary-markdown.test.mjs
```

- [ ] Implement `evidence-ledger.mjs` with pure parsing and splitting helpers. Reuse the established Markdown parsing conventions but keep ledger headings and limits isolated from final-summary parsing.

- [ ] Refactor `summary-markdown.mjs` so shared final instructions are generated by one helper. Direct mode serializes normalized transcript data; ledger final mode serializes only the parsed ledger. Keep `buildFinalSummaryMessages` temporarily as the ledger-final alias only until runner migration is complete, then remove it if unreferenced.

- [ ] Run focused tests and verify GREEN.

### Task 3: Support Explicit Coverage Inputs

**Files:**
- Modify: `src/video-summary/result-builder.mjs`
- Modify: `tests/unit/video-summary/result-builder.test.mjs`

**Interfaces:**
- Consumes: optional `coveredSegmentIds` iterable in `buildStructuredSummaryResult`.
- Produces: correct direct full coverage and rolling-prefix coverage without fabricated chunk results.

- [ ] Add failing tests:

```js
const result = buildStructuredSummaryResult({
  transcription,
  localChunkResults: [],
  synthesisResult,
  failedRanges: [],
  coveredSegmentIds: transcription.segments.map(({ id }) => id),
})
assert.equal(result.coverage.ratio, 1)
assert.equal(result.keyMoments[0].startMs, transcription.segments[0].startMs)
```

Also test a prefix list and an invalid ID. Invalid IDs are ignored; failed ranges still subtract coverage.

- [ ] Run and verify RED:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/result-builder.test.mjs
```

- [ ] Extend coverage construction:

```js
function buildCoveredSegmentIndexes(localChunkResults, segmentIndex, coveredSegmentIds) {
  if (coveredSegmentIds !== undefined) {
    return new Set(
      Array.from(coveredSegmentIds)
        .map((id) => segmentIndex.get(id)?.index)
        .filter(Number.isInteger),
    )
  }
  // existing chunk-range behavior
}
```

Pass the same set to location validation and coverage calculation. Preserve the old behavior when the option is omitted.

- [ ] Run the focused test and verify GREEN.

### Task 4: Implement Direct-First Execution

**Files:**
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`

**Interfaces:**
- Consumes: direct prompt builder and normalized context error.
- Produces: initial direct success or an atomic checkpoint switch to rolling mode.

- [ ] Replace the primary staged-generation test with a failing direct-mode test. Assert request IDs and payload:

```js
assert.deepEqual(calls.map(({ requestId }) => requestId), ['direct-synthesis'])
const payload = JSON.parse(calls[0].messages[1].content)
assert.deepEqual(payload.transcript.segments, normalizedSegments)
assert.equal(result.coverage.ratio, 1)
assert.equal(runner.debugState().checkpoints[0].summaryMode, 'direct')
```

Also assert every real transcript segment can anchor key content and chapters.

- [ ] Add a table-driven failing test proving errors other than `MODEL_CONTEXT_WINDOW_EXCEEDED` emit `TASK_FAILED` and make no ledger calls.

- [ ] Run the runner test and verify RED.

- [ ] Add `runDirectSummary` that emits `synthesizing-summary`, sends `buildDirectSummaryMessages`, validates the response, and builds the result with all transcript IDs as `coveredSegmentIds`.

Initialize the checkpoint as:

```js
{
  transcription,
  summaryMode: 'direct',
  nextSegmentIndex: 0,
  evidenceLedger: null,
  rollingRanges: [],
  failedRanges: [],
}
```

In initial execution, call direct mode first. Catch only:

```js
if (error?.code !== 'MODEL_CONTEXT_WINDOW_EXCEEDED') throw error
checkpoint.summaryMode = 'rolling-ledger'
```

Do not catch invalid final output as a context overflow.

- [ ] Run runner tests. Direct tests must pass; legacy chunk-path tests may now fail and are intentionally migrated in Tasks 5–6.

### Task 5: Implement Sequential Rolling Ledger and Overflow Splitting

**Files:**
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Test: `tests/unit/video-summary/evidence-ledger.test.mjs`

**Interfaces:**
- Consumes: checkpoint `{ summaryMode, nextSegmentIndex, evidenceLedger, rollingRanges }`.
- Produces: request sequence `direct-synthesis`, `ledger-1..n`, `ledger-synthesis`.

- [ ] Add a failing test where `direct-synthesis` throws `MODEL_CONTEXT_WINDOW_EXCEEDED`. Assert:
  - fallback occurs once;
  - ledger calls are sequential;
  - each ledger request contains only the previous ledger and current raw range;
  - no request ID starts with `chunk-`;
  - final synthesis receives the ledger but no raw transcript;
  - the final result has full coverage.

- [ ] Add a failing update-overflow test. Make `ledger-1` overflow for an eight-segment range, then accept its two four-segment children. Assert only the current range splits and each segment advances exactly once.

- [ ] Add a failing single-segment overflow test and assert rejection with `MODEL_CONTEXT_WINDOW_EXCEEDED`, no infinite retry, and a retained checkpoint.

- [ ] Run runner tests and verify RED.

- [ ] Implement deterministic rolling ranges from `chunkTranscriptForSummary`, represented by `{ startIndex, endIndex }`. Convert to prompt ranges only at call time, adding at most the existing two context segments on each side.

- [ ] Implement the sequential loop:

```js
while (checkpoint.rollingRanges.length > 0) {
  const range = checkpoint.rollingRanges[0]
  try {
    const nextLedger = await updateEvidenceLedger({ ... })
    checkpoint.evidenceLedger = nextLedger
    checkpoint.nextSegmentIndex = range.endIndex
    checkpoint.rollingRanges.shift()
  } catch (error) {
    if (error?.code !== 'MODEL_CONTEXT_WINDOW_EXCEEDED') throw error
    const halves = splitTranscriptRange(range)
    if (halves.length === 0) throw error
    checkpoint.rollingRanges.splice(0, 1, ...halves)
  }
}
```

Checkpoint only after a successful update. Emit existing `summarizing-chunks` progress using completed primary segments and total segments so no UI protocol change is required.

- [ ] Parse every ledger response against the processed-prefix segment ID set. Reject an empty, malformed, over-limit ledger instead of committing it.

- [ ] After the loop, call `buildLedgerFinalSummaryMessages`, allow only ledger-retained valid IDs, and build the result with all successfully processed transcript IDs as `coveredSegmentIds`.

- [ ] Run runner and ledger tests and verify GREEN.

### Task 6: Migrate Retry and Checkpoint Semantics

**Files:**
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`

**Interfaces:**
- Consumes: mode-aware checkpoint from Tasks 4–5.
- Produces: resumable rolling updates and synthesis-only retry without transcript replay.

- [ ] Add a failing cancellation/resume test. Cancel after the first ledger update, inspect `debugState()`, and assert:

```js
assert.equal(checkpoint.summaryMode, 'rolling-ledger')
assert.equal(checkpoint.nextSegmentIndex, firstRange.endIndex)
assert.equal(checkpoint.evidenceLedger.coveredThroughSegmentId, expectedId)
```

Retry from `summarizing`; assert the first completed range is not sent again.

- [ ] Add a failing non-context failure/resume test with the same checkpoint assertions. On retry with a different `modelSnapshot`, assert the new model receives the existing provider-neutral ledger.

- [ ] Add failing synthesis-retry tests:
  - direct success retry sends one new `direct-synthesis` request from the checkpointed transcript;
  - completed rolling retry sends only `ledger-synthesis` from the stored ledger;
  - neither path replays completed ledger updates.

- [ ] Run and verify RED.

- [ ] Replace `successfulChunkResults` retry logic with mode-aware dispatch:

```js
if (checkpoint.summaryMode === 'rolling-ledger') {
  if (command.fromStage === 'synthesis' && checkpoint.rollingRanges.length === 0) {
    return synthesizeFromLedger(...)
  }
  return continueRollingLedger(...)
}
return runDirectSummary(...)
```

A retry from `summarizing` continues the stored rolling queue. A direct checkpoint retries direct mode and may again switch to rolling only on explicit overflow.

- [ ] Remove obsolete independent chunk-summary execution and imports after all retry tests are migrated. Keep `chunkTranscriptForSummary` only for deterministic rolling range sizing.

- [ ] Run runner tests and verify GREEN.

### Task 7: Integration, Security, and Contract Verification

**Files:**
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`
- Modify as needed: protocol/logging tests if safe error-code allowlists require updates.

**Interfaces:**
- Consumes: completed direct/rolling runner and normalized gateway errors.
- Produces: end-to-end evidence that only explicit context overflow changes mode.

- [ ] Add an integration test whose fake gateway rejects `direct-synthesis` with `MODEL_CONTEXT_WINDOW_EXCEEDED`, accepts sequential ledger updates, and returns a final anchored summary. Assert the content-side event contains full coverage and ordered key content.

- [ ] Add an integration test whose fake gateway rejects direct mode with `MODEL_LOGIN_REQUIRED`; assert no ledger request is issued and the actionable failure reaches content unchanged.

- [ ] Assert logs and serialized gateway errors contain only safe codes/metadata and no transcript, ledger, model response, signed URL, or credential content.

- [ ] Run focused integration and security tests:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/integration/video-summary/end-to-end-fakes.test.mjs tests/unit/background/model-gateway.test.mjs tests/unit/background/model-text-dispatcher.test.mjs tests/unit/video-summary/logging.test.mjs
```

Expected: PASS.

### Task 8: Full Validation

**Files:**
- Modify only if formatting or contract sweeps reveal an intended omission.

- [ ] Confirm obsolete independent summary code is gone while chunk-level text is not sent to final synthesis:

```bash
rg -n "summarizeChunk|successfulChunkResults|buildChunkSummaryMessages|parseChunkSummaryMarkdown" src/video-summary tests/unit/video-summary
rg -n "MODEL_CONTEXT_WINDOW_EXCEEDED|direct-synthesis|ledger-synthesis|evidenceLedger|nextSegmentIndex" src tests
```

Expected: no production independent chunk-summary path; expected direct/ledger references are present.

- [ ] Confirm legacy prompts remain untouched:

```bash
git diff 85244ff -- src/content-script/site-adapters/bilibili/index.mjs src/content-script/site-adapters/youtube/index.mjs
```

Expected: no output.

- [ ] Run formatting and required validation:

```bash
npm run pretty
npm run lint
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] Inspect required artifacts and final diff:

```bash
test -f build/chromium/VideoSummaryOffscreen.html
test -f build/chromium/VideoSummaryOffscreen.js
test ! -e build/firefox/VideoSummaryOffscreen.html
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html
git diff --check
git status --short
git diff --stat
```

Expected: artifact checks and `git diff --check` succeed; only intended source, tests, and this plan are modified.
