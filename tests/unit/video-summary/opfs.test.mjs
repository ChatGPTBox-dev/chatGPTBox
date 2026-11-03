import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanupVideoSummaryTaskDirectory,
  cleanupVideoSummaryTasksRoot,
  createTaskOpfsStore,
  estimateCandidateBytes,
} from '../../../src/video-summary/opfs.mjs'

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

test('estimates candidate bytes from content length or conservative bitrate', () => {
  assert.equal(estimateCandidateBytes({ mediaMetadata: { contentLength: 1234 } }), 1234)
  assert.equal(
    estimateCandidateBytes({ mediaMetadata: { durationMs: 10_000, bandwidth: 160_000 } }),
    200_000,
  )
  assert.equal(estimateCandidateBytes({ mediaMetadata: { durationMs: 10_000 } }), 400_000)
  assert.equal(estimateCandidateBytes({ mediaMetadata: {} }), 1024 * 1024 * 1024)
})

test('quota reserves max 64 MiB or ten percent before creating a directory', async (t) => {
  for (const [name, estimate, requiredBytes, expectedAvailable] of [
    ['64 MiB floor', { quota: 512 * 1024 * 1024, usage: 100 * 1024 * 1024 }, 1, 348 * 1024 * 1024],
    ['ten percent', { quota: 2 * 1024 * 1024 * 1024, usage: 0 }, 1, 1.8 * 1024 * 1024 * 1024],
  ]) {
    await t.test(name, async () => {
      let directoryCalls = 0
      const store = createTaskOpfsStore({
        rootDirectory: {
          async getDirectoryHandle() {
            directoryCalls += 1
          },
        },
        taskId: name,
        estimateStorage: async () => estimate,
      })
      const result = await store.ensureQuota({ requiredBytes })
      assert.equal(result.availableBytes, expectedAvailable)
      assert.equal(directoryCalls, 0)
    })
  }
})

test('quota rejects known length or conservative estimate beyond writable budget', async (t) => {
  for (const [name, requiredBytes, value] of [
    ['known length', 65 * 1024 * 1024, undefined],
    ['candidate estimate', undefined, { mediaMetadata: { durationMs: 30 * 60 * 1000 } }],
  ]) {
    await t.test(name, async () => {
      const store = createTaskOpfsStore({
        rootDirectory: createFileSystem(),
        taskId: name,
        estimateStorage: async () => ({ quota: 128 * 1024 * 1024, usage: 0 }),
      })
      await assert.rejects(
        store.ensureQuota({ requiredBytes, candidate: value }),
        /OPFS_QUOTA_EXCEEDED/,
      )
    })
  }
})

test('stream checks quota and 1 GiB before writing and removes partial task data', async (t) => {
  for (const [name, quota] of [
    ['writable quota', 128 * 1024 * 1024],
    ['hard limit', 4 * 1024 * 1024 * 1024],
  ]) {
    await t.test(name, async () => {
      const chunks = name === 'hard limit' ? [1024 * 1024 * 1024, 1] : [65 * 1024 * 1024]
      let cancelled = false
      let aborted = false
      let writes = 0
      let removed = false
      const reader = {
        async read() {
          const size = chunks.shift()
          return size == null ? { done: true } : { done: false, value: { byteLength: size } }
        },
        async cancel() {
          cancelled = true
        },
      }
      const tasksDirectory = {
        async getDirectoryHandle() {
          return {
            async getFileHandle() {
              return {
                async createWritable() {
                  return {
                    async write() {
                      writes += 1
                    },
                    async close() {},
                    async abort() {
                      aborted = true
                    },
                  }
                },
                async getFile() {
                  return new Blob()
                },
              }
            },
          }
        },
        async removeEntry() {
          removed = true
        },
      }
      const store = createTaskOpfsStore({
        rootDirectory: {
          async getDirectoryHandle() {
            return tasksDirectory
          },
        },
        taskId: `stream-${name}`,
        estimateStorage: async () => ({ quota, usage: 0 }),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers(name === 'hard limit' ? {} : { 'content-length': '1' }),
          body: { getReader: () => reader },
        }),
      })
      const expected =
        name === 'hard limit' ? /OPFS_TASK_SIZE_LIMIT_EXCEEDED/ : /OPFS_QUOTA_EXCEEDED/
      await assert.rejects(
        store.downloadCandidate({ platform: 'bilibili', candidate: candidate() }),
        expected,
      )
      assert.equal(cancelled, true)
      assert.equal(aborted, true)
      assert.equal(removed, true)
      assert.equal(writes, name === 'hard limit' ? 1 : 0)
    })
  }
})

test('task and root cleanup are idempotent and honor their signal', async () => {
  const removed = []
  const tasksDirectory = {
    async *values() {
      yield { name: 'one' }
      yield { name: 'two' }
    },
    async removeEntry(name) {
      removed.push(name)
    },
  }
  const root = {
    async getDirectoryHandle() {
      return tasksDirectory
    },
  }
  await cleanupVideoSummaryTaskDirectory({ rootDirectory: root, taskId: 'task' })
  await cleanupVideoSummaryTasksRoot({ rootDirectory: root })
  assert.deepEqual(removed, ['task', 'one', 'two'])

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    cleanupVideoSummaryTaskDirectory({
      rootDirectory: root,
      taskId: 'task',
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  )
})

async function createTerminalFixture(terminal) {
  const entries = new Set(['task-terminal'])
  const tasksDirectory = {
    async getDirectoryHandle(name) {
      if (!entries.has(name)) throw new DOMException('Missing', 'NotFoundError')
      return {}
    },
    async removeEntry(name) {
      if (!entries.delete(name)) throw new DOMException('Missing', 'NotFoundError')
    },
  }
  const rootDirectory = {
    async getDirectoryHandle() {
      return tasksDirectory
    },
  }
  return {
    async finish() {
      await cleanupVideoSummaryTaskDirectory({
        rootDirectory,
        taskId: 'task-terminal',
        signal: new AbortController().signal,
      })
    },
    async taskDirectoryExists() {
      try {
        await tasksDirectory.getDirectoryHandle('task-terminal')
        return true
      } catch (error) {
        if (error?.name === 'NotFoundError') return false
        throw error
      }
    },
    terminal,
  }
}

for (const terminal of [
  'success',
  'retryable-failure',
  'terminal-failure',
  'explicit-cancel',
  'navigation-delete',
  'disconnect-delete',
  'command-rejection-after-directory-create',
]) {
  test(`deletes OPFS after ${terminal}`, async () => {
    const fixture = await createTerminalFixture(terminal)
    await fixture.finish()
    assert.equal(await fixture.taskDirectoryExists(), false)
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
  assert.equal(await result.blob.text(), 'audio')
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
