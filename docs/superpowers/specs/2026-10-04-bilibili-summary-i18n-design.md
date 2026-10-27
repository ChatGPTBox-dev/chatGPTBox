# Bilibili Summary Panel Internationalization Design

**Date:** 2026-10-04

**Status:** Approved for implementation planning

## 1. Purpose

Remove the remaining hard-coded English interface text from
`BilibiliVideoSummaryView`. Every fixed user-facing label in the panel uses the repository's
existing `react-i18next` resources so Simplified Chinese users see a fully Chinese interface,
Traditional Chinese users see Traditional Chinese, and other locales continue to fall back to
English.

Dynamic video titles, model-produced summaries, transcript text, warning values, error codes, and
internal state values are not translated.

## 2. Scope

Internationalize all fixed text rendered by `BilibiliVideoSummaryView`, not only the six remaining
buttons. This prevents mixed-language UI around the same action.

The covered text is:

- subtitle and ASR source buttons, including the existing recommended badge;
- ASR retention/cancellation-cost explanation;
- confirm, cancel, retry, archive, ask, and Markdown-download buttons;
- fallback panel title;
- metadata labels for choice, phase, status, and stage;
- Summary, Key points, Chapters, Key moments, and Transcript section labels;
- the unknown timestamp fallback;
- existing Bilibili subtitle availability notices.

The internal values after metadata labels remain protocol identifiers such as `native-subtitle`,
`complete`, and `synthesizing-summary`. Translating those values would couple UI copy to task
protocol semantics and is outside this change.

## 3. Localization Strategy

- Continue using `useTranslation()` from `react-i18next` inside the component.
- Pass translated labels into helper components or let each React component call
  `useTranslation()`; no module-level `i18next.t()` calls are added.
- Reuse existing keys such as `Cancel` and `Summary` rather than adding duplicates.
- Add every new source key to `src/_locales/en/main.json` first.
- Add explicit translations to `src/_locales/zh-hans/main.json` and
  `src/_locales/zh-hant/main.json`.
- Other locales rely on the existing English fallback.
- Preserve interpolation for `Use Bilibili subtitles: {{label}}` and do not translate the upstream
  Bilibili track label inserted into `{{label}}`.

## 4. Copy

| English key | Simplified Chinese | Traditional Chinese |
| --- | --- | --- |
| `Bilibili video summary` | `B 站视频总结` | `Bilibili 影片摘要` |
| `Unknown` | `未知` | `未知` |
| `Choice` | `来源` | `來源` |
| `Phase` | `阶段` | `階段` |
| `Status` | `状态` | `狀態` |
| `Stage` | `处理阶段` | `處理階段` |
| `None` | `无` | `無` |
| `Idle` | `空闲` | `閒置` |
| `Pending` | `等待中` | `等待中` |
| `Confirm ASR` | `确认运行 ASR` | `確認執行 ASR` |
| `Retry summary only` | `仅重试总结` | `僅重試摘要` |
| `Archive summary` | `归档总结` | `封存摘要` |
| `Ask about this video` | `询问此视频` | `詢問此影片` |
| `Download Markdown` | `下载 Markdown` | `下載 Markdown` |
| `ASR uploads audio to a remote service. Confirm that you accept remote retention and the cancellation cost before continuing.` | `ASR 会将音频上传到远程服务。继续前请确认你接受远程保留和取消任务可能产生的费用。` | `ASR 會將音訊上傳到遠端服務。繼續前請確認你接受遠端保留和取消工作可能產生的費用。` |
| `Key points` | `关键要点` | `關鍵要點` |
| `Chapters` | `章节` | `章節` |
| `Key moments` | `关键时刻` | `關鍵時刻` |
| `Transcript` | `字幕文本` | `字幕文字` |

Existing translations for author subtitles, Bilibili AI subtitles, unavailable subtitles,
recommended status, ASR execution, login guidance, and Summary remain unchanged.

## 5. Component Changes

- `renderTimestampLabel` receives the translated unknown label instead of embedding `Unknown`.
- `AsrConfirmation`, `SummaryActions`, and the main view read translations through hooks.
- `TimestampButton` receives the translated unknown label and continues to show video-relative
  offsets.
- The main view translates fixed labels while leaving state values unchanged.
- No layout, styling, task state, event handler, source selection, or network behavior changes.

## 6. Testing

Extend `tests/unit/components/bilibili-video-summary-view.test.mjs` with real locale resources:

1. Under English, assert the existing English buttons and section labels remain present.
2. Switch i18next to `zh-Hans`, render the same component, and assert every actionable button uses
   the Simplified Chinese copy above.
3. Assert the ASR explanation and section labels are Chinese.
4. Assert dynamic values such as `native-subtitle`, `complete`, and model-produced text are
   unchanged.
5. Restore the language after each test so existing tests remain deterministic.

Run the focused component test, language configuration tests, formatting, lint, full tests, and a
production build. Manually reload the unpacked extension and verify the Bilibili panel in a
Simplified Chinese browser profile.

## 7. Acceptance Criteria

- No fixed user-facing English string remains in `BilibiliVideoSummaryView` JSX.
- Every panel button is Chinese when the selected language is `zh-Hans`.
- Traditional Chinese uses the approved Traditional Chinese copy.
- English behavior and fallback remain unchanged.
- Dynamic content and protocol identifiers remain unchanged.
- Existing subtitle selection, explicit ASR confirmation, summary actions, timestamps, and task
  behavior continue to pass their tests.
