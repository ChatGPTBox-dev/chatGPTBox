import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

register('./tests/setup/video-summary-host-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(message)
}

function createPort(documentId) {
  const messageListeners = new Set()
  const disconnectListeners = new Set()
  return {
    sender: { documentId },
    messages: [],
    disconnected: false,
    onMessage: {
      addListener: (listener) => messageListeners.add(listener),
      removeListener: (listener) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.add(listener),
      removeListener: (listener) => disconnectListeners.delete(listener),
    },
    postMessage(message) {
      this.messages.push(message)
    },
    emit(message) {
      for (const listener of messageListeners) listener(message)
    },
    disconnect() {
      this.disconnected = true
    },
    listenerCounts() {
      return { message: messageListeners.size, disconnect: disconnectListeners.size }
    },
  }
}

function createBridge(platform, tracks, seeks) {
  return {
    getCurrentVideoId: () => 'same-id',
    getSnapshot: async () => ({
      platform,
      videoId: 'same-id',
      title: '',
      nativeSubtitleTracks: tracks,
      mediaCandidates: [],
    }),
    refreshSnapshot: async () => {},
    seekTo: (startMs) => seeks.push(startMs),
  }
}

let dom
let mountVideoSummaryHost
const originalDescriptors = new Map()
const globalNames = ['window', 'document', 'Node', 'Event', 'MouseEvent', 'HTMLElement', 'Blob']

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://www.youtube.com/watch?v=same-id',
  })
  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {
      globalThis.__VIDEO_SUMMARY_HOST_TEST__.resizeDisconnects += 1
    }
  }
  ;({ mountVideoSummaryHost } = await import('../../../src/content-script/video-summary-host.mjs'))
})

