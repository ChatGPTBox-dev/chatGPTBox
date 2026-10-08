# Video Summary Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicate key-points/key-moments output with one richer, timestamped Key content section whose requested detail adapts to video duration.

**Architecture:** Keep compact chunk summaries and their internal `keyPoints`, but change final synthesis to emit only overview, key content, and chapters. Continue using the existing `keyMoments` structured-result field for key content, remove final-result `keyPoints` throughout consumers, and pass transcription duration into synthesis so the prompt can choose a 4–20 item target range.

**Tech Stack:** ES modules, Preact, i18next localization JSON, Node `node:test`/`node:assert`, Webpack 5.

## Global Constraints

- The legacy Bilibili and YouTube subtitle-summary prompts must remain unchanged.
- Keep `keyMoments` as the internal wire and persistence field; do not introduce `keyContents`.
- Remove final-result `keyPoints`; chunk-level `keyPoints` remain internal synthesis evidence.
- Duration ranges are: up to 10 minutes = 4–6, over 10 through 30 = 6–10, over 30 through 60 = 10–15, over 60 = 15–20.
- Target ranges must not become quotas: sparse material must not be padded or fabricated.
- Final key content must use validated segment anchors, remain deduplicated, and sort chronologically.
- Use no new dependencies and add no code comments.
- Follow TDD: add each focused test, run it and observe the expected failure, then implement.

---

## File Structure

- `src/video-summary/summary-markdown.mjs`: final prompt limits, duration-based target selection, headings, and parsing.
- `src/video-summary/task-runner.mjs`: pass transcription duration into initial and retry synthesis and omit `keyPoints` from transcript-only results.
- `src/video-summary/result-builder.mjs`: build the final contract without `keyPoints`; preserve candidate fallback for `keyMoments`.
- `src/video-summary/output-validity.mjs`: validate only current final semantic fields.
- `src/components/VideoSummaryView/index.jsx`: render one Key content section.
- `src/video-summary/markdown-export.mjs`: export one Key Content section.
- `src/content-script/video-summary-host.mjs`: include Key content in follow-up chat context.
- `src/_locales/{en,zh-hans,zh-hant}/main.json`: user-facing Key content label.
- Existing focused tests under `tests/unit/`: define and protect each behavior.

### Task 1: Adaptive Final Prompt and Parser

