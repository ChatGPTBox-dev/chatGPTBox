import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VIDEO_SUMMARY_PROTOCOL_LIMITS,
  createPageIdentity,
  createTaskFence,
  createVideoSummaryOwner,
  fencesEqual,
  hashRetryRequest,
  hashStartRequest,
  measureSerializedBytes,
  ownersEqual,
  pageIdentitiesEqual,
  parsePageIdentity,
  parseContentCommand,
  parseContentMessage,
  parseOffscreenCommand,
  parseOffscreenMessage,
} from '../../../src/video-summary/protocol.mjs'

const youtubeIdentity = Object.freeze({
  platform: 'youtube',
  videoId: 'abcdefghijk',
  mediaId: 'abcdefghijk',
})

function createStart(overrides = {}) {
  return {
    type: 'START_TASK',
    requestId: 'start-1',
    taskId: 'task-1',
    pageIdentity: youtubeIdentity,
    sourceChoice: 'native-subtitle',
    subtitleTrackId: 'track-1',
    sourceSnapshot: {
      pageIdentity: youtubeIdentity,
      title: 'Title',
      durationMs: 10_000,
      nativeSubtitleTracks: [
        {
          id: 'track-1',
          language: 'en',
          label: 'English',
          sourceKind: 'author',
          cues: [{ startMs: 0, endMs: 1_000, text: 'hello' }],
        },
      ],
      mediaCandidates: [],
    },
    settingsSnapshot: {
      preferredLanguage: 'en',
      speakerIdentification: true,
      summaryMaxOutputTokens: 4_000,
      asrConfirmed: false,
    },
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
    ...overrides,
  }
}

test('canonical identities distinguish Bilibili multipart media', () => {
  const p1 = createPageIdentity({ platform: 'bilibili', videoId: 'BV1test', mediaId: '100' })
  const p2 = createPageIdentity({ platform: 'bilibili', videoId: 'BV1test', mediaId: '200' })
  assert.equal(pageIdentitiesEqual(p1, p2), false)
  assert.deepEqual(p1, { platform: 'bilibili', videoId: 'BV1test', mediaId: '100' })
})

test('owners and fences contain only authoritative identity fields', () => {
  const owner = createVideoSummaryOwner({
    tabId: 7,
    documentId: 'doc-7',
    platform: 'youtube',
    mediaId: 'abcdefghijk',
  })
  const fence = createTaskFence({ owner, taskId: 'task-1', generation: 2, attempt: 3 })
  assert.deepEqual(fence, { owner, taskId: 'task-1', generation: 2, attempt: 3 })
  assert.equal(fencesEqual(fence, structuredClone(fence)), true)
  assert.throws(
    () => createTaskFence({ owner, taskId: 'task-1', generation: 0, attempt: 1 }),
    /VIDEO_SUMMARY_GENERATION_INVALID/,
  )
})

test('content parser rejects caller-owned authority and unknown fields', () => {
  for (const forbidden of [
    { owner: { tabId: 99 } },
    { generation: 1 },
    { attempt: 1 },
    { platform: 'youtube' },
    { videoId: 'abcdefghijk' },
    { headers: { Authorization: 'secret' } },
  ]) {
    assert.throws(
      () => parseContentCommand(createStart(forbidden)),
      /VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED/,
    )
  }
})

test('snapshot identity must exactly equal command identity', () => {
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...createStart().sourceSnapshot,
            pageIdentity: { ...youtubeIdentity, mediaId: 'other-video' },
          },
        }),
      ),
    /VIDEO_SUMMARY_PAGE_IDENTITY_MISMATCH/,
  )
})

test('retry hashes normalize object key order but bind stage and model identity', async () => {
  const first = await hashRetryRequest({
    fromStage: 'synthesis',
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
  })
  const reordered = await hashRetryRequest({
    modelSnapshot: { apiMode: null, modelName: 'gpt-4o-mini' },
    fromStage: 'synthesis',
  })
  const changed = await hashRetryRequest({
    fromStage: 'summarizing',
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
  })
  assert.equal(first, reordered)
  assert.notEqual(first, changed)
  assert.match(first, /^[0-9a-f]{64}$/)
})

