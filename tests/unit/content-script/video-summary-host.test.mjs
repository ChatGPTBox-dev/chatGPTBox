import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

register('./tests/setup/video-summary-host-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

let dom
let mountVideoSummaryHost
const originals = new Map()
const names = [
  'window',
  'document',
  'Node',
  'Event',
  'MouseEvent',
  'HTMLElement',
  'Blob',
  'FileReader',
]

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.youtube.com/' })
  for (const name of names) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.__VIDEO_SUMMARY_HOST_TEST__ = {
    viewProps: new Map(),
    savedFiles: [],
    sessions: [],
    toolbarProps: [],
    toolbarContainers: [],
    markdownInputs: [],
    resizeDisconnects: 0,
  }
  ;({ mountVideoSummaryHost } = await import('../../../src/content-script/video-summary-host.mjs'))
})

after(() => {
  dom.window.close()
  for (const name of names) {
    const descriptor = originals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  delete globalThis.ResizeObserver
  delete globalThis.__VIDEO_SUMMARY_HOST_TEST__
})

function createPort() {
  const messages = []
  const messageListeners = new Set()
  const disconnectListeners = new Set()
  return {
    messages,
    onMessage: {
      addListener: (fn) => messageListeners.add(fn),
      removeListener: (fn) => messageListeners.delete(fn),
    },
    onDisconnect: {
      addListener: (fn) => disconnectListeners.add(fn),
      removeListener: (fn) => disconnectListeners.delete(fn),
    },
    postMessage: (message) => messages.push(message),
    emitMessage: (message) => {
      for (const listener of messageListeners) listener(message)
    },
    disconnect() {},
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test('host constructs the Content client from canonical page identity', async () => {
  const identity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
  const port = createPort()
  const target = document.createElement('div')
  document.body.append(target)
  const host = mountVideoSummaryHost({
    platform: 'youtube',
    bridge: {
      getCurrentPageIdentity: () => identity,
      getSnapshot: async () => ({
        pageIdentity: identity,
        nativeSubtitleTracks: [],
        mediaCandidates: [],
      }),
      refreshSnapshot: async () => ({
        pageIdentity: identity,
        nativeSubtitleTracks: [],
        mediaCandidates: [],
      }),
      seekTo() {},
    },
    targetElement: target,
    connect: () => port,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(target.querySelector('.video-summary-host') !== null, true)
  assert.equal(host.isConnected(), true)
  target.querySelector('.video-summary-host').remove()
  assert.equal(host.isConnected(), false)
  host.dispose()
  assert.equal(target.querySelector('.video-summary-host'), null)
})

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function createHostFixture({ identity, isPageCurrent = () => true, title = 'Title' } = {}) {
  const pageIdentity = identity || {
    platform: 'youtube',
    videoId: 'abcdefghijk',
    mediaId: 'abcdefghijk',
  }
  const port = createPort()
  const target = document.createElement('div')
  document.body.append(target)
  const host = mountVideoSummaryHost({
    platform: 'youtube',
    pageIdentity,
    pageGeneration: 9,
    isPageCurrent,
    bridge: {
      getCurrentPageIdentity: () => pageIdentity,
      getSnapshot: async () => ({
        pageIdentity,
        title,
        nativeSubtitleTracks: [
          {
            id: 'track-1',
            label: 'English',
            language: 'en',
            sourceKind: 'author',
            cues: [{ startMs: 0, endMs: 1000, text: 'hello' }],
          },
        ],
        mediaCandidates: [],
      }),
      refreshSnapshot: async () => ({
        pageIdentity,
        nativeSubtitleTracks: [],
        mediaCandidates: [],
      }),
      seekTo() {},
    },
    targetElement: target,
    connect: () => port,
  })
  return { host, pageIdentity, port }
}

test('page generation blocks late snapshots and actions after disposal', async () => {
  const identity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
  const snapshot = deferred()
  const seeks = []
  const port = createPort()
  const target = document.createElement('div')
  document.body.append(target)
  const host = mountVideoSummaryHost({
    platform: 'youtube',
    pageIdentity: identity,
    pageGeneration: 9,
    bridge: {
      getCurrentPageIdentity: () => identity,
      getSnapshot: () => snapshot.promise,
      refreshSnapshot: () => snapshot.promise,
      seekTo: (startMs) => seeks.push(startMs),
    },
    targetElement: target,
    connect: () => port,
  })
  const staleProps = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  host.dispose()
  snapshot.resolve({
    pageIdentity: identity,
    title: 'late title',
    nativeSubtitleTracks: [],
    mediaCandidates: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  staleProps.onSeekTo(1000)
  await staleProps.onChooseSource('native-subtitle')

  assert.deepEqual(seeks, [])
  assert.equal(
    port.messages.some((message) => message.type === 'START_TASK'),
    false,
  )
})

test('same-turn source and ASR confirmation actions start only once', async () => {
  for (const [mediaId, invoke] of [
    ['source-latch', (props) => props.onChooseSource('native-subtitle')],
    ['asr-latch', (props) => props.onConfirmAsr()],
  ]) {
    const identity = { platform: 'youtube', videoId: mediaId, mediaId }
    const { host, port } = createHostFixture({ identity })
    await flush()
    const props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
    void invoke(props)
    void invoke(props)
    await flush()
    await flush()
    assert.equal(
      port.messages.filter((message) => message.type === 'START_TASK').length,
      1,
      mediaId,
    )
    const start = port.messages.find((message) => message.type === 'START_TASK')
    port.emitMessage({
      type: 'START_ACK',
      requestId: start.requestId,
      taskId: start.taskId,
      status: 'cancelled',
    })
    await flush()
    host.dispose()
  }
})

test('cancel latches immediately and targets pre-fence start only once', async () => {
  const identity = { platform: 'youtube', videoId: 'cancel-start', mediaId: 'cancel-start' }
  const { host, port } = createHostFixture({ identity })
  await flush()
  let props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  void props.onChooseSource('native-subtitle')
  await flush()
  await flush()
  const start = port.messages.find((message) => message.type === 'START_TASK')
  props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  void props.onCancelTask()
  void props.onCancelTask()

  assert.equal(
    globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube').taskState.phase,
    'cancelling',
  )
  assert.deepEqual(
    port.messages
      .filter((message) => message.type === 'CANCEL_START')
      .map((message) => ({
        targetStartRequestId: message.targetStartRequestId,
        taskId: message.taskId,
      })),
    [{ targetStartRequestId: start.requestId, taskId: start.taskId }],
  )
  const cancel = port.messages.find((message) => message.type === 'CANCEL_START')
  port.emitMessage({
    type: 'CANCEL_START_ACK',
    cancelRequestId: cancel.cancelRequestId,
    targetStartRequestId: start.requestId,
    status: 'cancelled',
  })
  port.emitMessage({
    type: 'START_ACK',
    requestId: start.requestId,
    taskId: start.taskId,
    status: 'cancelled',
  })
  await flush()
  host.dispose()
})

test('post-fence cancel uses task generation without attempt', async () => {
  const identity = {
    platform: 'youtube',
    videoId: 'cancel-generation',
    mediaId: 'cancel-generation',
  }
  const { host, port } = createHostFixture({ identity })
  await flush()
  void globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps
    .get('youtube')
    .onChooseSource('native-subtitle')
  await flush()
  await flush()
  const start = port.messages.find((message) => message.type === 'START_TASK')
  const fence = {
    owner: { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: identity.mediaId },
    taskId: start.taskId,
    generation: 4,
    attempt: 9,
  }
  port.emitMessage({
    type: 'START_ACK',
    requestId: start.requestId,
    taskId: start.taskId,
    status: 'started',
    fence,
  })
  await flush()
  port.emitMessage({
    type: 'TASK_EVENT',
    fence,
    event: { type: 'TASK_STATUS', stage: 'summarizing', checkpointAvailable: true },
  })
  const props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  void props.onCancelTask()
  void props.onCancelTask()

  const cancel = port.messages.filter((message) => message.type === 'CANCEL_TASK')
  assert.deepEqual(cancel, [
    {
      type: 'CANCEL_TASK',
      taskId: start.taskId,
      generation: 4,
      pageIdentity: identity,
    },
  ])
  assert.equal('attempt' in cancel[0], false)
  await flush()
  assert.equal(globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube').canCancel, false)

  port.emitMessage({
    type: 'TASK_EVENT',
    fence,
    event: { type: 'TASK_CANCELLED', checkpointAvailable: true },
  })
  await flush()

  const cancelledProps = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  assert.equal(cancelledProps.taskState.phase, 'idle')
  assert.equal(cancelledProps.taskState.activeStage, null)
  assert.equal(cancelledProps.taskState.taskId, null)
  assert.equal(cancelledProps.sourceActionsDisabled, false)
  host.dispose()
})

test('reattach keeps source actions disabled until ATTACH_ACK resolves', async () => {
  const identity = { platform: 'youtube', videoId: 'reattach', mediaId: 'reattach' }
  const first = createHostFixture({ identity })
  await flush()
  void globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps
    .get('youtube')
    .onChooseSource('native-subtitle')
  await flush()
  await flush()
  const start = first.port.messages.find((message) => message.type === 'START_TASK')
  const fence = {
    owner: { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: identity.mediaId },
    taskId: start.taskId,
    generation: 2,
    attempt: 1,
  }
  first.port.emitMessage({
    type: 'START_ACK',
    requestId: start.requestId,
    taskId: start.taskId,
    status: 'started',
    fence,
  })
  await flush()
  first.host.dispose()

  const second = createHostFixture({ identity })
  await flush()
  const attach = second.port.messages.find((message) => message.type === 'ATTACH_TASK')
  assert.ok(attach)
  assert.equal(
    globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube').sourceActionsDisabled,
    true,
  )
  second.port.emitMessage({
    type: 'ATTACH_ACK',
    requestId: attach.requestId,
    status: 'active',
    fence,
    event: { type: 'TASK_STATUS', stage: 'summarizing', checkpointAvailable: true },
  })
  await flush()
  assert.equal(
    globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube').taskState.phase,
    'running',
  )
  second.host.dispose()
})

test('downloads the selected subtitle track before summary generation', async () => {
  const title = 'Selected track'
  const identity = { platform: 'youtube', videoId: 'track-download', mediaId: 'track-download' }
  const { host } = createHostFixture({ identity, title })
  await flush()

  const props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  await props.onDownloadTranscript()
  const [blob, filename] = globalThis.__VIDEO_SUMMARY_HOST_TEST__.savedFiles.at(-1)
  const text = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsText(blob)
  })

  assert.equal(text, '[00:00:00.000 - 00:00:01.000] hello')
  assert.equal(filename, 'selected-track-transcript.txt')
  host.dispose()
})

test('archive and download share serialized Markdown while host metadata stays plain', async () => {
  const title = 'Plain <script> title / archive'
  const identity = { platform: 'youtube', videoId: 'sink-wiring', mediaId: 'sink-wiring' }
  const { host, port } = createHostFixture({ identity, title })
  await flush()
  void globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps
    .get('youtube')
    .onChooseSource('native-subtitle')
  await flush()
  await flush()
  const start = port.messages.find((message) => message.type === 'START_TASK')
  const fence = {
    owner: { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: identity.mediaId },
    taskId: start.taskId,
    generation: 1,
    attempt: 1,
  }
  port.emitMessage({
    type: 'START_ACK',
    requestId: start.requestId,
    taskId: start.taskId,
    status: 'started',
    fence,
  })
  await flush()
  port.emitMessage({
    type: 'TASK_EVENT',
    fence,
    event: {
      type: 'TASK_COMPLETED',
      checkpointAvailable: true,
      result: {
        status: 'complete',
        overview: '<script>attacker</script>',
        transcriptSegments: [
          { id: 's1', startMs: 1234, endMs: 5678, speaker: 'Host', text: 'First line' },
          { id: 's2', startMs: 3661001, endMs: 3662500, text: 'Second\nline' },
        ],
      },
    },
  })
  await flush()
  const props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  await props.onArchive()
  await props.onDownloadMarkdown()
  await props.onDownloadTranscript()

  const expectedMarkdown = '# Synthetic markdown\n\n\\<script\\>attacker\\</script\\>'
  const session = globalThis.__VIDEO_SUMMARY_HOST_TEST__.sessions.at(-1)
  const [markdownBlob, markdownFilename] = globalThis.__VIDEO_SUMMARY_HOST_TEST__.savedFiles.at(-2)
  const [transcriptBlob, transcriptFilename] =
    globalThis.__VIDEO_SUMMARY_HOST_TEST__.savedFiles.at(-1)
  const readBlob = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(reader.result))
      reader.addEventListener('error', () => reject(reader.error))
      reader.readAsText(blob)
    })

  assert.equal(session.conversationRecords[0].answer, expectedMarkdown)
  assert.equal(await readBlob(markdownBlob), expectedMarkdown)
  assert.equal(await readBlob(transcriptBlob), '[00:00:00.000 - 00:00:01.000] hello')
  assert.equal(session.sessionName, `YouTube summary: ${title}`)
  assert.equal(session.question, `Summarize the YouTube video "${title}".`)
  assert.equal(markdownFilename, 'plain--script--title---archive.md')
  assert.equal(transcriptFilename, 'plain--script--title---archive-transcript.txt')
  assert.equal(transcriptBlob.type, 'text/plain;charset=utf-8')
  assert.equal(globalThis.__VIDEO_SUMMARY_HOST_TEST__.markdownInputs.at(-1).title, title)
  host.dispose()
})

test('retry latches once and stale page generation ACK does not update UI', async () => {
  let current = true
  const identity = { platform: 'youtube', videoId: 'retry-latch', mediaId: 'retry-latch' }
  const { host, port } = createHostFixture({ identity, isPageCurrent: () => current })
  await flush()
  void globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps
    .get('youtube')
    .onChooseSource('native-subtitle')
  await flush()
  await flush()
  const start = port.messages.find((message) => message.type === 'START_TASK')
  const fence = {
    owner: { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: identity.mediaId },
    taskId: start.taskId,
    generation: 2,
    attempt: 1,
  }
  port.emitMessage({
    type: 'START_ACK',
    requestId: start.requestId,
    taskId: start.taskId,
    status: 'started',
    fence,
  })
  await flush()
  port.emitMessage({
    type: 'TASK_EVENT',
    fence,
    event: {
      type: 'TASK_COMPLETED',
      checkpointAvailable: true,
      result: { status: 'complete', overview: 'done' },
    },
  })
  let props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  void props.onRetrySummary()
  void props.onRetrySummary()
  await flush()
  const retries = port.messages.filter((message) => message.type === 'RETRY_TASK')
  assert.equal(retries.length, 1)
  current = false
  const beforeAck = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  port.emitMessage({
    type: 'RETRY_ACK',
    requestId: retries[0].requestId,
    taskId: start.taskId,
    status: 'started',
    fence: { ...fence, attempt: 2 },
  })
  await flush()
  props = globalThis.__VIDEO_SUMMARY_HOST_TEST__.viewProps.get('youtube')
  assert.equal(props, beforeAck)
  host.dispose()
})