after(() => {
  dom.window.close()
  for (const name of globalNames) {
    const descriptor = originalDescriptors.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  delete globalThis.ResizeObserver
  delete globalThis.__VIDEO_SUMMARY_HOST_TEST__
})

test('shared host controls source selection, actions, platform ownership, metadata, and disposal', async () => {
  const tracks = [
    { id: 'auto-en', label: 'English auto', language: 'en', sourceKind: 'automatic', cues: [{}] },
    { id: 'author-fr', label: 'French', language: 'fr', sourceKind: 'author', cues: [{}] },
    { id: 'author-en', label: 'English', language: 'en-GB', sourceKind: 'author', cues: [{}] },
  ]
  const state = {
    ports: [],
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
    connect() {
      const port = createPort('document-1')
      this.ports.push(port)
      return port
    },
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = state
  const seeks = []

  const youtubeTarget = document.createElement('div')
  document.body.append(youtubeTarget)
  const youtubeHost = mountVideoSummaryHost({
    platform: 'youtube',
    bridge: createBridge('youtube', tracks, seeks),
    targetElement: youtubeTarget,
    connect: state.connect.bind(state),
  })
  await waitFor(
    () => state.viewProps.get('youtube')?.selectedSubtitleTrackId === 'author-en',
    'preferred YouTube subtitle was not selected',
  )

  let youtubeProps = state.viewProps.get('youtube')
  youtubeProps.onSelectSubtitleTrack('author-fr')
  await youtubeProps.onChooseSource('native-subtitle')
  const youtubeStart = state.ports[0].messages.find((message) => message.type === 'START_TASK')
  assert.equal(youtubeStart.platform, 'youtube')
  assert.equal(youtubeStart.subtitleTrackId, 'author-fr')

  youtubeProps = state.viewProps.get('youtube')
  await youtubeProps.onChooseSource('asr')
  assert.equal(state.ports[0].messages.filter((message) => message.type === 'START_TASK').length, 1)
  await state.viewProps.get('youtube').onConfirmAsr()
  assert.equal(state.ports[0].messages.filter((message) => message.type === 'START_TASK').length, 2)
  const youtubeAsrStart = state.ports[0].messages.filter(
    (message) => message.type === 'START_TASK',
  )[1]
  state.ports[0].emit({
    type: 'TASK_RESULT',
    taskId: youtubeAsrStart.taskId,
    owner: { documentId: 'document-1', platform: 'youtube', videoId: 'same-id' },
    result: { overview: 'YouTube overview', keyPoints: [], chapters: [], transcriptSegments: [] },
  })
  await state.viewProps.get('youtube').onArchive()
  await state.viewProps.get('youtube').onDownloadMarkdown()
  assert.equal(state.sessions[0].sessionName, 'YouTube summary: same-id')
  assert.equal(state.sessions[0].question, 'Summarize the YouTube video "same-id".')
  assert.equal(state.savedFiles[0][1], 'youtube-video-summary.md')

  youtubeHost.dispose()
  assert.equal(youtubeTarget.childElementCount, 0)
  assert.equal(state.ports[0].disconnected, true)
  assert.deepEqual(state.ports[0].listenerCounts(), { message: 0, disconnect: 0 })

  const bilibiliTarget = document.createElement('div')
  document.body.append(bilibiliTarget)
  const bilibiliHost = mountVideoSummaryHost({
    platform: 'bilibili',
    bridge: createBridge('bilibili', tracks, seeks),
    targetElement: bilibiliTarget,
    connect: state.connect.bind(state),
  })
  await waitFor(() => state.viewProps.has('bilibili'), 'Bilibili host did not render')
  assert.equal(
    state.ports[1].messages.some((message) => message.type === 'ATTACH_TASK'),
    false,
  )
  await state.viewProps.get('bilibili').onChooseSource('native-subtitle')
  const bilibiliStart = state.ports[1].messages.find((message) => message.type === 'START_TASK')
  state.ports[1].emit({
    type: 'TASK_RESULT',
    taskId: bilibiliStart.taskId,
    owner: { documentId: 'document-1', platform: 'bilibili', videoId: 'same-id' },
    checkpointAvailable: true,
    result: {
      overview: 'Overview',
      keyPoints: [{ point: 'Point', startMs: 1234 }],
      chapters: [],
      transcriptSegments: [],
    },
  })

  const completedProps = state.viewProps.get('bilibili')
  completedProps.onSeekTo(1234)
  await completedProps.onRetrySummary()
  await completedProps.onArchive()
  await completedProps.onAskAboutVideo()
  await completedProps.onDownloadMarkdown()
  await nextTask()

  assert.deepEqual(seeks, [1234])
  assert.equal(
    state.ports[1].messages.some((message) => message.type === 'RETRY_TASK'),
    true,
  )
  assert.equal(state.sessions[1].sessionName, 'Bilibili summary: same-id')
  assert.equal(state.sessions[1].question, 'Summarize the Bilibili video "same-id".')
  assert.equal(state.savedFiles[1][1], 'bilibili-summary.md')
  assert.match(state.toolbarProps[0].prompt, /structured video summary/)
  assert.equal(state.toolbarContainers[0].isConnected, true)

  bilibiliHost.dispose()
  assert.equal(bilibiliTarget.childElementCount, 0)
  assert.equal(state.toolbarContainers[0].isConnected, false)
  assert.equal(state.ports[1].disconnected, true)
  assert.deepEqual(state.ports[1].listenerCounts(), { message: 0, disconnect: 0 })
  assert.equal(
    state.ports[1].messages.some((message) => message.type === 'CANCEL_TASK'),
    false,
  )
  assert.equal(state.resizeDisconnects, 2)
})

test('retries one empty unavailable snapshot and enables the discovered subtitle track', async () => {
  const state = {
    ports: [],
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
    connect() {
      const port = createPort('retry-document')
      this.ports.push(port)
      return port
    },
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = state
  const timers = []
  let snapshotCalls = 0
  const track = {
    id: 'author-en',
    label: 'English',
    language: 'en',
    sourceKind: 'author',
    cues: [{}],
  }
  const bridge = {
    getCurrentVideoId: () => 'same-id',
    async getSnapshot() {
      snapshotCalls += 1
      return snapshotCalls === 1
        ? {
            platform: 'youtube',
            videoId: 'same-id',
            nativeSubtitleTracks: [],
            subtitleDiscovery: { status: 'unavailable' },
          }
        : {
            platform: 'youtube',
            videoId: 'same-id',
            nativeSubtitleTracks: [track],
            subtitleDiscovery: { status: 'available' },
          }
    },
    seekTo() {},
  }
  const target = document.createElement('div')
  document.body.append(target)
  const host = mountVideoSummaryHost({
    platform: 'youtube',
    bridge,
    targetElement: target,
    connect: state.connect.bind(state),
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay, cancelled: false })
      return timers.length - 1
    },
    clearTimeoutFn: (id) => {
      if (timers[id]) timers[id].cancelled = true
    },
  })

  await waitFor(() => timers.length === 1, 'snapshot retry was not scheduled')
  assert.equal(timers[0].delay, 1000)
  timers[0].callback()
  await waitFor(
    () => state.viewProps.get('youtube')?.selectedSubtitleTrackId === 'author-en',
    'discovered subtitle track was not selected',
  )
  assert.deepEqual(state.viewProps.get('youtube').subtitleTracks, [track])
  assert.equal(snapshotCalls, 2)
  host.dispose()
})