test('all parser families reject arrays and unsupported message types', () => {
  assert.throws(() => parseContentCommand([]), /VIDEO_SUMMARY_PROTOCOL_OBJECT_REQUIRED/)
  assert.throws(
    () => parseOffscreenCommand({ type: 'START_TASK' }),
    /VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED/,
  )
  assert.throws(
    () => parseOffscreenMessage({ type: 'RETRY_TASK' }),
    /VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED/,
  )
  assert.equal(VIDEO_SUMMARY_PROTOCOL_LIMITS.idCodeUnits, 128)
})

test('protocol enforces all content aggregate limits before privileged work', () => {
  const overlongId = 'x'.repeat(129)
  const tooManyCues = Array.from({ length: 20_001 }, (_, index) => ({
    startMs: index,
    endMs: index + 1,
    text: 'x',
  }))
  const tooManyCandidates = Array.from({ length: 17 }, (_, index) => ({
    id: String(index),
    mediaMetadata: { kind: 'audio', durationMs: 10_000 },
    remoteCandidate: { url: `https://r${index}.googlevideo.com/audio`, expiresAt: null },
    localFetchRecipe: null,
  }))

  assert.throws(
    () => parseContentCommand(createStart({ requestId: overlongId })),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...createStart().sourceSnapshot,
            nativeSubtitleTracks: [
              {
                id: 'track-1',
                language: 'en',
                label: 'English',
                sourceKind: 'author',
                cues: tooManyCues,
              },
            ],
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: { ...createStart().sourceSnapshot, mediaCandidates: tooManyCandidates },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )
})

test('protocol enforces cue, total subtitle, header, and serialized command limits', () => {
  const sourceSnapshot = createStart().sourceSnapshot
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...sourceSnapshot,
            nativeSubtitleTracks: [
              {
                id: 'track-1',
                language: 'en',
                label: 'English',
                sourceKind: 'author',
                cues: [{ startMs: 0, endMs: 1, text: 'x'.repeat(20_001) }],
              },
            ],
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )

  const sixteenMiB = 16 * 1024 * 1024
  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          sourceSnapshot: {
            ...sourceSnapshot,
            nativeSubtitleTracks: [
              {
                id: 'track-1',
                language: 'en',
                label: 'English',
                sourceKind: 'author',
                cues: Array.from({ length: 1_000 }, () => ({
                  startMs: 0,
                  endMs: 1,
                  text: 'x'.repeat(Math.floor(sixteenMiB / 1_000) + 1),
                })),
              },
            ],
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
  )

  assert.throws(
    () =>
      parseContentCommand(
        createStart({
          settingsSnapshot: {
            ...createStart().settingsSnapshot,
            blob: 'x'.repeat(24 * 1024 * 1024),
          },
        }),
      ),
    /VIDEO_SUMMARY_PROTOCOL_(FIELD_UNSUPPORTED|LIMIT_EXCEEDED)/,
  )
})

const owner = Object.freeze({
  tabId: 7,
  documentId: 'doc-7',
  platform: 'youtube',
  mediaId: 'abcdefghijk',
})
const fence = Object.freeze({ owner, taskId: 'task-1', generation: 1, attempt: 1 })
const event = Object.freeze({
  type: 'progress',
  stage: 'summarizing',
  completedChunks: 1,
  totalChunks: 2,
})

