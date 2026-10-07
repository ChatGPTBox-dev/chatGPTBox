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
let VideoSummaryView
const originalDescriptors = new Map()
const globalNames = [
  'window',
  'document',
  'Node',
  'Event',
  'MouseEvent',
  'HTMLElement',
  'HTMLDetailsElement',
  'HTMLSelectElement',
]

const callbacks = {
  onSelectSubtitleTrack() {},
  onChooseSource() {},
  onConfirmAsr() {},
  onCancelAsrConfirmation() {},
  onArchive() {},
  onAskAboutVideo() {},
  onDownloadMarkdown() {},
  onDownloadTranscript() {},
  onSeekTo() {},
  onCancelTask() {},
  onRetrySummary() {},
}

function mountView(props) {
  act(() => {
    render(
      h(VideoSummaryView, { platform: 'youtube', subtitleTracks: [], ...callbacks, ...props }),
      container,
    )
  })
}

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/' })
  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  container = document.createElement('div')
  document.body.append(container)
})

before(async () => {
  const en = JSON.parse(
    await readFile(new URL('../../../src/_locales/en/main.json', import.meta.url), 'utf8'),
  )
  const zhHans = JSON.parse(
    await readFile(new URL('../../../src/_locales/zh-hans/main.json', import.meta.url), 'utf8'),
  )
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, 'zh-Hans': { translation: zhHans } },
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  VideoSummaryView = (await import('../../../src/components/VideoSummaryView/index.jsx')).default
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

test('renders selectable authored and automatic tracks and requires ASR confirmation', () => {
  const selected = []
  const choices = []
  const confirmations = []
  mountView({
    subtitleTracks: [
      { id: 'en-author', label: 'English', language: 'en', sourceKind: 'author', cues: [{}] },
      { id: 'en-auto', label: 'English', language: 'en', sourceKind: 'automatic', cues: [{}] },
    ],
    selectedSubtitleTrackId: 'en-author',
    onSelectSubtitleTrack: (id) => selected.push(id),
    onChooseSource: (choice) => choices.push(choice),
    onConfirmAsr: () => confirmations.push('confirmed'),
    taskState: { phase: 'idle' },
  })

  const options = [...container.querySelectorAll('option')]
  assert.deepEqual(
    options.map((option) => option.textContent),
    ['English · Author subtitles', 'English · Automatic subtitles'],
  )
  const select = container.querySelector('select[data-source-choice="native-subtitle"]')
  select.value = 'en-auto'
  act(() => select.dispatchEvent(new Event('change', { bubbles: true })))
  assert.deepEqual(selected, ['en-auto'])

  const subtitle = container.querySelector('button[data-source-choice="native-subtitle"]')
  assert.ok(subtitle)
  act(() => subtitle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  assert.deepEqual(choices, ['native-subtitle'])

  const asr = container.querySelector('button[data-source-choice="asr"]')
  act(() => asr.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  assert.deepEqual(choices, ['native-subtitle', 'asr'])
  assert.deepEqual(confirmations, [])
  assert.match(container.textContent, /remote retention/)
  act(() =>
    container
      .querySelector('button[data-action="confirm-asr"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  assert.deepEqual(confirmations, ['confirmed'])
})

test('renders structured results, warnings, timestamps, actions, and retry', () => {
  const calls = []
  mountView({
    sourceChoice: 'native-subtitle',
    subtitleTracks: [
      { id: 'track', label: 'English', language: 'en', sourceKind: 'author', cues: [{}] },
    ],
    selectedSubtitleTrackId: 'track',
    taskState: {
      phase: 'complete',
      activeStage: 'synthesizing-summary',
      checkpointAvailable: true,
      result: {
        status: 'partial',
        overview: 'Overview',
        chapters: [{ startMs: 0, endMs: 1000, title: 'Opening', summary: 'Chapter text' }],
        keyMoments: [
          { startMs: 1000, point: 'Anchored content' },
          { startMs: null, point: 'Unanchored content' },
        ],
        transcriptSegments: [
          { id: 's1', startMs: 1000, endMs: 2000, speaker: 'Host', text: 'Welcome' },
        ],
        warnings: ['VIDEO_SUMMARY_LOCATIONS_PARTIALLY_UNAVAILABLE'],
      },
    },
    canRetrySummary: true,
    onSeekTo: (value) => calls.push(['seek', value]),
    onRetrySummary: () => calls.push(['retry']),
    onArchive: () => calls.push(['archive']),
    onAskAboutVideo: () => calls.push(['ask']),
    onDownloadMarkdown: () => calls.push(['download-markdown']),
    onDownloadTranscript: () => calls.push(['download-transcript']),
  })

  assert.match(container.textContent, /Overview/)
  assert.match(container.textContent, /Anchored content/)
  assert.match(container.textContent, /Unanchored content/)
  assert.match(container.textContent, /Chapter text/)
  assert.match(container.textContent, /Host: Welcome/)
  assert.match(container.textContent, /00:01 - 00:02/)
  assert.match(container.textContent, /Some chapter or key-moment locations are unavailable\./)
  assert.equal(container.querySelector('[data-section="key-points"]'), null)
  assert.equal(container.querySelector('[data-section="key-moments"]'), null)
  assert.equal(container.querySelectorAll('[data-section="key-content"] [data-seek-ms]').length, 1)
  assert.match(container.querySelector('[data-section="key-content"]').textContent, /Key content/)
  for (const selector of [
    '[data-seek-ms="1000"]',
    '[data-action="retry-summary"]',
    '[data-action="archive"]',
    '[data-action="ask-about-video"]',
    '[data-action="download-transcript"]',
    '[data-action="download-markdown"]',
  ]) {
    act(() =>
      container.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
  }
  assert.deepEqual(calls, [
    ['seek', 1000],
    ['retry'],
    ['archive'],
    ['ask'],
    ['download-transcript'],
    ['download-markdown'],
  ])
})

test('shows and downloads the selected subtitle track before summarizing', () => {
  mountView({
    subtitleTracks: [
      {
        id: 'track',
        label: 'English',
        language: 'en',
        sourceKind: 'author',
        cues: [{ startMs: 1000, endMs: 2500, text: 'Track subtitle' }],
      },
    ],
    selectedSubtitleTrackId: 'track',
    taskState: { phase: 'idle', result: null },
  })

  assert.equal(container.querySelector('[data-action="download-transcript"]').disabled, false)
  assert.match(container.querySelector('[data-section="transcript"]').textContent, /Track subtitle/)
  assert.match(container.querySelector('[data-section="transcript"]').textContent, /00:01 - 00:02/)
})

test('busy phases disable every source and ASR confirmation control', () => {
  for (const phase of ['starting', 'running', 'cancelling', 'reattaching']) {
    mountView({
      subtitleTracks: [
        { id: 'track', label: 'English', language: 'en', sourceKind: 'author', cues: [{}] },
      ],
      selectedSubtitleTrackId: 'track',
      asrConfirmationVisible: true,
      sourceActionsDisabled: true,
      taskState: { phase, taskId: 'task-1' },
    })

    for (const selector of [
      'select[data-source-choice="native-subtitle"]',
      'button[data-source-choice="native-subtitle"]',
      'button[data-source-choice="asr"]',
      'button[data-action="confirm-asr"]',
    ]) {
      assert.equal(container.querySelector(selector).disabled, true, `${phase}: ${selector}`)
    }
  }
})

test('cancel is exposed for running work and synchronously disables after one click', () => {
  const calls = []
  mountView({
    sourceActionsDisabled: true,
    canCancel: true,
    taskState: { phase: 'running', taskId: 'task-1' },
    onCancelTask: () => calls.push('cancel'),
  })

  const cancel = container.querySelector('[data-action="cancel-task"]')
  assert.ok(cancel)
  act(() => {
    cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(calls, ['cancel'])
  assert.equal(cancel.disabled, true)
  assert.match(cancel.textContent, /Cancelling summary/)
})

test('retry visibility requires a terminal retryable checkpoint without active work', () => {
  const states = [
    [{ phase: 'running', checkpointAvailable: true, activeAttempt: true }, false],
    [{ phase: 'complete', checkpointAvailable: false, activeAttempt: false }, false],
    [{ phase: 'failed', checkpointAvailable: false, retryable: true, activeAttempt: false }, false],
    [{ phase: 'failed', checkpointAvailable: true, retryable: false, activeAttempt: false }, false],
    [{ phase: 'complete', checkpointAvailable: true, activeAttempt: true }, false],
    [{ phase: 'complete', checkpointAvailable: true, activeAttempt: false }, true],
    [
      {
        phase: 'failed',
        checkpointAvailable: true,
        retryable: true,
        activeAttempt: false,
      },
      true,
    ],
  ]

  for (const [taskState, expected] of states) {
    mountView({
      taskState,
      canRetrySummary:
        ['complete', 'failed'].includes(taskState.phase) &&
        taskState.checkpointAvailable === true &&
        taskState.activeAttempt !== true &&
        (taskState.phase === 'complete' || taskState.retryable === true),
    })
    assert.equal(Boolean(container.querySelector('[data-action="retry-summary"]')), expected)
  }
})

test('localizes fixed controls in Simplified Chinese', async () => {
  await i18n.changeLanguage('zh-Hans')
  mountView({
    subtitleTracks: [
      { id: 'auto', label: '中文', language: 'zh', sourceKind: 'automatic', cues: [{}] },
    ],
    selectedSubtitleTrackId: 'auto',
    asrConfirmationVisible: true,
    canRetrySummary: true,
    taskState: {
      phase: 'complete',
      checkpointAvailable: true,
      result: {
        status: 'complete',
        overview: '模型内容',
        keyPoints: [],
        chapters: [],
        keyMoments: [],
        transcriptSegments: [],
        warnings: [],
      },
    },
  })
  assert.match(container.textContent, /视频总结/)
  assert.match(container.textContent, /自动字幕/)
  assert.match(container.textContent, /运行 ASR/)
  assert.match(container.textContent, /确认运行 ASR/)
  assert.match(container.textContent, /仅重试总结/)
  assert.match(container.textContent, /归档总结/)
  assert.match(container.textContent, /字幕文本/)
})

test('maps known errors and safely hides unknown raw errors', () => {
  mountView({ taskState: { phase: 'failed', errorMessage: 'YOUTUBE_VIDEO_UNAVAILABLE' } })
  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    'This YouTube video is unavailable or restricted.',
  )

  mountView({ taskState: { phase: 'failed', errorMessage: 'SECRET_URL?token=private' } })
  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    'Something went wrong while processing this video. Please try again.',
  )
  assert.doesNotMatch(container.textContent, /SECRET_URL|token=private/)
})
