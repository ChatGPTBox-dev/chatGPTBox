# Bilibili Universal Free-Text Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bilibili video-summary tool calls with bounded, tolerant Markdown generation that works through every currently configurable AI execution family while preserving validated clickable segment anchors.

**Architecture:** Keep transcript acquisition and the offscreen task owner unchanged. Add a pure Markdown protocol/parser below `src/video-summary/`, change the runner to call a provider-neutral `generateText()` gateway, and route that call in the background through isolated synthetic ports and sessions backed by existing provider adapters. A dedicated per-request ChatGPT page-proxy port avoids ordinary chat's latest-request-wins state; local parsing and result construction remain deterministic.

**Tech Stack:** Node 22+, ES modules, Preact, `node:test`/`node:assert`, WebExtension ports, Chromium MV3 offscreen documents, existing provider adapters.

## Global Constraints

- Do not add dependencies, providers, model settings, permissions, or web-accessible resources.
- Do not send API keys, cookies, access tokens, refresh tokens, prompts, subtitles, or model answers into logs.
- Preserve structured-clone-safe messages and derive tab/document ownership from browser sender metadata.
- Keep ASR explicitly user-confirmed; do not change MediaKit submission, fallback, charging, or OPFS cleanup behavior.
- Never silently switch the selected model or provider.
- Keep Firefox, Safari, minimal builds, unsupported runtimes, and disabled settings on the existing legacy Bilibili flow.
- Use fixed content limits: chunk summary 300 characters; 5 chunk points of 120 characters; 5 candidates of 120 characters; final overview 600 characters; 12 final points of 150 characters; 20 chapters with 150-character descriptions; 15 key moments of 120 characters.
- Treat `[segment:<id>]` as the only machine-significant model syntax; trust only IDs found in the allowed local transcript set.
- Do not make an automatic model repair or continuation call.
- Follow TDD for every runtime change: write the focused failing test, run it and observe the expected failure, then implement the minimum production change.

---

## File Map

### New files

- `src/video-summary/summary-markdown.mjs` — prompts, fixed limits, tolerant Markdown parsing, and compact chunk serialization.
- `tests/unit/video-summary/summary-markdown.test.mjs` — pure protocol and parser coverage.
- `src/background/model-text-dispatcher.mjs` — isolated session/port adapter and routing across existing model execution families.
- `tests/unit/background/model-text-dispatcher.test.mjs` — shared dispatcher contract, cancellation, login errors, and content-redaction tests.
- `src/background/video-summary-chatgpt-proxy.mjs` — one-shot, request-scoped ChatGPT provider-page execution.
- `tests/unit/background/video-summary-chatgpt-proxy.test.mjs` — proxy correlation, page requirement, cancellation, and isolation tests.

### Modified files

- `src/video-summary/task-runner.mjs` — call `generateText()`, parse Markdown, apply separate chunk/final output caps, and retain checkpoints.
- `src/video-summary/result-builder.mjs` — consume parsed free-text entries and preserve unanchored chapters/moments.
- `src/video-summary/contracts.mjs` — allow `generateText` over offscreen RPC.
- `src/background/model-gateway.mjs` — replace tool invocation with injected provider-neutral text generation.
- `src/background/video-summary-offscreen-rpc.mjs` — forward the new gateway operation and safe actionable error metadata.
- `src/pages/VideoSummaryOffscreen/runtime.mjs` — expose `generateText()` to the offscreen runner.
- `src/background/index.mjs` — compose the dispatcher/proxy and inject them into `ModelGateway`.
- `src/services/apis/chatgpt-web.mjs`, `bing-web.mjs`, `claude-web.mjs`, `moonshot-web.mjs`, `bard-web.mjs`, `claude-api.mjs`, `azure-openai-api.mjs`, `waylaidwanderer-api.mjs` — accept optional isolated config or preserve completion behavior needed by the dispatcher without changing ordinary chat defaults.
- `src/components/BilibiliVideoSummaryView/index.jsx` — render unanchored entries without timestamp buttons and show actionable model errors.
- `src/video-summary/markdown-export.mjs` — export unanchored entries as readable text.
- `src/_locales/en/main.json`, `src/_locales/zh-hans/main.json`, `src/_locales/zh-hant/main.json` — user-facing temporary-condition and location warnings.
- Existing tests under `tests/unit/background/`, `tests/unit/pages/`, `tests/unit/video-summary/`, `tests/unit/components/`, and `tests/integration/video-summary/` — update contracts and add end-to-end Kimi/free-text cases.

---

### Task 1: Define and parse the bounded Markdown protocol

**Files:**
- Create: `src/video-summary/summary-markdown.mjs`
- Create: `tests/unit/video-summary/summary-markdown.test.mjs`

**Interfaces:**
- Produces: `SUMMARY_TEXT_LIMITS`, `buildChunkSummaryMessages({ chunk, transcription, preferredLanguage })`, `parseChunkSummaryMarkdown(text, { allowedSegmentIds })`, `buildFinalSummaryMessages({ chunkResults, preferredLanguage })`, and `parseFinalSummaryMarkdown(text, { allowedSegmentIds })`.
- Parsed chunk shape: `{ localSummary, keyPoints, candidates, rawText }`, where each candidate is `{ segmentId, text, anchored }`.
- Parsed final shape: `{ overview, keyPoints, chapters, keyMoments, rawText }`, where chapters are `{ segmentId, title, summary, anchored }` and moments are `{ segmentId, point, anchored }`.