const validContentCommands = [
  createStart(),
  {
    type: 'CANCEL_START',
    cancelRequestId: 'cancel-1',
    targetStartRequestId: 'start-1',
    taskId: 'task-1',
    pageIdentity: youtubeIdentity,
  },
  { type: 'ATTACH_TASK', taskId: 'task-1', generation: 1, pageIdentity: youtubeIdentity },
  { type: 'CANCEL_TASK', taskId: 'task-1', generation: 1, pageIdentity: youtubeIdentity },
  {
    type: 'RETRY_TASK',
    requestId: 'retry-1',
    taskId: 'task-1',
    generation: 1,
    pageIdentity: youtubeIdentity,
    fromStage: 'synthesis',
    modelSnapshot: { modelName: 'gpt-4o-mini', apiMode: null },
  },
  {
    type: 'SOURCE_REFRESH_RESULT',
    requestId: 'refresh-1',
    taskId: 'task-1',
    generation: 1,
    pageIdentity: youtubeIdentity,
    pageGeneration: 2,
    sourceSnapshot: createStart().sourceSnapshot,
  },
  {
    type: 'SOURCE_REFRESH_RESULT',
    requestId: 'refresh-2',
    taskId: 'task-1',
    generation: 1,
    pageIdentity: youtubeIdentity,
    pageGeneration: 2,
    errorCode: 'VIDEO_SOURCE_UNAVAILABLE',
  },
]

const validContentMessages = [
  { type: 'START_ACK', requestId: 'start-1', taskId: 'task-1', status: 'started', fence },
  { type: 'START_ACK', requestId: 'start-2', taskId: 'task-1', status: 'cancelled' },
  {
    type: 'START_ACK',
    requestId: 'start-3',
    taskId: 'task-1',
    status: 'rejected',
    errorCode: 'BUSY',
  },
  {
    type: 'CANCEL_START_ACK',
    cancelRequestId: 'cancel-1',
    targetStartRequestId: 'start-1',
    status: 'cancelling',
    fence,
  },
  { type: 'ATTACH_ACK', requestId: 'attach-1', status: 'active', fence, event },
  {
    type: 'ATTACH_ACK',
    requestId: 'attach-2',
    status: 'not-found',
    errorCode: 'NOT_FOUND',
  },
  { type: 'RETRY_ACK', requestId: 'retry-1', taskId: 'task-1', status: 'started', fence },
  { type: 'TASK_EVENT', fence, event },
  {
    type: 'SOURCE_REFRESH_REQUEST',
    requestId: 'refresh-1',
    fence,
    expectedPageIdentity: youtubeIdentity,
    reason: 'expired',
  },
]

const validOffscreenCommands = [
  {
    type: 'START_ATTEMPT',
    requestId: 'attempt-1',
    fence,
    mode: 'initial',
    payload: { sourceSnapshot: createStart().sourceSnapshot },
  },
  { type: 'ATTEMPT_AUTHORIZED', requestId: 'attempt-1', fence },
  { type: 'CANCEL_TASK', fence },
  { type: 'EXECUTION_RELEASED_ACK', fence },
  { type: 'DELETE_TASK', owner, taskId: 'task-1', generation: 1 },
  validContentCommands[5],
  { type: 'GATEWAY_RESPONSE', requestId: 'gateway-1', fence, ok: true, result: {} },
  {
    type: 'GATEWAY_RESPONSE',
    requestId: 'gateway-2',
    fence,
    ok: false,
    error: { code: 'FAILED' },
  },
]

const validOffscreenMessages = [
  { type: 'ATTEMPT_ACCEPTED', requestId: 'attempt-1', fence },
  { type: 'ATTEMPT_REJECTED', requestId: 'attempt-2', fence, errorCode: 'BUSY' },
  { type: 'TASK_EVENT', fence, event },
  { type: 'EXECUTION_RELEASED', fence },
  { type: 'TASK_DELETED', owner, taskId: 'task-1', generation: 1 },
  validContentMessages[8],
  {
    type: 'GATEWAY_REQUEST',
    requestId: 'gateway-1',
    fence,
    gateway: 'mediakit',
    operation: 'submitDirectAsr',
    args: {},
  },
]

