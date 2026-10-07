import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskOpfsStore } from '../../../src/video-summary/opfs.mjs'

function createFileSystem() {
  const writes = []
  const writable = {
    async write(value) {
      writes.push(value)
    },
    async close() {},
    async abort() {},
  }
  const fileHandle = {
    async createWritable() {
      return writable
    },
    async getFile() {
      return new Blob(writes)
    },
  }
  const taskDirectory = {
    async getFileHandle() {
      return fileHandle
    },
  }
  const tasksDirectory = {
    async getDirectoryHandle() {
      return taskDirectory
    },
    async removeEntry() {},
  }
  return {
    async getDirectoryHandle() {
      return tasksDirectory
    },
  }
}

function candidate(primaryUrl = 'https://upos-sz-mirrorcos.bilivideo.com/audio') {
  return {
    localFetchRecipe: {
      primaryUrl,
      backupUrls: [],
      credentialMode: 'omit',
      requiredRequestOrigin: 'https://www.bilibili.com/',
    },
  }
}

function mediaResponse(body = 'audio', init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'audio/mp4', ...(init.headers || {}) },
  })
}

test('local download manually follows only revalidated redirects before body access', async () => {
  const calls = []
  let redirectBodyRead = false
  const redirectResponse = mediaResponse('redirect', {
    status: 302,
    headers: { Location: '/next' },
  })
  Object.defineProperty(redirectResponse, 'body', {
    get() {
      redirectBodyRead = true
      throw new Error('redirect body must not be read')
    },
  })
  const store = createTaskOpfsStore({
    rootDirectory: createFileSystem(),
    taskId: 'task-redirect',
    fetchImpl: async (url, init) => {
      calls.push([url, init])
      return calls.length === 1 ? redirectResponse : mediaResponse()
    },
  })

  const result = await store.downloadCandidate({
    platform: 'bilibili',
    candidate: candidate(),
  })

  assert.equal(redirectBodyRead, false)
  assert.equal(result.sourceUrl, 'https://upos-sz-mirrorcos.bilivideo.com/next')
  assert.equal(calls.length, 2)
  for (const [, init] of calls) {
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'omit')
    assert.equal('headers' in init, false)
  }
})

test('invalid redirect fails before redirect body access', async () => {
  let bodyRead = false
  const response = mediaResponse('redirect', {
    status: 302,
    headers: { Location: 'https://evil.test/audio' },
  })
  Object.defineProperty(response, 'body', {
    get() {
      bodyRead = true
      throw new Error('body must not be read')
    },
  })
  const store = createTaskOpfsStore({
    rootDirectory: createFileSystem(),
    taskId: 'task-invalid-redirect',
    fetchImpl: async () => response,
  })

  await assert.rejects(
    store.downloadCandidate({ platform: 'bilibili', candidate: candidate() }),
    /VIDEO_MEDIA_HOST_REJECTED/,
  )
  assert.equal(bodyRead, false)
})

test('invalid redirect does not continue to a backup URL', async () => {
  let calls = 0
  const store = createTaskOpfsStore({
    rootDirectory: createFileSystem(),
    taskId: 'task-invalid-redirect-backup',
    fetchImpl: async () => {
      calls += 1
      if (calls > 1) return mediaResponse()
      return mediaResponse('', { status: 302, headers: { Location: 'https://evil.test/audio' } })
    },
  })
  const withBackup = candidate()
  withBackup.localFetchRecipe.backupUrls = ['https://upos-sz-mirrorali.bilivideo.com/backup']

  await assert.rejects(
    store.downloadCandidate({ platform: 'bilibili', candidate: withBackup }),
    /VIDEO_MEDIA_HOST_REJECTED/,
  )
  assert.equal(calls, 1)
})

test('local download rejects missing locations and more than five redirects', async (t) => {
  await t.test('missing location', async () => {
    const store = createTaskOpfsStore({
      rootDirectory: createFileSystem(),
      taskId: 'task-missing-location',
      fetchImpl: async () => mediaResponse('', { status: 302 }),
    })
    await assert.rejects(
      store.downloadCandidate({ platform: 'bilibili', candidate: candidate() }),
      /VIDEO_MEDIA_REDIRECT_REJECTED/,
    )
  })

  await t.test('redirect limit', async () => {
    let calls = 0
    const store = createTaskOpfsStore({
      rootDirectory: createFileSystem(),
      taskId: 'task-redirect-limit',
      fetchImpl: async () => {
        calls += 1
        return mediaResponse('', { status: 302, headers: { Location: `/hop-${calls}` } })
      },
    })
    await assert.rejects(
      store.downloadCandidate({ platform: 'bilibili', candidate: candidate() }),
      /VIDEO_MEDIA_REDIRECT_LIMIT_EXCEEDED/,
    )
    assert.equal(calls, 6)
  })
})

test('upload uses the exact validated target policy', async () => {
  let captured
  const target = {
    url: 'https://tob-upload-y.volcvod.com/tos-vod-cn-v-fixture/mediakit/upload/local/fixture?Authorization=redacted',
    fileReference: 'mediakit://fixture',
    method: 'PUT',
    headers: {},
    credentials: 'omit',
    redirect: 'error',
  }
  const store = createTaskOpfsStore({
    rootDirectory: createFileSystem(),
    taskId: 'task-upload',
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return mediaResponse('')
    },
  })

  await store.uploadBlob({ target, blob: new Blob(['audio']) })

  assert.equal(captured.url, target.url)
  assert.deepEqual(captured.init, {
    method: 'PUT',
    headers: {},
    body: new Blob(['audio']),
    credentials: 'omit',
    redirect: 'error',
    signal: undefined,
  })
})