- [ ] **Step 1: Write failing tests for prompts, localized aliases, anchors, and limits**

Create table-driven tests containing at least these assertions:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SUMMARY_TEXT_LIMITS,
  buildChunkSummaryMessages,
  buildFinalSummaryMessages,
  parseChunkSummaryMarkdown,
  parseFinalSummaryMarkdown,
} from '../../../src/video-summary/summary-markdown.mjs'

test('chunk protocol requests compact Markdown and only primary segment anchors', () => {
  const messages = buildChunkSummaryMessages({
    chunk: {
      primarySegmentIds: ['s2'],
      contextBeforeSegmentIds: ['s1'],
      contextAfterSegmentIds: ['s3'],
    },
    transcription: {
      segments: [
        { id: 's1', text: 'before' },
        { id: 's2', text: 'primary' },
        { id: 's3', text: 'after' },
      ],
    },
    preferredLanguage: 'zh-Hans',
  })
  const prompt = messages.map((message) => message.content).join('\n')
  assert.match(prompt, /## 分块摘要/)
  assert.match(prompt, /\[segment:<id>\]/)
  assert.match(prompt, /300/)
  assert.match(prompt, /5/)
  assert.match(prompt, /s1/)
  assert.match(prompt, /s2/)
  assert.match(prompt, /s3/)
  assert.match(prompt, /only.*primary|只能.*主区间/i)
})

test('final parser preserves unanchored text and validates known IDs', () => {
  const parsed = parseFinalSummaryMarkdown(
    `Preface\n## Summary\nOverall text\n## Key Points\n- one\n## Chapters\n- [segment:s1] Opening — intro\n- [segment:invented] Invalid — retained\n- No marker — still retained\n## Key Moments\n- [segment:s2] conclusion`,
    { allowedSegmentIds: new Set(['s1', 's2']) },
  )
  assert.equal(parsed.overview, 'Overall text')
  assert.deepEqual(parsed.chapters, [
    { segmentId: 's1', title: 'Opening', summary: 'intro', anchored: true },
    { segmentId: null, title: 'Invalid', summary: 'retained', anchored: false },
    { segmentId: null, title: 'No marker', summary: 'still retained', anchored: false },
  ])
  assert.deepEqual(parsed.keyMoments, [
    { segmentId: 's2', point: 'conclusion', anchored: true },
  ])
  assert.equal(parsed.rawText.includes('Preface'), true)
})

test('parser enforces every fixed item and character limit locally', () => {
  assert.deepEqual(SUMMARY_TEXT_LIMITS, {
    chunkSummaryCharacters: 300,
    chunkPointCount: 5,
    chunkPointCharacters: 120,
    candidateCount: 5,
    candidateCharacters: 120,
    overviewCharacters: 600,
    keyPointCount: 12,
    keyPointCharacters: 150,
    chapterCount: 20,
    chapterDescriptionCharacters: 150,
    keyMomentCount: 15,
    keyMomentCharacters: 120,
  })
  const text = `## 整体摘要\n${'甲'.repeat(700)}\n## 核心要点\n${Array.from(
    { length: 14 },
    (_, index) => `- ${index}-${'乙'.repeat(170)}`,
  ).join('\n')}`
  const parsed = parseFinalSummaryMarkdown(text, { allowedSegmentIds: new Set() })
  assert.equal(parsed.overview.length, 600)
  assert.equal(parsed.keyPoints.length, 12)
  assert.equal(parsed.keyPoints.every((point) => point.length <= 150), true)
})
```

Also test multiline chapter descriptions, reordered/missing sections, duplicate IDs, duplicate text,
truncation mid-section, article-only output, Chinese/English headings, and disallowed context IDs.

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/summary-markdown.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `summary-markdown.mjs`.

- [ ] **Step 3: Implement the pure parser and prompt builders**

Use immutable limits and small helpers rather than a general Markdown dependency:

```js
export const SUMMARY_TEXT_LIMITS = Object.freeze({
  chunkSummaryCharacters: 300,
  chunkPointCount: 5,
  chunkPointCharacters: 120,
  candidateCount: 5,
  candidateCharacters: 120,
  overviewCharacters: 600,
  keyPointCount: 12,
  keyPointCharacters: 150,
  chapterCount: 20,
  chapterDescriptionCharacters: 150,
  keyMomentCount: 15,
  keyMomentCharacters: 120,
})

const HEADING_ALIASES = new Map([
  ['分块摘要', 'localSummary'],
  ['chunk summary', 'localSummary'],
  ['分块要点', 'localPoints'],
  ['chunk key points', 'localPoints'],
  ['候选定位', 'candidates'],
  ['candidate locations', 'candidates'],
  ['整体摘要', 'overview'],
  ['摘要', 'overview'],
  ['overview', 'overview'],
  ['summary', 'overview'],
  ['核心要点', 'keyPoints'],
  ['要点', 'keyPoints'],
  ['key points', 'keyPoints'],
  ['章节', 'chapters'],
  ['chapters', 'chapters'],
  ['关键时刻', 'keyMoments'],
  ['key moments', 'keyMoments'],
])

const SEGMENT_MARKER = /\[segment:([^\]\s]+)\]/i

function clampText(value, maximum) {
  return Array.from(String(value || '').trim()).slice(0, maximum).join('')
}

