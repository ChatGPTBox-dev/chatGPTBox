import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  MediaKitError,
  normalizeMediaKitTranscription,
  queryMediaKitTask,
  requestMediaUploadTarget,
  submitMediaKitAsr,
  uploadMediaBlob,
} from '../../../../src/services/apis/volcengine-mediakit.mjs'

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })

test('requestMediaUploadTarget sends Content-Type application/json and body {} with Bearer auth', async () => {
  let capturedRequest
  const fetchImpl = mock.fn(async (url, init) => {
    capturedRequest = { url, method: init.method, headers: init.headers, body: init.body }
    return jsonResponse({
      success: true,
      result: {
        file_id: 'file-1',
        method: 'PUT',
        upload_url: 'https://upload.example.invalid/file',
        upload_headers: [],
      },
    })
  })

  const result = await requestMediaUploadTarget({ apiKey: 'my-api-key', fetchImpl })

  assert.equal(capturedRequest.method, 'POST')
  assert.equal(capturedRequest.body, '{}')
  assert.equal(capturedRequest.headers.Authorization, 'Bearer my-api-key')
  assert.equal(capturedRequest.headers['Content-Type'], 'application/json')
  assert.ok(capturedRequest.url.includes('/request-media-upload-url'))
  assert.deepEqual(result, {
    fileReference: 'mediakit://file-1',
    method: 'PUT',
    uploadUrl: 'https://upload.example.invalid/file',
    headers: {},
  })
})

test('submitMediaKitAsr forwards speakerIdentification and confirmed flags into the JSON request', async () => {
  const fetchImpl = mock.fn(async () =>
    jsonResponse({ success: true, task_id: 'task-1', request_id: 'request-1' }),
  )

  const result = await submitMediaKitAsr({
    apiKey: 'secret',
    audioUrl: 'mediakit://file-1',
    clientToken: 'stable-token',
    speakerIdentification: false,
    confirmed: true,
    fetchImpl,
  })

  assert.deepEqual(JSON.parse(fetchImpl.mock.calls.at(-1).arguments[1].body), {
    audio_url: 'mediakit://file-1',
    content_type: 'speech',
    enable_speaker_info: false,
    enable_confidence: true,
    client_token: 'stable-token',
  })
  assert.deepEqual(result, { taskId: 'task-1', requestId: 'request-1' })
})

test('normalizeMediaKitTranscription produces a stable transcript DTO', () => {
  const normalized = normalizeMediaKitTranscription({
    duration: 2.1,
    subtitles: [
      {
        start_time: 0.4,
        end_time: 1.2,
        subtitle_text: 'hello world',
        speaker: 'speaker-1',
        confidence: 0.98,
      },
      {
        start_time: 1.2,
        end_time: 2.1,
        subtitle_text: 'second line',
        speaker: 'speaker-2',
      },
    ],
  })

  assert.deepEqual(normalized, {
    durationMs: 2100,
    detectedLanguage: null,
    segments: [
      {
        id: 'segment-1',
        startMs: 400,
        endMs: 1200,
        text: 'hello world',
        speaker: 'speaker-1',
        confidence: 0.98,
      },
      {
        id: 'segment-2',
        startMs: 1200,
        endMs: 2100,
        text: 'second line',
        speaker: 'speaker-2',
        confidence: null,
      },
    ],
  })
})

test('normalizeMediaKitTranscription preserves explicit millisecond fields', () => {
  assert.deepEqual(
    normalizeMediaKitTranscription({
      durationMs: 2500,
      segments: [{ startMs: 500, endMs: 2500, text: 'already milliseconds' }],
    }),
    {
      durationMs: 2500,
      detectedLanguage: null,
      segments: [
        {
          id: 'segment-1',
          startMs: 500,
          endMs: 2500,
          text: 'already milliseconds',
          speaker: null,
          confidence: null,
        },
      ],
    },
  )
})

test('submitMediaKitAsr rejects missing apiKey', async () => {
  await assert.rejects(
    () =>
      submitMediaKitAsr({
        audioUrl: 'mediakit://file-1',
        clientToken: 'stable-token',
        speakerIdentification: true,
        confirmed: true,
        fetchImpl: mock.fn(),
      }),
    { message: 'MEDIAKIT_API_KEY_REQUIRED' },
  )
})

test('MediaKit requests forward signal and stop before parsing an aborted response', async () => {
  const controller = new AbortController()
  const signals = []
  let jsonCalls = 0
  const fetchImpl = mock.fn(async (url, init) => {
    signals.push(init.signal)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      async json() {
        jsonCalls += 1
        controller.abort()
        return {
          success: true,
          result: {
            file_id: 'file-1',
            method: 'PUT',
            upload_url: 'https://upload.example.invalid/file',
            upload_headers: [],
          },
        }
      },
    }
  })

  await assert.rejects(
    requestMediaUploadTarget({ apiKey: 'secret', fetchImpl, signal: controller.signal }),
    { name: 'AbortError' },
  )
  assert.equal(signals[0], controller.signal)
  assert.equal(jsonCalls, 1)
})

test('MediaKit upload, submission, and query all forward the caller signal', async () => {
  const controller = new AbortController()
  const seenSignals = []
  const fetchImpl = mock.fn(async (url, init) => {
    seenSignals.push(init.signal)
    if (url.includes('/tasks/')) return jsonResponse({ success: true, status: 'completed' })
    if (url.includes('/asr-subtitles')) {
      return jsonResponse({ success: true, task_id: 'provider-task' })
    }
    return new Response('', { status: 200 })
  })
  await uploadMediaBlob({
    target: { uploadUrl: 'https://upload.example.invalid/file', method: 'PUT', headers: {} },
    blob: new Blob(['audio']),
    fetchImpl,
    signal: controller.signal,
  })
  await submitMediaKitAsr({
    apiKey: 'secret',
    audioUrl: 'mediakit://file-1',
    clientToken: 'task-1',
    confirmed: true,
    fetchImpl,
    signal: controller.signal,
  })
  await queryMediaKitTask({
    apiKey: 'secret',
    taskId: 'provider-task',
    fetchImpl,
    signal: controller.signal,
  })
  assert.deepEqual(seenSignals, [controller.signal, controller.signal, controller.signal])
})

test('requestMediaUploadTarget surfaces provider errors as MediaKitError', async () => {
  const fetchImpl = mock.fn(async () =>
    jsonResponse(
      { success: false, error: { code: 'BAD_REQUEST', message: 'Invalid audio URL' } },
      { status: 400 },
    ),
  )

  await assert.rejects(
    () => requestMediaUploadTarget({ apiKey: 'secret', fetchImpl }),
    (error) =>
      error instanceof MediaKitError &&
      error.message === 'Invalid audio URL' &&
      error.providerCode === 'BAD_REQUEST' &&
      error.httpStatus === 400,
  )
})
