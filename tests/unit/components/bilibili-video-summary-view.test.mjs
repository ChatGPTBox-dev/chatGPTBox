import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, afterEach, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import i18n from 'i18next'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { initReactI18next } from 'react-i18next'

register(
  './tests/setup/content-script-selection-toolbar-loader-hooks.mjs',
  pathToFileURL(cwd() + '/').href,
)

let dom
let container
let BilibiliVideoSummaryView
const originalDescriptors = new Map()
const globalNames = [
  'window',
  'document',
  'Node',
  'Event',
  'MouseEvent',
  'HTMLElement',
  'HTMLDetailsElement',
]

function mountView(props) {
  act(() => {
    render(h(BilibiliVideoSummaryView, props), container)
  })
}

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.bilibili.com/' })

  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    })
  }

  container = document.createElement('div')
  document.body.append(container)
})

before(async () => {
  const englishMessages = JSON.parse(
    await readFile(new URL('../../../src/_locales/en/main.json', import.meta.url), 'utf8'),
  )
  const simplifiedChineseMessages = JSON.parse(
    await readFile(new URL('../../../src/_locales/zh-hans/main.json', import.meta.url), 'utf8'),
  )
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: {
      en: {
        translation: englishMessages,
      },
      'zh-Hans': {
        translation: simplifiedChineseMessages,
      },
    },
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  })
  const importedModule = await import('../../../src/components/BilibiliVideoSummaryView/index.jsx')
  BilibiliVideoSummaryView = importedModule.default
})

afterEach(async () => {
  act(() => render(null, container))
  container.replaceChildren()
  await i18n.changeLanguage('en')
})

