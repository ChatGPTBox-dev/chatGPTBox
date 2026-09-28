import assert from 'node:assert/strict'
import test from 'node:test'
import { VIDEO_SUMMARY_STORAGE_KEY } from '../../../src/video-summary/contracts.mjs'
import { createMediaKitGateway } from '../../../src/background/media-kit-gateway.mjs'

function createStorageArea(initialValue) {
  const storage = new Map()
  if (initialValue !== undefined) {
    storage.set(VIDEO_SUMMARY_STORAGE_KEY, initialValue)
  }

  return {
    storage,
    storageArea: {
      async get(key) {
        return { [key]: storage.get(key) }
      },
      async set(payload) {
        Object.entries(payload).forEach(([key, value]) => storage.set(key, value))
      },
      async remove(key) {
        storage.delete(key)
      },
    },
  }
}

test('gateway stores the MediaKit key separately from config DTOs', async () => {
  const { storage, storageArea } = createStorageArea()
  const gateway = createMediaKitGateway({
    storageArea,
    fetchImpl: async () => {
      throw new Error('network not expected')
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  await gateway.setKey(' mk-live-test ')

  assert.equal(storage.get(VIDEO_SUMMARY_STORAGE_KEY), 'mk-live-test')
  assert.deepEqual(await gateway.getKeyState(), { present: true })
})

test('gateway deleteKey removes the standalone MediaKit key', async () => {
  const { storage, storageArea } = createStorageArea('mk-live-test')
  const gateway = createMediaKitGateway({
    storageArea,
    fetchImpl: async () => {
      throw new Error('network not expected')
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  await gateway.deleteKey()

  assert.equal(storage.has(VIDEO_SUMMARY_STORAGE_KEY), false)
  assert.deepEqual(await gateway.getKeyState(), { present: false })
})

test('gateway submitDirectAsr loads the MediaKit key from storage.local only', async () => {
  const { storageArea } = createStorageArea('mk-live-test')
  let capturedBody
  const gateway = createMediaKitGateway({
    storageArea,
    fetchImpl: async (url, init) => {
      if (url.includes('/tools/asr-subtitles')) {
        capturedBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ success: true, task_id: 'task-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-1' },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const result = await gateway.submitDirectAsr({
    audioUrl: 'https://cdn.example.invalid/audio.m4s?deadline=1790486400&token=secret',
    clientToken: 'task-1',
    speakerIdentification: true,
    confirmed: true,
  })

  assert.deepEqual(capturedBody, {
    audio_url: 'https://cdn.example.invalid/audio.m4s?deadline=1790486400&token=secret',
    content_type: 'speech',
    enable_speaker_info: true,
    enable_confidence: true,
    client_token: 'task-1',
  })
  assert.deepEqual(result, { taskId: 'task-1', requestId: 'request-1' })
})

test('gateway redacts request details before logging', async () => {
  const entries = []
  const { storageArea } = createStorageArea('mk-live-test')
  const gateway = createMediaKitGateway({
    storageArea,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      json: async () => ({ error: { message: 'bad key' } }),
    }),
    logger: {
      info(entry) {
        entries.push(entry)
      },
      warn(entry) {
        entries.push(entry)
      },
      error(entry) {
        entries.push(entry)
      },
    },
  })

  await assert.rejects(() =>
    gateway.submitDirectAsr({
      audioUrl: 'https://cdn.example.invalid/audio.m4s?deadline=1790486400&token=secret',
      clientToken: 'task-1',
      speakerIdentification: true,
      confirmed: true,
    }),
  )

  const serializedEntries = JSON.stringify(entries)
  assert.equal(serializedEntries.includes('mk-live-test'), false)
  assert.equal(serializedEntries.includes('token=secret'), false)
  assert.equal(serializedEntries.includes('https://cdn.example.invalid/audio.m4s'), false)
  assert.equal(serializedEntries.includes('"queryKeys":["deadline","token"]'), true)
})

test('gateway rejects requests when the standalone MediaKit key is absent', async () => {
  const { storageArea } = createStorageArea()
  const gateway = createMediaKitGateway({
    storageArea,
    fetchImpl: async () => {
      throw new Error('network not expected')
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  await assert.rejects(
    () =>
      gateway.submitDirectAsr({
        audioUrl: 'mediakit://file-1',
        clientToken: 'task-1',
        speakerIdentification: true,
        confirmed: true,
      }),
    { message: 'MEDIAKIT_API_KEY_REQUIRED' },
  )
})
