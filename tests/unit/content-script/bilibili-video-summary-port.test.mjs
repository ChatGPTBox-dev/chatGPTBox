import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryPortClient } from '../../../src/content-script/site-adapters/bilibili/video-summary-port.mjs'

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

function createPort({ sender = { documentId: 'doc-1' } } = {}) {
  const outbound = []
  const messageListeners = new Set()
  const disconnectListeners = new Set()

  return {
    sender,
    outbound,
    onMessage: {
      addListener(listener) {
        messageListeners.add(listener)
      },
      removeListener(listener) {
        messageListeners.delete(listener)
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.add(listener)
      },
      removeListener(listener) {
        disconnectListeners.delete(listener)
      },
    },
    postMessage(message) {
      outbound.push(message)
    },
    emitMessage(message) {
      for (const listener of Array.from(messageListeners)) {
        listener(message)
      }
    },
    emitDisconnect() {
      for (const listener of Array.from(disconnectListeners)) {
        listener()
      }
    },
    disconnectCalled: false,
    disconnect() {
      this.disconnectCalled = true
      this.emitDisconnect()
    },
  }
}

test('port client sends serializable START_TASK and ignores stale task events', async () => {
  const port = createPort()
  const events = []
  const refreshSnapshotCalls = []
  const client = createVideoSummaryPortClient({
    videoId: 'BV1test',
    pageBridge: {
      async getSnapshot() {
        return { videoId: 'BV1test' }
      },
      async refreshSnapshot({ expectedVideoId }) {
        refreshSnapshotCalls.push(expectedVideoId)
        return { videoId: expectedVideoId, mediaCandidates: [{ id: 'fresh' }] }
      },
      seekTo() {},
    },
    connect: () => port,
    onEvent(event) {
      events.push(event)
    },
  })

  const taskId = await client.startTask({
    sourceChoice: 'native-subtitle',
    sourceSnapshot: { videoId: 'BV1test' },
    settingsSnapshot: { preferredLanguage: 'en', speakerIdentification: true },
  })

  assert.equal(port.outbound[0].type, 'START_TASK')
  assert.equal(port.outbound[0].videoId, 'BV1test')
  assert.equal(port.outbound[0].taskId, taskId)
  assert.doesNotThrow(() => structuredClone(port.outbound[0]))

  port.emitMessage({
    type: 'TASK_STATUS',
    taskId,
    owner: { tabId: 7, documentId: 'doc-1', videoId: 'BV1test' },
    stage: 'transcribing',
  })
  port.emitMessage({
    type: 'TASK_STATUS',
    taskId: 'task-stale',
    owner: { tabId: 7, documentId: 'doc-1', videoId: 'BV1test' },
    stage: 'stale-task',
  })
  port.emitMessage({
    type: 'TASK_STATUS',
    taskId,
    owner: { tabId: 7, documentId: 'doc-other', videoId: 'BV1test' },
    stage: 'stale-owner',
  })
  port.emitMessage({
    type: 'REQUEST_SOURCE_REFRESH',
    taskId,
    owner: { tabId: 7, documentId: 'doc-1', videoId: 'BV1test' },
  })

  assert.deepEqual(events, [
    {
      type: 'TASK_STATUS',
      taskId,
      owner: { tabId: 7, documentId: 'doc-1', videoId: 'BV1test' },
      stage: 'transcribing',
    },
  ])
  assert.deepEqual(refreshSnapshotCalls, ['BV1test'])
  await nextTask()
  assert.deepEqual(port.outbound.at(-1), {
    type: 'SOURCE_REFRESH_RESULT',
    taskId,
    videoId: 'BV1test',
    sourceSnapshot: { videoId: 'BV1test', mediaCandidates: [{ id: 'fresh' }] },
  })
})

test('port client reattaches, retries, cancels, and disposes the active task', async () => {
  const port = createPort()
  const client = createVideoSummaryPortClient({
    videoId: 'BV9test',
    pageBridge: {
      async getSnapshot() {
        return { videoId: 'BV9test' }
      },
      seekTo() {},
    },
    connect: () => port,
  })

  await client.attachTask({ taskId: 'task-9' })
  await client.retryTask({ fromStage: 'synthesis' })
  await client.cancelTask()
  client.dispose()

  assert.deepEqual(port.outbound, [
    { type: 'ATTACH_TASK', taskId: 'task-9', videoId: 'BV9test' },
    { type: 'RETRY_TASK', taskId: 'task-9', videoId: 'BV9test', fromStage: 'synthesis' },
    { type: 'CANCEL_TASK', taskId: 'task-9', videoId: 'BV9test' },
  ])
  assert.equal(port.disconnectCalled, true)
})