function resolveAnchor(line, allowedSegmentIds) {
  const match = line.match(SEGMENT_MARKER)
  const candidate = match?.[1] || null
  return {
    segmentId: candidate && allowedSegmentIds.has(candidate) ? candidate : null,
    anchored: Boolean(candidate && allowedSegmentIds.has(candidate)),
    text: line.replace(SEGMENT_MARKER, '').replace(/^[-*]\s*/, '').trim(),
  }
}
```

Split the response by ATX headings, parse known sections independently, and preserve `rawText`
verbatim. Parse chapter title/description around `—`, `-`, `:` or a following indented line. Clamp
and deduplicate after parsing. Prompt builders must JSON-stringify only transcript/chunk data inside
a fenced-free user message and put the fixed Markdown template and constraints in the system
message.

- [ ] **Step 4: Run the parser test and verify GREEN**

Run the command from Step 2. Expected: all tests PASS.

- [ ] **Step 5: Commit the protocol**

```bash
git add src/video-summary/summary-markdown.mjs tests/unit/video-summary/summary-markdown.test.mjs
git commit -m "Add tolerant Bilibili summary Markdown protocol"
```

---

### Task 2: Build deterministic results from free-text entries

**Files:**
- Modify: `src/video-summary/result-builder.mjs`
- Modify: `tests/unit/video-summary/result-builder.test.mjs`

**Interfaces:**
- Consumes parsed chunk/final shapes from Task 1.
- `buildStructuredSummaryResult()` continues returning the existing result contract and adds
  `rawSummaryText`; unanchored chapters/moments have null segment/time fields.

- [ ] **Step 1: Add failing result-builder tests**

Add a test that supplies one anchored and one unanchored chapter/moment:

```js
test('preserves unanchored free-text entries without inventing timestamps', () => {
  const result = buildStructuredSummaryResult({
    transcription: createTranscription(),
    localChunkResults: [
      {
        primaryStartSegmentId: 's1',
        primaryEndSegmentId: 's3',
        localSummary: 'local',
        keyPoints: ['local point'],
        candidates: [],
      },
    ],
    synthesisResult: {
      overview: 'final',
      rawText: 'raw private answer',
      keyPoints: ['point'],
      chapters: [
        { segmentId: 's1', title: 'Anchored', summary: 'a', anchored: true },
        { segmentId: null, title: 'Unanchored', summary: 'b', anchored: false },
      ],
      keyMoments: [
        { segmentId: 's2', point: 'Jump', anchored: true },
        { segmentId: null, point: 'Read only', anchored: false },
      ],
    },
    failedRanges: [],
  })
  assert.equal(result.rawSummaryText, 'raw private answer')
  assert.deepEqual(result.chapters[1], {
    startSegmentId: null,
    endSegmentId: null,
    startMs: null,
    endMs: null,
    title: 'Unanchored',
    summary: 'b',
  })
  assert.deepEqual(result.keyMoments[1], {
    segmentId: null,
    startMs: null,
    point: 'Read only',
  })
})
```

Add cases for final-output absence (local summaries/points/candidates are used), invalid anchors not
changing `complete` to `partial`, and `rawSummaryText` fallback.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/result-builder.test.mjs
```

Expected: FAIL because the builder expects `chapterStarts` and drops unanchored entries.

- [ ] **Step 3: Update result construction**

Replace schema-specific candidate access with parsed fields. Resolve an anchored item only through
the transcript index; append unanchored items after anchored items in their model order. Compute
chapter end times only among anchored chapters. Set:

```js
return {
  status,
  overview,
  rawSummaryText: String(synthesisResult?.rawText || '').trim(),
  keyPoints,
  keyMoments,
  chapters,
  transcriptSegments: segments.map((segment) => ({ ...segment })),
  coverage,
  warnings,
  failedRanges: normalizedFailedRanges,
}
```

Use a stable warning code such as `VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE` when the text
contains unanchored entries. Do not put raw model text into warning values.

- [ ] **Step 4: Verify builder and export-adjacent tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/result-builder.test.mjs \
  tests/unit/video-summary/markdown-export.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video-summary/result-builder.mjs tests/unit/video-summary/result-builder.test.mjs
git commit -m "Build video results from tolerant text summaries"
```

---

### Task 3: Convert the task runner from tool calls to staged text generation

**Files:**
- Modify: `src/video-summary/task-runner.mjs`
- Modify: `tests/unit/video-summary/task-runner.test.mjs`
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`

**Interfaces:**
- Consumes Task 1 prompt/parser functions and `modelGateway.generateText(args)`.
- Uses fixed request caps `CHUNK_MAX_OUTPUT_TOKENS = 1200` and
  `FINAL_MAX_OUTPUT_TOKENS = 4000`, each clamped to gateway/user capability.
- Checkpoints store parsed provider-neutral chunk results and raw text, never provider sessions.

- [ ] **Step 1: Replace tool-oriented test fakes with failing text expectations**

In `task-runner.test.mjs`, make the gateway return Markdown:

```js
const calls = []
const modelGateway = {
  async describeCapabilities() {
    return { supported: true, inputTokenBudget: 20, maxOutputTokens: 20_000 }
  },
  async generateText(args) {
    calls.push(args)
    if (args.requestId.startsWith('chunk-')) {
      return {
        text: `## Chunk Summary\nlocal ${args.requestId}\n## Chunk Key Points\n- point\n## Candidate Locations\n- [segment:s1] candidate`,
        finishReason: 'stop',
      }
    }
    return {
      text: '## Overview\nfinal\n## Key Points\n- point\n## Chapters\n- [segment:s1] Opening — intro\n## Key Moments\n- [segment:s2] moment',
      finishReason: 'stop',
    }
  },
  cancel() {},
}
```

Assert:

```js
assert.equal(calls.some((call) => 'tool' in call), false)
assert.deepEqual(calls.map((call) => call.maxOutputTokens), [1200, 1200, 4000])
assert.equal(calls.at(-1).messages.some((message) => message.content.includes('segment 1')), false)
assert.equal(result.chapters[0].startMs, 0)
```

Add tests for article-only final output, synthesis failure fallback, one failed chunk, a
`temporarilyUnavailable` capability result producing `TASK_FAILED` with a checkpoint, and
`finishReason: 'length'` preserving parseable content with a degraded/partial warning.

- [ ] **Step 2: Run runner tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/video-summary/task-runner.test.mjs
```