**Files:**
- Modify: `tests/unit/video-summary/summary-markdown.test.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Modify: `src/video-summary/summary-markdown.mjs`
- Modify: `src/video-summary/task-runner.mjs`

**Interfaces:**
- Consumes: transcription `durationMs` already stored in task checkpoints.
- Produces: `buildFinalSummaryMessages({ chunkResults, preferredLanguage, durationMs })` and final parsed shape `{ overview, chapters, keyMoments, rawText }`.

- [ ] **Step 1: Replace the final prompt test with duration-adaptive expectations**

In `tests/unit/video-summary/summary-markdown.test.mjs`, call:

```js
const messages = buildFinalSummaryMessages({
  chunkResults,
  preferredLanguage: 'en',
  durationMs: 45 * 60 * 1000,
})
```

Assert that the user JSON remains `{ chunkResults }`, and that the system prompt:

```js
assert.match(prompt, /## 整体摘要/)
assert.match(prompt, /## 关键内容\n- \[segment:<id>\] Key content\./)
assert.match(prompt, /## 章节/)
assert.match(prompt, /10–15 key-content items/)
assert.match(prompt, /do not pad|must not pad/i)
assert.match(prompt, /topic.*context.*argument|narrative.*evidence|examples.*conclusions.*implications/is)
assert.match(prompt, /key content.*claim|event.*evidence|example|reasoning|consequence/is)
assert.match(prompt, /overview.*synthesis.*key content.*timestamped.*chapters.*navigation/is)
assert.doesNotMatch(prompt, /## 核心要点|## 关键时刻/)
```

Also add a table-driven boundary test:

```js
for (const [durationMs, expected] of [
  [10 * 60 * 1000, '4–6'],
  [10 * 60 * 1000 + 1, '6–10'],
  [30 * 60 * 1000, '6–10'],
  [30 * 60 * 1000 + 1, '10–15'],
  [60 * 60 * 1000, '10–15'],
  [60 * 60 * 1000 + 1, '15–20'],
]) {
  const prompt = buildFinalSummaryMessages({ chunkResults: [], durationMs })[0].content
  assert.match(prompt, new RegExp(`${expected} key-content items`))
}
```

- [ ] **Step 2: Replace final parser tests with the new contract**

Use `## Key Content` and `## 关键内容` aliases and assert:

```js
assert.deepEqual(parseFinalSummaryMarkdown(rawText, options), {
  overview: 'Overall text',
  chapters: [
    { segmentId: 's1', title: 'Opening', summary: 'intro', anchored: true },
  ],
  keyMoments: [
    { segmentId: 's2', point: 'conclusion with evidence', anchored: true },
  ],
  rawText,
})
assert.equal('keyPoints' in parseFinalSummaryMarkdown(rawText, options), false)
```

Retain tests for unknown headings, unanchored entries, Unicode-safe truncation, deduplication, and the maximum item count, but change the final maximum assertions to 20 items and 240 characters. Leave all chunk-parser `keyPoints` assertions unchanged.

- [ ] **Step 3: Run the prompt/parser tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/summary-markdown.test.mjs
```

Expected: FAIL because `durationMs` does not affect the prompt, Key Content is not recognized, and final parsing still returns `keyPoints`.

- [ ] **Step 4: Implement the adaptive prompt and final parser**

In `src/video-summary/summary-markdown.mjs`:

```js
export const SUMMARY_TEXT_LIMITS = Object.freeze({
  chunkSummaryCharacters: 300,
  chunkPointCount: 5,
  chunkPointCharacters: 120,
  candidateCount: 5,
  candidateCharacters: 120,
  overviewCharacters: 1600,
  chapterCount: 20,
  chapterDescriptionCharacters: 300,
  keyMomentCount: 20,
  keyMomentCharacters: 240,
})

function keyContentTarget(durationMs) {
  if (durationMs <= 10 * 60 * 1000) return '4–6'
  if (durationMs <= 30 * 60 * 1000) return '6–10'
  if (durationMs <= 60 * 60 * 1000) return '10–15'
  return '15–20'
}
```

Replace final heading aliases with:

```js
['关键内容', 'keyMoments'],
['key content', 'keyMoments'],
```

Do not remove chunk aliases for `分块要点` or `chunk key points`. Return no final `keyPoints` property from `parseFinalSummaryMarkdown`.

Change the signature and final prompt:

```js
export function buildFinalSummaryMessages({ chunkResults, preferredLanguage, durationMs }) {
  const target = keyContentTarget(durationMs)
  return [
    {
      role: 'system',
      content: `${summaryInstructions(preferredLanguage)}
Synthesize the supplied compact chunk results in source order.
Use only validated candidate segment IDs supplied in the chunk results as anchors.
Write a rich but scannable summary grounded only in the source.
The overview should explain the topic and necessary context, follow the main argument or narrative, retain important evidence and examples, and state supported conclusions and implications.
Write ${target} key-content items when the source supports that many. Do not pad sparse material, repeat ideas, or invent details to reach the lower bound.
Each key-content item should combine an important claim or event with its relevant evidence, example, reasoning, or consequence.
Keep responsibilities distinct: the overview provides synthesis and narrative; key content captures the most important timestamped information; chapters provide navigation and structural progression.
Each chapter description should explain what the chapter covers and how it advances the video.
Preserve important facts, names, numbers, caveats, and examples. Avoid repetition across all sections.
Overview: at most ${SUMMARY_TEXT_LIMITS.overviewCharacters} characters.
Key content: at most ${SUMMARY_TEXT_LIMITS.keyMomentCount}, each at most ${SUMMARY_TEXT_LIMITS.keyMomentCharacters} characters.
Chapters: at most ${SUMMARY_TEXT_LIMITS.chapterCount}, each description at most ${SUMMARY_TEXT_LIMITS.chapterDescriptionCharacters} characters.
## 整体摘要
Overall summary.
## 关键内容
- [segment:<id>] Key content.
## 章节
- [segment:<id>] Chapter title — Description.`,
    },
    { role: 'user', content: JSON.stringify({ chunkResults }) },
  ]
}
```

Treat a missing, non-finite, or negative duration as 0 so the shortest range is used deterministically.

- [ ] **Step 5: Verify prompt/parser GREEN**

Run the focused summary-markdown command from Step 3. Expected: PASS.

- [ ] **Step 6: Add runner tests for duration propagation and transcript-only contract**

In `tests/unit/video-summary/task-runner.test.mjs`, update final fake responses to use:

```md
## Overview
Final overview
## Key Content
- [segment:s1] Important content with evidence
## Chapters
- [segment:s1] Opening — Opening summary
```

Capture the synthesis request and assert its system message contains the target matching the fixture transcription duration. Add assertions to a transcript-only/degraded case:

```js
assert.equal('keyPoints' in result, false)
assert.deepEqual(result.keyMoments, [])
```

- [ ] **Step 7: Run runner tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/task-runner.test.mjs
```

Expected: FAIL because synthesis does not pass duration and transcript-only results still contain `keyPoints`.

- [ ] **Step 8: Pass duration in both synthesis paths**

Extend `synthesizeSummary` to consume `transcription` and pass:

```js
messages: buildFinalSummaryMessages({
  chunkResults: localChunkResults,
  preferredLanguage: command.settingsSnapshot?.preferredLanguage,
  durationMs: transcription.durationMs,
}),
```

Pass the current transcription from both call sites:

```js
transcription,
```

and:

```js
transcription: checkpoint.transcription,
```

Remove `keyPoints: []` from `createTranscriptOnlyResult`.

- [ ] **Step 9: Verify runner GREEN and commit**

Run both focused test files. Expected: PASS.

```bash
git add src/video-summary/summary-markdown.mjs src/video-summary/task-runner.mjs tests/unit/video-summary/summary-markdown.test.mjs tests/unit/video-summary/task-runner.test.mjs
git commit -m "Improve adaptive video summary synthesis"
```

### Task 2: Remove Final Key Points from Domain Results

**Files:**
- Modify: `tests/unit/video-summary/result-builder.test.mjs`
- Modify: `tests/unit/video-summary/output-validity.test.mjs`
- Modify: `src/video-summary/result-builder.mjs`
- Modify: `src/video-summary/output-validity.mjs`

**Interfaces:**
- Consumes: final parsed `{ overview, chapters, keyMoments, rawText }` plus chunk candidate locations.
- Produces: structured result with `keyMoments` and no `keyPoints` property.

- [ ] **Step 1: Rewrite result-builder expectations**

Delete final-result assertions for `result.keyPoints`. Keep chunk fixture `keyPoints` only where they represent intermediate chunk data. Add to complete, degraded, and partial cases:

```js
assert.equal('keyPoints' in result, false)
```

Preserve and strengthen fallback verification:

```js
assert.deepEqual(result.keyMoments, [
  { segmentId: 's2', startMs: 1000, point: 'local candidate' },
  { segmentId: null, startMs: null, point: 'unanchored candidate' },
])
```

Add duplicate content with different segment IDs and expect one item, while preserving chronological output for distinct items:

```js
keyMoments: [
  { segmentId: 's4', point: 'Ending evidence' },
  { segmentId: 's1', point: 'Opening evidence' },
  { segmentId: 's2', point: 'Opening evidence' },
]
```

Expected output is s1 then s4.

- [ ] **Step 2: Update validity expectations**

In `tests/unit/video-summary/output-validity.test.mjs`, remove final `keyPoints` from `meaningfulOutputs` and add:

```js
assert.deepEqual(
  validateFinalSummaryOutput({
    parsed: { keyPoints: [{ point: 'obsolete' }] },
    finishReason: 'stop',
  }),
  { valid: false, reason: 'MODEL_OUTPUT_EMPTY' },
)
```

Leave chunk validity tests unchanged because chunk `keyPoints` are still active.

- [ ] **Step 3: Run focused domain tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/result-builder.test.mjs tests/unit/video-summary/output-validity.test.mjs
```

Expected: FAIL because the result builder still emits `keyPoints`, validity accepts it, and key moments deduplicate only by segment ID.

- [ ] **Step 4: Remove final key-point construction and strengthen key-content deduplication**

Delete `buildKeyPoints` and its invocation from `src/video-summary/result-builder.mjs`. Return:

```js
return {
  status,
  overview,
  rawSummaryText: String(synthesisResult?.rawText || '').trim(),
  keyMoments,
  chapters,
  transcriptSegments: segments.map((segment) => ({ ...segment })),
  coverage,
  warnings,
  failedRanges: normalizedFailedRanges,
}
```

Within `buildKeyMoments`, normalize point text for deduplication:

```js
const normalizedPoint = point.replace(/\s+/g, ' ').toLowerCase()
if (seenPoints.has(normalizedPoint)) continue
seenPoints.add(normalizedPoint)
```

Use separate `seenSegmentIds` and `seenPoints` sets so an identical semantic item is not repeated at another timestamp. Keep anchored items sorted before appending valid unanchored items.

In `src/video-summary/output-validity.mjs`, make final meaningful content:

```js
meaningful:
  hasText(parsed?.overview) ||
  anyText(parsed?.chapters, ['title', 'summary']) ||
  anyText(parsed?.keyMoments, ['point']),
```

- [ ] **Step 5: Verify GREEN and commit**

Run the focused domain tests. Expected: PASS.

```bash
git add src/video-summary/result-builder.mjs src/video-summary/output-validity.mjs tests/unit/video-summary/result-builder.test.mjs tests/unit/video-summary/output-validity.test.mjs
git commit -m "Remove duplicate video summary key points"
```

### Task 3: Present One Key Content Section

**Files:**
- Modify: `tests/unit/components/video-summary-view.test.mjs`
- Modify: `tests/unit/components/video-summary-markdown-sink.test.mjs`
- Modify: `src/components/VideoSummaryView/index.jsx`
- Modify: `src/_locales/en/main.json`
- Modify: `src/_locales/zh-hans/main.json`
- Modify: `src/_locales/zh-hant/main.json`

**Interfaces:**
- Consumes: `result.keyMoments`.
- Produces: one `data-section="key-content"` UI section labeled `Key content`.

- [ ] **Step 1: Change component tests to the single section**

Remove `keyPoints` from result fixtures. Put both anchored and unanchored examples into `keyMoments` and assert:

```js
assert.equal(container.querySelector('[data-section="key-points"]'), null)
assert.equal(container.querySelector('[data-section="key-moments"]'), null)
assert.equal(container.querySelectorAll('[data-section="key-content"] [data-seek-ms]').length, 1)
assert.match(container.querySelector('[data-section="key-content"]').textContent, /Key content/)
assert.match(container.textContent, /Anchored content/)
assert.match(container.textContent, /Unanchored content/)
```

Update the Markdown sink fixture to use only `keyMoments` while retaining its escaping assertions.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --import ./tests/setup/jsx-loader-hooks.mjs --test tests/unit/components/video-summary-view.test.mjs tests/unit/components/video-summary-markdown-sink.test.mjs
```

Expected: FAIL because the view still renders separate Key points and Key moments sections.

- [ ] **Step 3: Render and localize Key content**

In `src/components/VideoSummaryView/index.jsx`, remove the `keyPoints` variable and its block. Replace the key-moments block with:

```jsx
{keyMoments.length > 0 ? (
  <details data-section="key-content">
    <summary>{t('Key content')}</summary>
    <ul>
      {keyMoments.map((item) => (
        <li key={`${item.point}-${item.startMs}`}>
          {Number.isFinite(item.startMs) ? (
            <TimestampButton
              startMs={item.startMs}
              label={timestampLabel(item.startMs, null, t('Unknown'))}
              onSeekTo={onSeekTo}
            />
          ) : null}
          <span>{item.point}</span>
        </li>
      ))}
    </ul>
  </details>
) : null}
```

Replace obsolete locale keys with:

```json
"Key content": "Key content"
```

```json
"Key content": "关键内容"
```

```json
"Key content": "關鍵內容"
```

Keep `Chapters` and `Transcript` unchanged.

- [ ] **Step 4: Verify GREEN and commit**

Run the component tests from Step 2. Expected: PASS.

```bash
git add src/components/VideoSummaryView/index.jsx src/_locales/en/main.json src/_locales/zh-hans/main.json src/_locales/zh-hant/main.json tests/unit/components/video-summary-view.test.mjs tests/unit/components/video-summary-markdown-sink.test.mjs
git commit -m "Unify video summary key content display"
```

### Task 4: Update Export and Follow-up Context

**Files:**
- Modify: `tests/unit/video-summary/markdown-export.test.mjs`
- Modify: `tests/unit/content-script/video-summary-host.test.mjs`
- Modify: `src/video-summary/markdown-export.mjs`
- Modify: `src/content-script/video-summary-host.mjs`

**Interfaces:**
- Consumes: current structured result without `keyPoints`.
- Produces: Markdown `## Key Content` and follow-up prompt `Key content:`.

- [ ] **Step 1: Rewrite Markdown export tests**

Remove `keyPoints` from fixtures. Assert:

```js
assert.match(markdown, /## Key Content/)
assert.match(markdown, /- 00:01: Anchored content/)
assert.match(markdown, /- Unanchored content/)
assert.doesNotMatch(markdown, /## Key Points|## Key Moments/)
```

Keep offset, escaping, raw fallback, chapter, and transcript assertions unchanged.

- [ ] **Step 2: Add a follow-up prompt behavior test**

In `tests/unit/content-script/video-summary-host.test.mjs`, complete a task with:

```js
result: {
  status: 'complete',
  overview: 'Overview',
  keyMoments: [
    { segmentId: 's1', startMs: 1000, point: 'Claim with supporting evidence' },
  ],
  chapters: [],
  transcriptSegments: [],
}
```

Invoke `props.onAskAboutVideo()`, inspect the latest captured toolbar prop/prompt, and assert:

```js
assert.match(prompt, /Key content:/)
assert.match(prompt, /Claim with supporting evidence/)
assert.doesNotMatch(prompt, /Key points:/)
```

Use the existing loader-hook capture rather than exporting `buildAskPrompt` solely for testing.

- [ ] **Step 3: Run export and host tests and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/markdown-export.test.mjs
node --import ./tests/setup/browser-shim.mjs --import ./tests/setup/jsx-loader-hooks.mjs --test tests/unit/content-script/video-summary-host.test.mjs
```

Expected: FAIL because export emits Key Points/Key Moments and follow-up context reads `keyPoints`.

- [ ] **Step 4: Update both consumers**

In `src/video-summary/markdown-export.mjs`, use:

```js
const sections = [
  renderLocatedPoints('Key Content', result?.keyMoments),
  renderChapters(result?.chapters),
  renderTranscript(result?.transcriptSegments),
].filter(Boolean)
```

In `src/content-script/video-summary-host.mjs`, replace the key-point lines with:

```js
'Key content:',
...((Array.isArray(result?.keyMoments) ? result.keyMoments : []).map(
  (item) => `- ${String(item?.point || '').trim()}`,
) || ['- None']),
```

Do not alter legacy site-adapter prompt strings.

- [ ] **Step 5: Verify GREEN and commit**

Run both commands from Step 3. Expected: PASS.

```bash
git add src/video-summary/markdown-export.mjs src/content-script/video-summary-host.mjs tests/unit/video-summary/markdown-export.test.mjs tests/unit/content-script/video-summary-host.test.mjs
git commit -m "Use key content in video summary outputs"
```

### Task 5: Contract Sweep and Full Validation

**Files:**
- Modify as required: remaining enhanced-pipeline fixtures under `tests/unit/video-summary/` and `tests/unit/components/`
- Do not modify: legacy prompt construction in `src/content-script/site-adapters/bilibili/index.mjs` or `src/content-script/site-adapters/youtube/index.mjs`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: repository-wide consistency and validated production artifacts.

- [ ] **Step 1: Search for obsolete final-result references**

Run:

```bash
rg -n "keyPoints|Key points|Key Points|Key moments|Key Moments" src tests/unit
```

Expected remaining production references:

- chunk parsing and chunk validity in `summary-markdown.mjs`, `task-runner.mjs`, and `output-validity.mjs`;
- local chunk test fixtures and assertions.

No production reference may read or emit `result.keyPoints`, `synthesisResult.keyPoints`, the old final headings, or the old UI locale labels. Update remaining final-response fixtures in `task-runner.test.mjs` to `## Key Content` and remove final-result `keyPoints` assertions.

- [ ] **Step 2: Run all focused video-summary tests**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/*.test.mjs
node --import ./tests/setup/browser-shim.mjs --import ./tests/setup/jsx-loader-hooks.mjs --test tests/unit/components/video-summary-view.test.mjs tests/unit/components/video-summary-markdown-sink.test.mjs tests/unit/content-script/video-summary-host.test.mjs
```

Expected: all tests PASS with no warnings or unhandled rejections.

- [ ] **Step 3: Format the repository**

Run:

```bash
npm run pretty
```

Expected: exit 0. Review `git diff --stat` and ensure only intended source, test, locale, and plan files changed.

- [ ] **Step 4: Run required static and unit validation**

Run:

```bash
npm run lint
npm test
```

Expected: both commands exit 0.

- [ ] **Step 5: Run the production build**

Run:

```bash
npm run build
```

Expected: exit 0 and all Chromium/Firefox full and minimal variants build successfully.

- [ ] **Step 6: Confirm legacy prompts were untouched and inspect artifacts**

Run:

```bash
git diff a333b27 -- src/content-script/site-adapters/bilibili/index.mjs src/content-script/site-adapters/youtube/index.mjs
test -f build/chromium/VideoSummaryOffscreen.html
test -f build/chromium/VideoSummaryOffscreen.js
test ! -e build/firefox/VideoSummaryOffscreen.html
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html
git diff --check
git status --short
```

Expected: no legacy adapter prompt diff, artifact checks exit 0, `git diff --check` prints nothing, and status lists only intended changes.

- [ ] **Step 7: Commit any final fixture/format updates**

If Step 1 or formatting changed tracked files:

```bash
git add src tests
git commit -m "Align video summary key content contract"
```

If no tracked files remain, do not create an empty commit.
