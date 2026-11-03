# Bilibili Summary Panel Internationalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every fixed user-facing string in `BilibiliVideoSummaryView` through `react-i18next` and provide complete English, Simplified Chinese, and Traditional Chinese copy.

**Architecture:** Keep the existing component hierarchy and behavior. Each component obtains translations through `useTranslation()`, locale JSON remains the source of copy, and component tests initialize real English and Simplified Chinese resources to verify both fallback and translated rendering.

**Tech Stack:** Preact, `react-i18next`, JSON locale resources, Node 22 `node:test`, JSDOM.

## Global Constraints

- Do not change source selection, task state, event handlers, network behavior, or layout.
- Do not translate video titles, model output, transcript content, warning values, error codes, or non-empty protocol state values.
- Reuse existing `Cancel` and `Summary` keys.
- Add new keys to English first, then add explicit `zh-Hans` and `zh-Hant` translations.
- Other locales continue using English fallback.
- Preserve `{{label}}` interpolation and the upstream Bilibili track label.
- Follow test-first red-green-refactor.

---

### Task 1: Internationalize the complete Bilibili summary panel

**Files:**
- Modify: `tests/unit/components/bilibili-video-summary-view.test.mjs`
- Modify: `src/components/BilibiliVideoSummaryView/index.jsx`
- Modify: `src/_locales/en/main.json`
- Modify: `src/_locales/zh-hans/main.json`
- Modify: `src/_locales/zh-hant/main.json`

**Interfaces:**
- Consumes: the existing global `i18next` instance initialized by the content-script entry point.
- Produces: the same component props, DOM action attributes, event callbacks, and protocol values as before; only fixed rendered copy changes by selected locale.

- [ ] **Step 1: Extend the component test harness with Simplified Chinese resources**

In the async setup, load both locale files and initialize both resources:

```js
const englishMessages = JSON.parse(
  await readFile(new URL('../../../src/_locales/en/main.json', import.meta.url), 'utf8'),
)
const simplifiedChineseMessages = JSON.parse(
  await readFile(new URL('../../../src/_locales/zh-hans/main.json', import.meta.url), 'utf8'),
)
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: { translation: englishMessages },
    'zh-Hans': { translation: simplifiedChineseMessages },
  },
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})
```

Make `afterEach` restore English after unmounting:

```js
afterEach(async () => {
  act(() => render(null, container))
  container.replaceChildren()
  await i18n.changeLanguage('en')
})
```

- [ ] **Step 2: Write the failing Simplified Chinese UI test**

Add this test before changing the component or locales:

```js
test('view translates every fixed action and section label in Simplified Chinese', async () => {
  await i18n.changeLanguage('zh-Hans')
  mountView({
    videoTitle: '',
    sourceChoice: 'native-subtitle',
    subtitleTrack: {
      id: 'ai-track',
      label: '中文（自动生成）',
      sourceKind: 'bilibili-ai',
      cues: [{ startMs: 0, endMs: 1000, text: '字幕内容' }],
    },
    subtitleDiscoveryStatus: 'available',
    asrConfirmationVisible: true,
    taskState: {
      phase: 'complete',
      activeStage: null,
      checkpointAvailable: true,
      errorMessage: null,
      result: {
        status: 'complete',
        overview: '模型生成内容',
        keyPoints: ['动态要点'],
        keyMoments: [{ startMs: 0, point: '动态时刻' }],
        chapters: [{ startMs: 0, endMs: 1000, title: '动态章节', summary: '动态摘要' }],
        transcriptSegments: [
          { id: 's1', startMs: 0, endMs: 1000, speaker: null, text: '动态字幕' },
        ],
        warnings: [],
      },
    },
    onChooseSource() {},
    onConfirmAsr() {},
    onCancelAsrConfirmation() {},
    onArchive() {},
    onAskAboutVideo() {},
    onDownloadMarkdown() {},
    onSeekTo() {},
    onRetrySummary() {},
  })

  const buttonText = Array.from(container.querySelectorAll('button')).map((button) =>
    button.textContent.trim(),
  )
  assert.equal(buttonText.some((text) => text.includes('使用 B 站 AI 字幕')), true)
  assert.equal(buttonText.some((text) => text.includes('推荐')), true)
  assert.equal(buttonText.includes('运行 ASR'), true)
  assert.equal(buttonText.includes('确认运行 ASR'), true)
  assert.equal(buttonText.includes('取消'), true)
  assert.equal(buttonText.includes('仅重试总结'), true)
  assert.equal(buttonText.includes('归档总结'), true)
  assert.equal(buttonText.includes('询问此视频'), true)
  assert.equal(buttonText.includes('下载 Markdown'), true)

  assert.equal(container.textContent.includes('ASR 会将音频上传到远程服务'), true)
  assert.equal(container.textContent.includes('B 站视频总结'), true)
  assert.equal(container.textContent.includes('来源: native-subtitle'), true)
  assert.equal(container.textContent.includes('阶段: complete'), true)
  assert.equal(container.textContent.includes('状态: complete'), true)
  assert.equal(container.textContent.includes('处理阶段: 空闲'), true)
  assert.equal(container.textContent.includes('总结'), true)
  assert.equal(container.textContent.includes('关键要点'), true)
  assert.equal(container.textContent.includes('章节'), true)
  assert.equal(container.textContent.includes('关键时刻'), true)
  assert.equal(container.textContent.includes('字幕文本'), true)
  assert.equal(container.textContent.includes('模型生成内容'), true)
  assert.equal(container.textContent.includes('动态字幕'), true)
})
```