Expected: FAIL because `invokeTool()` is called and text parsing is absent.

- [ ] **Step 3: Implement staged text generation**

In `task-runner.mjs`:

```js
import {
  buildChunkSummaryMessages,
  buildFinalSummaryMessages,
  parseChunkSummaryMarkdown,
  parseFinalSummaryMarkdown,
} from './summary-markdown.mjs'

const CHUNK_MAX_OUTPUT_TOKENS = 1200
const FINAL_MAX_OUTPUT_TOKENS = 4000

function clampOutputTokens(capabilities, requested) {
  const advertised = Number.isFinite(capabilities?.maxOutputTokens)
    ? capabilities.maxOutputTokens
    : requested
  return Math.max(1, Math.min(requested, advertised))
}
```

Replace `invokeToolOnce()` with `generateTextOnce()` that calls `modelGateway.generateText()`, keeps
the existing task/request cancellation mapping, and returns `{ text, finishReason }`. Parse chunk
responses with only `new Set(chunk.primarySegmentIds)`. Build final allowed IDs from validated
chunk candidates, not all transcript IDs. Parse final responses with that set.

When capability state is temporary/unavailable before generation, throw an error carrying the
capability code so `TASK_FAILED` retains the transcript checkpoint. Do not emit a transcript-only
`TASK_RESULT` for model unavailability. When final generation throws, use local chunks; when it
returns length-truncated text, parse it, preserve it, and add `MODEL_OUTPUT_INCOMPLETE` to warnings.

Update retry behavior:

- `fromStage: 'synthesis'` calls only final generation with stored chunks.
- `fromStage: 'summarizing'` reruns only failed ranges when failed ranges exist; otherwise reruns all
  chunks, then synthesis.
- Keep the existing accepted retry-stage strings for protocol compatibility.

- [ ] **Step 4: Verify unit and fake end-to-end tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
```

Expected: PASS, with no `invokeTool`/tool name assertions remaining in these files.

- [ ] **Step 5: Commit**

```bash
git add src/video-summary/task-runner.mjs \
  tests/unit/video-summary/task-runner.test.mjs \
  tests/integration/video-summary/end-to-end-fakes.test.mjs
git commit -m "Use staged free-text video summaries"
```

---

### Task 4: Change the offscreen RPC contract to `generateText`

**Files:**
- Modify: `src/video-summary/contracts.mjs`
- Modify: `src/pages/VideoSummaryOffscreen/runtime.mjs`
- Modify: `src/background/video-summary-offscreen-rpc.mjs`
- Modify: `tests/unit/video-summary/contracts.test.mjs`
- Modify: `tests/unit/pages/video-summary-offscreen-runtime.test.mjs`
- Modify: `tests/unit/background/video-summary-offscreen-rpc.test.mjs`

**Interfaces:**
- Replaces the allowed model operation `invokeTool` with `generateText`.
- RPC success result: `{ text: string, finishReason: string|null }`.
- RPC error may include safe `condition: 'login-required'|'provider-page-required'|'temporary'|null`
  and `modelName`, but never raw provider responses.

- [ ] **Step 1: Write failing RPC tests**

Change the runtime test to call:

```js
const generationPromise = runtime.modelGateway.generateText({
  requestId: 'chunk-1',
  taskId: 'task-6',
  modelSnapshot: { modelName: 'moonshotWebFree' },
  messages: [{ role: 'user', content: 'private prompt' }],
  maxOutputTokens: 1200,
})
```

Assert the RPC operation is `generateText` and contains no `tool`. In the background RPC test,
assert `invokeTool` is rejected by the allowlist and `generateText` is forwarded. Add an error test:

```js
assert.deepEqual(response.error, {
  code: 'MODEL_LOGIN_REQUIRED',
  operation: 'generateText',
  httpStatus: null,
  providerCode: null,
  retryAfterMs: null,
  condition: 'login-required',
  modelName: 'moonshotWebFree',
})
```

- [ ] **Step 2: Run the RPC tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/video-summary/contracts.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs
```

Expected: FAIL because `generateText` is not allowlisted/exposed.

- [ ] **Step 3: Implement the narrow RPC change**

Set:

```js
model: Object.freeze(['describeCapabilities', 'generateText', 'cancel'])
```

Expose `runtimeModelGateway.generateText(args)` exactly as `invokeTool` was exposed. Extend
`serializeGatewayError()` with allowlisted `condition` and `modelName` values only; continue using
`toSafeCode()` for the error code. Do not serialize `message`, stack, request messages, or response
text.

- [ ] **Step 4: Run the RPC tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video-summary/contracts.mjs src/pages/VideoSummaryOffscreen/runtime.mjs \
  src/background/video-summary-offscreen-rpc.mjs \
  tests/unit/video-summary/contracts.test.mjs \
  tests/unit/pages/video-summary-offscreen-runtime.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs
git commit -m "Route free-text generation through video summary RPC"
```

---

### Task 5: Add an isolated provider dispatcher for background-capable models

**Files:**
- Create: `src/background/model-text-dispatcher.mjs`
- Create: `tests/unit/background/model-text-dispatcher.test.mjs`
- Modify: `src/services/apis/chatgpt-web.mjs`
- Modify: `src/services/apis/bing-web.mjs`
- Modify: `src/services/apis/claude-web.mjs`
- Modify: `src/services/apis/moonshot-web.mjs`
- Modify: `src/services/apis/bard-web.mjs`
- Modify: `src/services/apis/claude-api.mjs`
- Modify: `src/services/apis/azure-openai-api.mjs`
- Modify: `src/services/apis/waylaidwanderer-api.mjs`
- Modify corresponding tests under `tests/unit/services/apis/`

**Interfaces:**
- Produces `createModelTextDispatcher(dependencies)` with
  `generateText({ modelSnapshot, messages, maxOutputTokens, signal })`.
- Dependencies include existing provider functions, token/cookie getters, `getUserConfig`, and an
  optional `generateWithChatgptPageProxy` supplied in Task 6.
- Creates a fresh `initSession()` per call and never returns/mutates that session outside the call.

- [ ] **Step 1: Write the dispatcher contract tests first**

Use injected fake provider functions and assert routing for every family represented by current
predicates:

```js
test('Kimi Web uses a fresh isolated session and returns cumulative provider text', async () => {
  const sessions = []
  const dispatcher = createModelTextDispatcher({
    getUserConfig: async () => ({ modelName: 'moonshotWebFree' }),
    generateAnswersWithMoonshotWebApi: async (port, question, session, config) => {
      sessions.push(session)
      assert.equal(config.maxResponseTokenLength, 1200)
      port.postMessage({ answer: 'partial', done: false })
      port.postMessage({ answer: 'final answer', done: true, session })
    },
    // Inject predicates/fakes for unused families.
  })
  const result = await dispatcher.generateText({
    modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
    messages: [{ role: 'system', content: 'template' }, { role: 'user', content: 'data' }],
    maxOutputTokens: 1200,
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { text: 'final answer', finishReason: null })
  assert.equal(sessions[0].conversationRecords.length, 1)
  assert.equal(sessions[0].moonshot_conversation !== undefined, true)
})
```

Also assert:

- OpenAI-compatible routing receives a cloned config capped at `maxOutputTokens`.
- Claude API, Azure, GitHub third-party, Claude Web, Bing Web, Gemini Web, ChatGPT direct Web, and
  Kimi Web select the correct injected adapter.
- Two concurrent calls receive different synthetic ports and sessions.
- Aborting one signal sends `{ stop: true }` only to that synthetic port.
- Provider `error` port messages reject with a normalized safe error.
- Missing Kimi refresh token becomes `MODEL_LOGIN_REQUIRED` with condition `login-required`.
- Missing ChatGPT page/direct token becomes an actionable error, not `MODEL_GATEWAY_UNSUPPORTED`.
- Prompt/answer/token values never appear in injected logger entries.

- [ ] **Step 2: Run the dispatcher test and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/background/model-text-dispatcher.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Make existing adapters accept isolated config without changing chat defaults**

Add an optional final argument where an adapter currently calls `getUserConfig()` internally:

```js
export async function generateAnswersWithClaudeApi(
  port,
  question,
  session,
  configOverride,
) {
  const config = configOverride || (await getUserConfig())
  // existing implementation
}
```

Apply the same pattern to ChatGPT Web, Bing Web, Claude Web where needed, Azure, and
Waylaidwanderer. Kimi already accepts config. For Bard, preserve the existing signature and rely on
prompt limits because that client has no output-token option. Keep all ordinary callers valid.

For adapters that emit duplicate terminal messages, the synthetic port must settle once and ignore
later messages; do not alter ordinary chat behavior merely to satisfy the dispatcher.

- [ ] **Step 4: Implement the isolated synthetic port and dispatcher**

Use a listener set compatible with `setAbortController()` and a single-settlement promise:

```js
function createIsolatedGenerationPort({ signal, onMessage }) {
  const messageListeners = createListenerSet()
  const disconnectListeners = createListenerSet()
  const port = {
    onMessage: messageListeners,
    onDisconnect: disconnectListeners,
    postMessage: onMessage,
    disconnect() {
      disconnectListeners.emit()
      messageListeners.clear()
      disconnectListeners.clear()
    },
  }
  signal?.addEventListener('abort', () => messageListeners.emit({ stop: true }), { once: true })
  return port
}
```

Construct the isolated session with:

```js
const session = initSession({
  question,
  conversationRecords: [],
  modelName: modelSnapshot?.modelName || config.modelName,
  apiMode: modelSnapshot?.apiMode ?? config.apiMode,
  autoClean: true,
})
```

Convert messages into one provider-neutral question that preserves role boundaries without asking
for JSON:

```js
function messagesToQuestion(messages) {
  return messages
    .filter((message) => typeof message?.content === 'string' && message.content.trim())
    .map((message) => `<${message.role || 'user'}>\n${message.content.trim()}`)
    .join('\n\n')
}
```

Clone config and set `maxResponseTokenLength` to the requested bounded value. Route using the same
predicates and order as `executeApi()` in `src/background/index.mjs`. Normalize known credential
errors into safe codes with `condition` and `modelName`; preserve the existing translated
human-facing message separately only inside trusted background state, not RPC logs.

- [ ] **Step 5: Verify adapter and dispatcher tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/model-text-dispatcher.test.mjs \
  tests/unit/services/apis/*.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/model-text-dispatcher.mjs \
  src/services/apis/chatgpt-web.mjs src/services/apis/bing-web.mjs \
  src/services/apis/claude-web.mjs src/services/apis/moonshot-web.mjs \
  src/services/apis/bard-web.mjs src/services/apis/claude-api.mjs \
  src/services/apis/azure-openai-api.mjs src/services/apis/waylaidwanderer-api.mjs \
  tests/unit/background/model-text-dispatcher.test.mjs tests/unit/services/apis
git commit -m "Add isolated text dispatch for configured AI models"
```

---

### Task 6: Add request-scoped ChatGPT provider-page execution

**Files:**
- Create: `src/background/video-summary-chatgpt-proxy.mjs`
- Create: `tests/unit/background/video-summary-chatgpt-proxy.test.mjs`
- Modify: `src/content-script/index.jsx`
- Modify: `tests/unit/content-script/port-error.test.mjs` or add a focused content proxy test using
  the existing JSX loader setup.

**Interfaces:**
- Produces `createVideoSummaryChatgptProxy({ tabs, getConfiguredTabId, logger })` with
  `generate({ requestId, session, signal })`.
- Uses a dedicated port name `bilibili-video-summary-chatgpt-proxy:<requestId>`.
- Resolves `{ text, finishReason }`; rejects `MODEL_PROVIDER_PAGE_REQUIRED` when no valid page is
  available.

- [ ] **Step 1: Write failing proxy tests**

Test no configured/valid tab, correlated answer collection, disconnect before completion, and
cancellation. The success test must assert the proxy creates a new tab port per request and never
reuses a normal chat port:

```js
assert.deepEqual(connectCalls, [
  { tabId: 42, options: { name: 'bilibili-video-summary-chatgpt-proxy:req-1' } },
])
assert.deepEqual(posted[0], { type: 'GENERATE_TEXT', requestId: 'req-1', session })
```

Run two concurrent requests and prove their replies cannot cross. Assert logs do not contain the
session question or answer.

- [ ] **Step 2: Run proxy tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/video-summary-chatgpt-proxy.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the background one-shot proxy**

Validate the configured tab with `tabs.get()`, connect a fresh port, attach listeners before posting,
and settle only messages with the same request ID. On abort, post
`{ type: 'CANCEL_GENERATE_TEXT', requestId }`, disconnect, and reject with
`MODEL_GATEWAY_ABORTED`. On missing/closed tab, throw:

```js
Object.assign(new Error('MODEL_PROVIDER_PAGE_REQUIRED'), {
  code: 'MODEL_PROVIDER_PAGE_REQUIRED',
  condition: 'provider-page-required',
  modelName: session.modelName,
})
```

- [ ] **Step 4: Add the dedicated content-script port handler**

On `chatgpt.com`, register a separate `Browser.runtime.onConnect` listener that accepts only the
exact prefix, validates `GENERATE_TEXT`, gets the access token, and invokes
`generateAnswersWithChatgptWebApi()` through a request-local forwarding port. Tag every reply with
`requestId`. Do not call generic `registerPortListener()`, do not use `_latestSessionRequestId`, and
do not log the question/session. Remove listeners and abort on disconnect.

- [ ] **Step 5: Verify proxy/content tests**

Run the Step 2 test plus the selected content-script proxy test. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/video-summary-chatgpt-proxy.mjs \
  tests/unit/background/video-summary-chatgpt-proxy.test.mjs \
  src/content-script/index.jsx tests/unit/content-script
git commit -m "Isolate ChatGPT page-proxy video summaries"
```

---

### Task 7: Replace `ModelGateway` tool calling with the universal dispatcher

**Files:**
- Modify: `src/background/model-gateway.mjs`
- Modify: `tests/unit/background/model-gateway.test.mjs`
- Modify: `src/background/index.mjs`

**Interfaces:**
- `createModelGateway({ getUserConfig, describeModelTextSupport, generateTextWithModel, logger })`.
- Public operations: `describeCapabilities(modelIdentity)`, `generateText(args)`, `cancel(args)`.
- `generateTextWithModel()` is the dispatcher method from Task 5; ChatGPT proxy support from Task 6
  is injected into that dispatcher.

- [ ] **Step 1: Rewrite gateway tests to fail against `generateText`**

Keep immutable snapshot, cancellation, and redacted-log assertions. Add Kimi capability coverage:

```js
test('describeCapabilities reports Kimi Web as text-capable', async () => {
  const gateway = createModelGateway({
    getUserConfig: async () => ({ kimiMoonShotRefreshToken: 'secret' }),
    describeModelTextSupport: () => ({ state: 'supported' }),
    generateTextWithModel: async () => ({ text: 'unused', finishReason: null }),
    logger: createLogger([]),
  })
  assert.deepEqual(await gateway.describeCapabilities({ modelName: 'moonshotWebFree' }), {
    supported: true,
    state: 'supported',
    reason: null,
    condition: null,
    inputTokenBudget: 4000,
    maxOutputTokens: 20_000,
  })
})
```

Assert `generateText` forwards immutable messages/snapshot, bounded output tokens, and an abort
signal; logs contain neither messages nor returned text. Delete tool schema/argument diagnostics
expectations that no longer belong to this gateway.

- [ ] **Step 2: Run gateway tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test tests/unit/background/model-gateway.test.mjs
```

Expected: FAIL because the old constructor and `invokeTool` contract remain.

- [ ] **Step 3: Implement the simplified gateway**

Retain controller keys `${taskId}:${requestId}` and immutable structured clones. Delegate:

```js
const response = await generateTextWithModel({
  modelSnapshot: immutableSnapshot,
  messages: immutableMessages,
  maxOutputTokens,
  signal: controller.signal,
})
```

Return only `{ text, finishReason }`. Build logs from task/request/model metadata and response
completion reason only. Capability exceptions become safe unsupported/temporary descriptors; do not
catch a known login/page condition and relabel it unsupported.

- [ ] **Step 4: Compose the dispatcher in `background/index.mjs`**

Instantiate the ChatGPT proxy, instantiate the dispatcher with existing provider functions and
credential getters, and inject its support/generate methods into `createModelGateway()`. Remove the
video-summary import/use of `invokeOpenAICompatibleTool`; leave that module available to unrelated
callers/tests until a separate cleanup proves it unused project-wide.

- [ ] **Step 5: Verify gateway and background-focused tests**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/background/model-gateway.test.mjs \
  tests/unit/background/model-text-dispatcher.test.mjs \
  tests/unit/background/video-summary-chatgpt-proxy.test.mjs \
  tests/unit/background/video-summary-offscreen-rpc.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/model-gateway.mjs src/background/index.mjs \
  tests/unit/background/model-gateway.test.mjs
git commit -m "Route video summaries through universal text gateway"
```

---

### Task 8: Render and export anchored and unanchored free-text results

**Files:**
- Modify: `src/components/BilibiliVideoSummaryView/index.jsx`
- Modify: `src/video-summary/markdown-export.mjs`
- Modify: `tests/unit/components/bilibili-video-summary-view.test.mjs`
- Modify: `tests/unit/video-summary/markdown-export.test.mjs`
- Modify: `src/_locales/en/main.json`
- Modify: `src/_locales/zh-hans/main.json`
- Modify: `src/_locales/zh-hant/main.json`

**Interfaces:**
- A timestamp button is rendered only when `Number.isFinite(startMs)`.
- Warning/error codes map to localized, actionable text; raw codes remain fallback-only.
- Export prints `Unknown` or omits the range for unanchored entries without generating `NaN`.

- [ ] **Step 1: Add failing component/export tests**

Render one anchored and one unanchored chapter/moment and assert there are only two timestamp
buttons for the anchored entries. Assert all four descriptions remain visible. Add export assertions:

```js
assert.match(markdown, /Anchored/)
assert.match(markdown, /Unanchored/)
assert.doesNotMatch(markdown, /NaN|segment:/)
```

Add an error rendering test for `MODEL_LOGIN_REQUIRED` and a warning test for
`VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE`.

- [ ] **Step 2: Run UI/export tests and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/components/bilibili-video-summary-view.test.mjs \
  tests/unit/video-summary/markdown-export.test.mjs
```

Expected: FAIL because timestamp controls are unconditional and codes are shown directly.

- [ ] **Step 3: Implement conditional timestamps and readable fallbacks**

Wrap timestamp controls:

```jsx
{Number.isFinite(chapter.startMs) ? (
  <TimestampButton
    startMs={chapter.startMs}
    endMs={chapter.endMs}
    onSeekTo={onSeekTo}
  />
) : null}
```

Apply the same rule to moments. If parsed `overview` is empty and `rawSummaryText` exists, render the
raw text in the summary area. Add translation keys for:

- `Sign in to the selected AI provider, then retry the summary.`
- `Open the selected AI provider page, then retry the summary.`
- `Some chapter or key-moment locations are unavailable.`
- `The model response reached its output limit; available content was preserved.`

Add English first, Simplified Chinese, and Traditional Chinese; rely on English fallback for other
locales per repository policy.

- [ ] **Step 4: Update Markdown export**

For unanchored moments, print `- <point>` with no timestamp. For unanchored chapters, print the title
and summary without an `Unknown - Unknown` range. Use parsed fields, never raw `[segment:...]`
markers, except when `rawSummaryText` is the only fallback.

- [ ] **Step 5: Verify UI/export tests**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/BilibiliVideoSummaryView/index.jsx \
  src/video-summary/markdown-export.mjs \
  tests/unit/components/bilibili-video-summary-view.test.mjs \
  tests/unit/video-summary/markdown-export.test.mjs \
  src/_locales/en/main.json src/_locales/zh-hans/main.json src/_locales/zh-hant/main.json
git commit -m "Render tolerant Bilibili summary locations"
```

---

### Task 9: Add Kimi Web and execution-family integration coverage

**Files:**
- Modify: `tests/integration/video-summary/end-to-end-fakes.test.mjs`
- Modify: `tests/unit/background/model-text-dispatcher.test.mjs`
- Modify: `tests/unit/content-script/bilibili-video-summary-port.test.mjs` only if result/error
  forwarding assertions need the new safe metadata.

**Interfaces:**
- Exercises the production runner + parser + result builder with dispatcher-like fake text output.
- Proves each configured execution family resolves to a dispatcher branch or an actionable runtime
  condition.

- [ ] **Step 1: Add a failing logged-in Kimi Web integration case**

Build a harness whose model snapshot is `{ modelName: 'moonshotWebFree', apiMode: null }`, whose
Kimi adapter emits bounded Markdown, and whose native subtitle has known IDs. Assert:

```js
assert.equal(result.status, 'complete')
assert.equal(result.overview, 'Kimi overview')
assert.equal(result.chapters[0].startMs, transcript.segments[0].startMs)
assert.equal(result.keyMoments[0].startMs, transcript.segments[1].startMs)
assert.equal(result.warnings.includes('MODEL_GATEWAY_UNSUPPORTED'), false)
```

Add a logged-out case that emits `TASK_FAILED` with `MODEL_LOGIN_REQUIRED`,
`checkpointAvailable: true`, and no provider fallback call.

- [ ] **Step 2: Add a model-catalog routing matrix test**

Iterate representative model keys from every exported group in `src/config/index.mjs` and assert the
dispatcher classifies each as one of:

```js
new Set([
  'openai-compatible',
  'claude-api',
  'azure-api',
  'github-third-party',
  'chatgpt-web',
  'claude-web',
  'kimi-web',
  'bing-web',
  'gemini-web',
])
```

The test must fail if a future configured model group falls through to unknown without an explicit
adapter decision.

- [ ] **Step 3: Run integration tests and verify RED, then complete missing routing only**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/integration/video-summary/end-to-end-fakes.test.mjs \
  tests/unit/background/model-text-dispatcher.test.mjs
```

Expected before final routing adjustments: FAIL on any uncovered family. Add only the missing
predicate/adapter branch; do not add providers or alter model catalogs.

- [ ] **Step 4: Re-run and verify GREEN**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/video-summary/end-to-end-fakes.test.mjs \
  tests/unit/background/model-text-dispatcher.test.mjs \
  src/background/model-text-dispatcher.mjs
git commit -m "Cover Kimi and configured summary model families"
```

---

### Task 10: Remove obsolete video-summary tool-call coupling and validate the product

**Files:**
- Delete only if `rg` proves video-summary-only and no unrelated caller remains:
  `src/video-summary/summary-tools.mjs`
- Delete corresponding test only under the same condition:
  `tests/unit/video-summary/summary-tools.test.mjs`
- Modify stale assertions/comments in touched video-summary tests and docs if they claim the active
  runner uses tool calling.

**Interfaces:**
- No runtime video-summary path references `invokeTool`, `CHUNK_SUMMARY_TOOL`,
  `VIDEO_SUMMARY_TOOL`, or `normalize*SummaryArguments`.
- `src/services/apis/openai-compatible-tool-call.mjs` remains unless a repository-wide search proves
  it has no callers outside the removed path; do not broaden cleanup.

- [ ] **Step 1: Prove obsolete references before deleting anything**

```bash
rg -n "invokeTool|CHUNK_SUMMARY_TOOL|VIDEO_SUMMARY_TOOL|normalizeChunkSummaryArguments|normalizeVideoSummaryArguments" src tests
```

Expected: references only in the obsolete summary-tools module/test or unrelated standalone
OpenAI-tool tests. If runtime references remain, fix those references and rerun focused tests before
removal. Do not delete `openai-compatible-tool-call.mjs` merely because video summary stopped using
it.

- [ ] **Step 2: Remove only proven obsolete video-summary files/references**

```bash
git rm src/video-summary/summary-tools.mjs tests/unit/video-summary/summary-tools.test.mjs
```

If Step 1 shows another runtime consumer, skip deletion and record why in the commit message/body.

- [ ] **Step 3: Format and run static checks**

```bash
npm run pretty
npm run lint
```

Expected: both exit 0 with no lint errors.

- [ ] **Step 4: Run the full automated test suite**

```bash
npm test
```

Expected: exit 0; no test reports `MODEL_GATEWAY_UNSUPPORTED` for a configured execution family.

- [ ] **Step 5: Run the production build and inspect artifacts**

```bash
npm run build
for dir in \
  build/chromium \
  build/firefox \
  build/chromium-without-katex-and-tiktoken \
  build/firefox-without-katex-and-tiktoken; do
  test -f "$dir/manifest.json"
done
test -f build/chromium/VideoSummaryOffscreen.html
test -f build/chromium/VideoSummaryOffscreen.js
test ! -e build/chromium-without-katex-and-tiktoken/VideoSummaryOffscreen.html
```

Expected: build exits 0; full Chromium contains the offscreen page and minimal Chromium does not.

- [ ] **Step 6: Perform manual extension smoke tests**

Load `build/chromium/` unpacked and verify:

1. Logged-in Kimi Web + Bilibili native subtitle produces overview, points, chapters, and moments.
2. At least one valid chapter and moment jumps to the correct video time.
3. A deliberately malformed/unanchored fake or test-provider response still displays text without a
   timestamp button.
4. Logged-out Kimi reports a login action and retains a retryable transcript checkpoint.
5. An OpenAI-compatible API model still summarizes.
6. ChatGPT Web with a valid provider tab does not cancel or alter an ordinary chat request.
7. Cancelling a video summary does not cancel ordinary chat.
8. Archive, ask-about-video, and Markdown download remain usable.
9. Popup, `Ctrl+B`/`Cmd+B`, selection tools, context menu, and independent panel still open.

Do not use real provider credentials in logs, screenshots, fixtures, or commit messages.

- [ ] **Step 7: Commit final cleanup**

```bash
git add -A
git commit -m "Complete universal free-text Bilibili summaries"
```

- [ ] **Step 8: Record validation evidence in the PR notes**

Record exact command results, Chromium version, tested Bilibili source type, tested model families,
and any unavailable manual provider credentials. Do not claim an untested web provider works; rely
on its automated contract test and explicitly mark manual coverage unavailable.