after(() => {
  dom.window.close()

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('view requires explicit ASR confirmation and does not auto-run archive or ask actions', () => {
  const calls = []
  mountView({
    videoTitle: 'Test Video',
    sourceChoice: null,
    subtitleTrack: {
      id: 'bilibili-ai-conclusion',
      label: 'Bilibili AI subtitles',
      sourceKind: 'bilibili-ai',
      cues: [{ startMs: 0, endMs: 1000, text: 'AI 字幕' }],
    },
    subtitleDiscoveryStatus: 'available',
    taskState: { phase: 'idle', activeStage: null, result: null, checkpointAvailable: false },
    onChooseSource(choice) {
      calls.push(['choose', choice])
    },
    onConfirmAsr() {
      calls.push(['confirm-asr'])
    },
    onCancelAsrConfirmation() {
      calls.push(['cancel-asr'])
    },
    onArchive() {
      calls.push(['archive'])
    },
    onAskAboutVideo() {
      calls.push(['ask'])
    },
    onDownloadMarkdown() {
      calls.push(['download'])
    },
    onSeekTo() {
      calls.push(['seek'])
    },
    onRetrySummary() {
      calls.push(['retry'])
    },
  })

  const nativeButton = container.querySelector('button[data-source-choice="native-subtitle"]')
  const asrButton = container.querySelector('button[data-source-choice="asr"]')
  assert.ok(nativeButton)
  assert.ok(asrButton)
  assert.equal(nativeButton.disabled, false)
  assert.equal(nativeButton.textContent.includes('Bilibili AI subtitles'), true)
  assert.equal(nativeButton.textContent.includes('Recommended'), true)

  act(() => {
    asrButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.equal(container.textContent.includes('remote retention'), true)
  assert.equal(container.textContent.includes('cancellation cost'), true)
  assert.deepEqual(calls, [['choose', 'asr']])

  const confirmButton = container.querySelector('button[data-action="confirm-asr"]')
  const cancelButton = container.querySelector('button[data-action="cancel-asr"]')
  assert.ok(confirmButton)
  assert.ok(cancelButton)

  act(() => {
    cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    nativeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(calls, [
    ['choose', 'asr'],
    ['cancel-asr'],
    ['confirm-asr'],
    ['choose', 'native-subtitle'],
  ])
})

test('view explains login-required subtitle discovery and never auto-selects ASR', () => {
  const calls = []
  mountView({
    videoTitle: 'No Subtitle Video',
    sourceChoice: null,
    subtitleTrack: null,
    subtitleDiscoveryStatus: 'login-required',
    taskState: { phase: 'idle', activeStage: null, result: null, checkpointAvailable: false },
    onChooseSource: (choice) => calls.push(choice),
    onConfirmAsr() {},
    onCancelAsrConfirmation() {},
    onArchive() {},
    onAskAboutVideo() {},
    onDownloadMarkdown() {},
    onSeekTo() {},
    onRetrySummary() {},
  })

  assert.equal(
    container.textContent.includes('Sign in to Bilibili to check for AI subtitles'),
    true,
  )
  assert.equal(
    container.querySelector('button[data-source-choice="native-subtitle"]').disabled,
    true,
  )
  assert.deepEqual(calls, [])
  assert.equal(container.querySelector('[data-action="confirm-asr"]'), null)
})

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
  assert.equal(
    buttonText.some((text) => text.includes('使用 B 站 AI 字幕')),
    true,
  )
  assert.equal(
    buttonText.some((text) => text.includes('推荐')),
    true,
  )
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

test('view renders structured result states, timestamp seek actions, and explicit result buttons', () => {
  const calls = []
  mountView({
    videoTitle: 'Structured Video',
    sourceChoice: 'native-subtitle',
    taskState: {
      phase: 'complete',
      activeStage: 'synthesizing-summary',
      checkpointAvailable: true,
      result: {
        status: 'partial',
        overview: 'A compact overview',
        keyPoints: [
          { segmentId: 's2', startMs: 1000, point: 'Point A' },
          { segmentId: null, startMs: null, point: 'Point B' },
        ],
        keyMoments: [{ startMs: 0, point: 'Intro moment' }],
        chapters: [
          { startMs: 0, endMs: 1000, title: 'Opening', summary: 'Opening summary' },
          { startMs: 1000, endMs: 2000, title: 'Deep Dive', summary: 'Deep dive summary' },
        ],
        transcriptSegments: [
          { id: 's1', startMs: 0, endMs: 1000, speaker: 'Host', text: 'Welcome everyone' },
          { id: 's2', startMs: 1000, endMs: 2000, speaker: null, text: 'Let us begin' },
        ],
        warnings: ['Some transcript ranges could not be summarized.'],
      },
    },
    onChooseSource(choice) {
      calls.push(['choose', choice])
    },
    onConfirmAsr() {
      calls.push(['confirm-asr'])
    },
    onCancelAsrConfirmation() {
      calls.push(['cancel-asr'])
    },
    onArchive() {
      calls.push(['archive'])
    },
    onAskAboutVideo() {
      calls.push(['ask'])
    },
    onDownloadMarkdown() {
      calls.push(['download'])
    },
    onSeekTo(startMs) {
      calls.push(['seek', startMs])
    },
    onRetrySummary() {
      calls.push(['retry'])
    },
  })

  assert.equal(container.textContent.includes('partial'), true)
  assert.equal(container.textContent.includes('synthesizing-summary'), true)
  assert.equal(container.textContent.includes('A compact overview'), true)
  assert.equal(container.textContent.includes('Point A'), true)
  assert.equal(
    container.textContent.includes('Some transcript ranges could not be summarized.'),
    true,
  )
  assert.equal(container.textContent.includes('1970-01-01 08:00:00 Asia/Shanghai'), false)
  assert.equal(container.textContent.includes('00:00'), true)
  assert.equal(container.textContent.includes('00:01 - 00:02'), true)

  const chapterButton = container.querySelector('button[data-seek-ms="1000"]')
  const momentButton = container.querySelector('button[data-seek-ms="0"]')
  const summary = container.querySelector('[data-section="summary"]')
  const keyPoints = container.querySelector('[data-section="key-points"]')
  const chapters = container.querySelector('[data-section="chapters"]')
  const keyMoments = container.querySelector('[data-section="key-moments"]')
  const transcript = container.querySelector('[data-section="transcript"]')
  const summaryScroll = container.querySelector('.bilibili-video-summary-view__summary-scroll')
  const transcriptScroll = container.querySelector(
    '.bilibili-video-summary-view__transcript-scroll',
  )
  const retryButton = container.querySelector('button[data-action="retry-summary"]')
  const archiveButton = container.querySelector('button[data-action="archive"]')
  const askButton = container.querySelector('button[data-action="ask-about-video"]')
  const downloadButton = container.querySelector('button[data-action="download-markdown"]')

  assert.ok(chapterButton)
  assert.ok(momentButton)
  assert.ok(summary)
  assert.ok(keyPoints)
  assert.equal(keyPoints.querySelectorAll('button[data-seek-ms="1000"]').length, 1)
  assert.equal(keyPoints.querySelectorAll('button[data-seek-ms]').length, 1)
  assert.ok(chapters)
  assert.ok(keyMoments)
  assert.ok(transcript)
  assert.ok(summaryScroll)
  assert.ok(transcriptScroll)
  assert.ok(retryButton)
  assert.ok(archiveButton)
  assert.ok(askButton)
  assert.ok(downloadButton)
  assert.equal(summary.open, true)
  assert.equal(keyPoints.open, false)
  assert.equal(chapters.open, false)
  assert.equal(keyMoments.open, false)
  assert.equal(transcript.open, false)
  assert.equal(container.textContent.includes('Host: Welcome everyone'), true)

  act(() => {
    keyPoints.open = true
    chapters.open = true
    keyMoments.open = true
    transcript.open = true
    momentButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    chapterButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    archiveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    askButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    downloadButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.deepEqual(calls, [
    ['seek', 0],
    ['seek', 1000],
    ['retry'],
    ['archive'],
    ['ask'],
    ['download'],
  ])
})

test('view renders anchored and unanchored free-text locations without unusable seek controls', () => {
  mountView({
    videoTitle: 'Free-text Video',
    sourceChoice: 'native-subtitle',
    taskState: {
      phase: 'complete',
      activeStage: null,
      checkpointAvailable: false,
      result: {
        status: 'partial',
        overview: '',
        rawSummaryText: 'Fallback prose summary',
        keyPoints: [],
        keyMoments: [
          { startMs: 1_000, point: 'Anchored moment' },
          { startMs: null, point: 'Unanchored moment' },
        ],
        chapters: [
          {
            startMs: 2_000,
            endMs: 3_000,
            title: 'Anchored chapter',
            summary: 'Anchored chapter description',
          },
          {
            startMs: null,
            endMs: null,
            title: 'Unanchored chapter',
            summary: 'Unanchored chapter description',
          },
        ],
        transcriptSegments: [],
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

  assert.equal(container.querySelectorAll('button[data-seek-ms]').length, 2)
  assert.match(container.textContent, /Anchored moment/)
  assert.match(container.textContent, /Unanchored moment/)
  assert.match(container.textContent, /Anchored chapter description/)
  assert.match(container.textContent, /Unanchored chapter description/)
  assert.match(container.textContent, /Fallback prose summary/)
})

test('view renders actionable localized model errors and location warnings', () => {
  mountView({
    videoTitle: 'Actionable Video',
    sourceChoice: 'native-subtitle',
    taskState: {
      phase: 'failed',
      activeStage: null,
      checkpointAvailable: false,
      errorMessage: 'MODEL_LOGIN_REQUIRED',
      result: {
        status: 'partial',
        overview: 'Partial summary',
        keyPoints: [],
        keyMoments: [],
        chapters: [],
        transcriptSegments: [],
        warnings: ['VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE'],
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

  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    'Sign in to the selected AI provider, then retry the summary.',
  )
  assert.match(container.textContent, /Some chapter or key-moment locations are unavailable\./)
  assert.doesNotMatch(container.textContent, /MODEL_LOGIN_REQUIRED/)
  assert.doesNotMatch(container.textContent, /VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE/)
})

test('view maps provider-page errors and incomplete-output warnings to actionable text', () => {
  mountView({
    videoTitle: 'Actionable Video',
    sourceChoice: 'native-subtitle',
    taskState: {
      phase: 'failed',
      activeStage: null,
      checkpointAvailable: false,
      errorMessage: 'MODEL_PROVIDER_PAGE_REQUIRED',
      result: {
        status: 'partial',
        overview: 'Partial summary',
        keyPoints: [],
        keyMoments: [],
        chapters: [],
        transcriptSegments: [],
        warnings: ['MODEL_OUTPUT_INCOMPLETE'],
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

  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    'Open the selected AI provider page, then retry the summary.',
  )
  assert.match(
    container.textContent,
    /The model response reached its output limit; available content was preserved\./,
  )
})

test('view renders the task error code when processing fails', () => {
  mountView({
    videoTitle: 'Failed Video',
    sourceChoice: 'native-subtitle',
    taskState: {
      phase: 'failed',
      activeStage: null,
      checkpointAvailable: false,
      result: null,
      errorMessage: 'BILIBILI_NATIVE_SUBTITLES_NOT_FOUND',
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

  const error = container.querySelector('[role="alert"]')
  assert.ok(error)
  assert.equal(error.textContent, 'BILIBILI_NATIVE_SUBTITLES_NOT_FOUND')
})