test('every protocol message shape normalizes to a new plain object', () => {
  for (const [parser, values] of [
    [parseContentCommand, validContentCommands],
    [parseContentMessage, validContentMessages],
    [parseOffscreenCommand, validOffscreenCommands],
    [parseOffscreenMessage, validOffscreenMessages],
  ]) {
    for (const value of values) {
      const parsed = parser(value)
      assert.deepEqual(parsed, value)
      assert.notEqual(parsed, value)
      assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
      assert.throws(
        () => parser({ ...value, unsupported: true }),
        /VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED/,
      )
    }
  }
})

test('ack status controls fence, event, and error fields', () => {
  assert.throws(
    () =>
      parseContentMessage({ type: 'START_ACK', requestId: 'r', taskId: 't', status: 'started' }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_REQUIRED/,
  )
  assert.throws(
    () =>
      parseContentMessage({
        type: 'START_ACK',
        requestId: 'r',
        taskId: 't',
        status: 'cancelled',
        fence,
      }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED/,
  )
  assert.throws(
    () => parseContentMessage({ type: 'ATTACH_ACK', requestId: 'r', status: 'active', fence }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_REQUIRED/,
  )
})

test('title, label, and gateway upload header limits are exact', () => {
  for (const sourceSnapshot of [
    { ...createStart().sourceSnapshot, title: 'x'.repeat(1_001) },
    {
      ...createStart().sourceSnapshot,
      nativeSubtitleTracks: [
        { ...createStart().sourceSnapshot.nativeSubtitleTracks[0], label: 'x'.repeat(1_001) },
      ],
    },
  ]) {
    assert.throws(
      () => parseContentCommand(createStart({ sourceSnapshot })),
      /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
    )
  }

  for (const headers of [
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`x-${index}`, 'value'])),
    { ['x'.repeat(257)]: 'value' },
    { key: 'x'.repeat(257) },
  ]) {
    assert.throws(
      () =>
        parseOffscreenMessage({
          type: 'GATEWAY_REQUEST',
          requestId: 'gateway-1',
          fence,
          gateway: 'mediakit',
          operation: 'requestUploadTarget',
          args: { headers },
        }),
      /VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED/,
    )
  }
})

test('refresh and gateway responses require exactly one result branch', () => {
  assert.throws(
    () => parseOffscreenCommand({ ...validContentCommands[5], errorCode: 'FAILED' }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID/,
  )
  assert.throws(
    () => parseOffscreenCommand({ type: 'GATEWAY_RESPONSE', requestId: 'g', fence, ok: true }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID/,
  )
  assert.throws(
    () =>
      parseOffscreenCommand({
        type: 'GATEWAY_RESPONSE',
        requestId: 'g',
        fence,
        ok: false,
        result: {},
        error: {},
      }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID/,
  )
})

test('constructors reject noncanonical values and equality is total', () => {
  assert.deepEqual(parsePageIdentity(youtubeIdentity), youtubeIdentity)
  assert.equal(pageIdentitiesEqual(youtubeIdentity, null), false)
  assert.equal(ownersEqual(owner, structuredClone(owner)), true)
  assert.equal(ownersEqual(owner, { ...owner, mediaId: 'other' }), false)
  assert.throws(
    () => createVideoSummaryOwner({ ...owner, tabId: 1.5 }),
    /VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID/,
  )
})

test('start hashes are deterministic and serialized bytes use UTF-8', async () => {
  const start = createStart()
  const first = await hashStartRequest(start)
  const second = await hashStartRequest({
    modelSnapshot: start.modelSnapshot,
    settingsSnapshot: start.settingsSnapshot,
    sourceSnapshot: start.sourceSnapshot,
    subtitleTrackId: start.subtitleTrackId,
    sourceChoice: start.sourceChoice,
    pageIdentity: start.pageIdentity,
  })
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(measureSerializedBytes('é'), 4)
})