test('disposing the host cancels its pending snapshot retry', async () => {
  const state = {
    ports: [],
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
    connect() {
      const port = createPort('dispose-document')
      this.ports.push(port)
      return port
    },
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = state
  let snapshotCalls = 0
  let retryCallback
  let cleared = false
  const target = document.createElement('div')
  document.body.append(target)
  const host = mountVideoSummaryHost({
    platform: 'youtube',
    bridge: {
      getCurrentVideoId: () => 'same-id',
      getSnapshot: async () => {
        snapshotCalls += 1
        return {
          platform: 'youtube',
          videoId: 'same-id',
          nativeSubtitleTracks: [],
          subtitleDiscovery: { status: 'not-found' },
        }
      },
      seekTo() {},
    },
    targetElement: target,
    connect: state.connect.bind(state),
    setTimeoutFn: (callback) => {
      retryCallback = callback
      return 17
    },
    clearTimeoutFn: (id) => {
      assert.equal(id, 17)
      cleared = true
    },
  })

  await waitFor(() => retryCallback, 'snapshot retry was not scheduled')
  host.dispose()
  assert.equal(cleared, true)
  retryCallback()
  await nextTask()
  assert.equal(snapshotCalls, 1)
})

test('a snapshot retry from an old video does not update the remounted video host', async () => {
  const state = {
    ports: [],
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
    connect() {
      const port = createPort(`spa-document-${this.ports.length}`)
      this.ports.push(port)
      return port
    },
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = state
  let currentVideoId = 'same-id'
  let snapshotCalls = 0
  let retryCallback
  const bridge = {
    getCurrentVideoId: () => currentVideoId,
    getSnapshot: async () => {
      snapshotCalls += 1
      return {
        platform: 'youtube',
        videoId: currentVideoId,
        nativeSubtitleTracks: [],
        subtitleDiscovery: { status: 'unavailable' },
      }
    },
    seekTo() {},
  }
  const target = document.createElement('div')
  document.body.append(target)
  const oldHost = mountVideoSummaryHost({
    platform: 'youtube',
    bridge,
    targetElement: target,
    connect: state.connect.bind(state),
    setTimeoutFn: (callback) => {
      retryCallback = callback
      return 23
    },
    clearTimeoutFn() {},
  })

  await waitFor(() => retryCallback, 'old host retry was not scheduled')
  currentVideoId = 'new-video-id'
  retryCallback()
  await nextTask()
  assert.equal(snapshotCalls, 1)
  oldHost.dispose()
})

test('same-platform host reattaches while an equal video ID on another platform does not', async () => {
  const state = {
    ports: [],
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
    connect() {
      const port = createPort('document-2')
      this.ports.push(port)
      return port
    },
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = state
  const target = document.createElement('div')
  document.body.append(target)
  const bridge = createBridge('youtube', [], [])

  const firstHost = mountVideoSummaryHost({
    platform: 'youtube',
    bridge,
    targetElement: target,
    connect: state.connect.bind(state),
  })
  await waitFor(() => state.viewProps.has('youtube'), 'first host did not render')
  await state.viewProps.get('youtube').onConfirmAsr()
  const startedTask = state.ports[0].messages.find((message) => message.type === 'START_TASK')
  firstHost.dispose()

  const secondHost = mountVideoSummaryHost({
    platform: 'youtube',
    bridge,
    targetElement: target,
    connect: state.connect.bind(state),
  })
  await waitFor(
    () => state.ports[1].messages.some((message) => message.type === 'ATTACH_TASK'),
    'matching host did not reattach',
  )
  assert.equal(
    state.ports[1].messages.find((message) => message.type === 'ATTACH_TASK').taskId,
    startedTask.taskId,
  )
  secondHost.dispose()

  const otherPlatformHost = mountVideoSummaryHost({
    platform: 'bilibili',
    bridge: createBridge('bilibili', [], []),
    targetElement: target,
    connect: state.connect.bind(state),
  })
  await nextTask()
  assert.equal(
    state.ports[2].messages.some((message) => message.type === 'ATTACH_TASK'),
    false,
  )
  otherPlatformHost.dispose()
})
