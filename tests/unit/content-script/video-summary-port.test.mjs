import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoSummaryPortClient } from '../../../src/content-script/video-summary-port.mjs'
import { createFakePort } from '../helpers/port.mjs'

const pageIdentity = { platform: 'youtube', videoId: 'abcdefghijk', mediaId: 'abcdefghijk' }
const owner = { tabId: 7, documentId: 'doc-7', platform: 'youtube', mediaId: 'abcdefghijk' }
const fence = { owner, taskId: 'task-1', generation: 1, attempt: 1 }

function createStartPayload() {
  return {
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity,
      nativeSubtitleTracks: [{ id: 'track-1', cues: [{ startMs: 0, endMs: 1000, text: 'hello' }] }],
      mediaCandidates: [],
    },
    settingsSnapshot: { preferredLanguage: 'en' },
    modelSnapshot: { modelName: 'customModel' },
  }
}

function createFixture() {
  const port = createFakePort({ name: 'video-summary' })
  const events = []
  let id = 0
  const client = createVideoSummaryPortClient({
    pageIdentity,
    pageGeneration: 3,
    pageBridge: {
      async refreshSnapshot({ expectedPageIdentity, pageGeneration }) {
        return {
          ...createStartPayload().sourceSnapshot,
          pageIdentity: expectedPageIdentity,
          pageGeneration,
        }
      },
    },
    connect: () => port,
    createTaskId: () => 'task-1',
    createRequestId: () => `request-${++id}`,
    onEvent: (event) => events.push(event),
  })
  return { port, client, events }
}

test('start sends no caller authority and resolves only a parsed correlated ACK', async () => {
  const { port, client } = createFixture()
  const started = client.startTask(createStartPayload())
  assert.deepEqual(
    { requestId: started.requestId, taskId: started.taskId },
    { requestId: 'request-1', taskId: 'task-1' },
  )
  assert.deepEqual(port.postedMessages[0], {
    type: 'START_TASK',
    requestId: 'request-1',
    taskId: 'task-1',
    pageIdentity,
    ...createStartPayload(),
  })
  for (const key of ['owner', 'generation', 'attempt', 'platform', 'videoId', 'mediaId']) {
    assert.equal(key in port.postedMessages[0], false)
  }
  port.emitMessage({
    type: 'START_ACK',
    requestId: 'request-1',
    taskId: 'task-1',
    status: 'started',
    fence,
  })
  assert.deepEqual(await started, { taskId: 'task-1', generation: 1, fence })
})

test('parseContentMessage rejects malformed ACKs before correlation', async () => {
  const { port, client } = createFixture()
  const started = client.startTask(createStartPayload())
  port.emitMessage({
    type: 'START_ACK',
    requestId: 'request-1',
    taskId: 'task-1',
    status: 'started',
    fence,
    owner,
  })
  port.emitMessage({
    type: 'START_ACK',
    requestId: 'request-1',
    taskId: 'task-1',
    status: 'started',
    fence,
  })
  assert.equal((await started).generation, 1)
})

test('cancel start, attach, retry, generation cancel, stale events and refresh are correlated', async () => {
  const { port, client, events } = createFixture()
  const started = client.startTask(createStartPayload())
  const cancelling = client.cancelStart({
    cancelRequestId: 'cancel-1',
    targetStartRequestId: 'request-1',
    taskId: 'task-1',
  })
  port.emitMessage({
    type: 'CANCEL_START_ACK',
    cancelRequestId: 'cancel-1',
    targetStartRequestId: 'request-1',
    status: 'cancelling',
    fence,
  })
  assert.equal((await cancelling).status, 'cancelling')
  port.emitMessage({
    type: 'START_ACK',
    requestId: 'request-1',
    taskId: 'task-1',
    status: 'cancelling',
    fence,
  })
  assert.equal((await started).generation, 1)

  port.emitMessage({
    type: 'TASK_EVENT',
    fence: { ...fence, attempt: 2 },
    event: { type: 'TASK_STATUS' },
  })
  port.emitMessage({
    type: 'TASK_EVENT',
    fence: { ...fence, generation: 2 },
    event: { type: 'TASK_STATUS' },
  })
  port.emitMessage({ type: 'TASK_EVENT', fence, event: { type: 'TASK_STATUS', stage: 'running' } })
  assert.deepEqual(events, [{ type: 'TASK_STATUS', stage: 'running' }])

  port.emitMessage({
    type: 'SOURCE_REFRESH_REQUEST',
    requestId: 'refresh-1',
    fence,
    expectedPageIdentity: pageIdentity,
    reason: 'SIGNED_URL_EXPIRED',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(port.postedMessages.at(-1).type, 'SOURCE_REFRESH_RESULT')
  assert.equal(port.postedMessages.at(-1).pageGeneration, 3)

  await client.cancelTask({ taskId: 'task-1', generation: 1 })
  assert.deepEqual(port.postedMessages.at(-1), {
    type: 'CANCEL_TASK',
    taskId: 'task-1',
    generation: 1,
    pageIdentity,
  })
})

test('disconnect rejects all pending requests', async () => {
  const { port, client } = createFixture()
  const started = client.startTask(createStartPayload())
  port.emitDisconnect()
  await assert.rejects(started, /VIDEO_SUMMARY_PORT_DISCONNECTED/)
})