- [ ] **Step 3: Run the focused test and verify RED**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/components/bilibili-video-summary-view.test.mjs
```

Expected: the new test FAILS because buttons such as `Confirm ASR`, `Archive summary`, and section labels remain English and the new locale keys do not exist.

- [ ] **Step 4: Add locale keys and approved translations**

Add these entries to `src/_locales/en/main.json`:

```json
"Bilibili video summary": "Bilibili video summary",
"Unknown": "Unknown",
"Choice": "Choice",
"Phase": "Phase",
"Status": "Status",
"Stage": "Stage",
"None": "None",
"Idle": "Idle",
"Pending": "Pending",
"Confirm ASR": "Confirm ASR",
"Retry summary only": "Retry summary only",
"Archive summary": "Archive summary",
"Ask about this video": "Ask about this video",
"Download Markdown": "Download Markdown",
"ASR uploads audio to a remote service. Confirm that you accept remote retention and the cancellation cost before continuing.": "ASR uploads audio to a remote service. Confirm that you accept remote retention and the cancellation cost before continuing.",
"Key points": "Key points",
"Chapters": "Chapters",
"Key moments": "Key moments",
"Transcript": "Transcript"
```

Add these entries to `src/_locales/zh-hans/main.json`:

```json
"Bilibili video summary": "B 站视频总结",
"Unknown": "未知",
"Choice": "来源",
"Phase": "阶段",
"Status": "状态",
"Stage": "处理阶段",
"None": "无",
"Idle": "空闲",
"Pending": "等待中",
"Confirm ASR": "确认运行 ASR",
"Retry summary only": "仅重试总结",
"Archive summary": "归档总结",
"Ask about this video": "询问此视频",
"Download Markdown": "下载 Markdown",
"ASR uploads audio to a remote service. Confirm that you accept remote retention and the cancellation cost before continuing.": "ASR 会将音频上传到远程服务。继续前请确认你接受远程保留和取消任务可能产生的费用。",
"Key points": "关键要点",
"Chapters": "章节",
"Key moments": "关键时刻",
"Transcript": "字幕文本"
```

Add these entries to `src/_locales/zh-hant/main.json`:

```json
"Bilibili video summary": "Bilibili 影片摘要",
"Unknown": "未知",
"Choice": "來源",
"Phase": "階段",
"Status": "狀態",
"Stage": "處理階段",
"None": "無",
"Idle": "閒置",
"Pending": "等待中",
"Confirm ASR": "確認執行 ASR",
"Retry summary only": "僅重試摘要",
"Archive summary": "封存摘要",
"Ask about this video": "詢問此影片",
"Download Markdown": "下載 Markdown",
"ASR uploads audio to a remote service. Confirm that you accept remote retention and the cancellation cost before continuing.": "ASR 會將音訊上傳到遠端服務。繼續前請確認你接受遠端保留和取消工作可能產生的費用。",
"Key points": "關鍵要點",
"Chapters": "章節",
"Key moments": "關鍵時刻",
"Transcript": "字幕文字"
```

Do not duplicate the existing `Cancel` or `Summary` entries.

- [ ] **Step 5: Route fixed component strings through `t()`**

Change the timestamp helper to accept translated fallback text:

```js
function renderTimestampLabel(startMs, endMs = null, unknownLabel = 'Unknown') {
  const startLabel = formatVideoOffset(startMs) || unknownLabel
  if (!Number.isFinite(endMs)) return startLabel
  return `${startLabel} - ${formatVideoOffset(endMs) || unknownLabel}`
}
```

Inside `AsrConfirmation` and `SummaryActions`, call `useTranslation()` and replace every fixed JSX
string with its exact `t('...')` key. Use `t('Cancel')` for cancel.

Inside `TimestampButton`, call `useTranslation()` and render:

```jsx
{label || renderTimestampLabel(startMs, endMs, t('Unknown'))}
```

In the main component, replace fixed JSX text with:

```jsx
<h2>{videoTitle || t('Bilibili video summary')}</h2>
<div className="bilibili-video-summary-view__meta">
  <span>{t('Choice')}: {sourceChoice || t('None')}</span>
  <span>{t('Phase')}: {taskState?.phase || t('Idle')}</span>
  <span>{t('Status')}: {result?.status || t('Pending')}</span>
  <span>{t('Stage')}: {taskState?.activeStage || t('Idle')}</span>
</div>
```

Use `t('Summary')`, `t('Key points')`, `t('Chapters')`, `t('Key moments')`, and `t('Transcript')`
for the five section summaries. Pass `t('Unknown')` into the explicit key-moment
`renderTimestampLabel` call.

Do not change `data-action`, `data-source-choice`, props, callbacks, result values, or protocol
identifiers.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
node --import ./tests/setup/browser-shim.mjs --test \
  tests/unit/components/bilibili-video-summary-view.test.mjs \
  tests/unit/config/language-config.test.mjs \
  tests/unit/config/language-data.test.mjs
```

Expected: all component and language tests PASS, including the new Simplified Chinese assertions.

- [ ] **Step 7: Format and run full validation**

```bash
npm run pretty
npm run lint
npm test
npm run build
git diff --check
```

Expected: every command exits 0; the test suite reports no failures.

- [ ] **Step 8: Commit and merge**

```bash
git add src/components/BilibiliVideoSummaryView/index.jsx \
  src/_locales/en/main.json src/_locales/zh-hans/main.json src/_locales/zh-hant/main.json \
  tests/unit/components/bilibili-video-summary-view.test.mjs
git commit -m "Internationalize Bilibili summary panel"
```

Fast-forward `feat/video-tss` to the resulting commit and rerun `npm test` in its worktree.
