import assert from 'node:assert/strict'
import test from 'node:test'
import { createMediaPipeline } from '../../../src/video-summary/media-pipeline.mjs'

function createCandidate(overrides = {}) {
  return {
    id: 'candidate-1',
    mediaMetadata: {
      kind: 'audio',
      container: 'audio/mp4',
      codec: 'mp4a.40.2',
      contentLength: 64,
      durationMs: 3200,
      bandwidth: 128000,
    },
    remoteCandidate: {
      url: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1790486400&token=secret',
      expiresAt: 1_790_486_400_000,
    },
    localFetchRecipe: {
      primaryUrl:
        'https://upos-sz-mirrorali.bilivideo.com/audio.m4s?deadline=1790486400&token=secret',
      backupUrls: [],
      credentialMode: 'include',
      requiredRequestOrigin: 'https://www.bilibili.com/',
    },
    ...overrides,
  }
}

function createSnapshot(overrides = {}) {
  return {
    platform: 'bilibili',
    videoId: 'BV1task6001',
    pageId: '9001',
    durationMs: 3200,
    mediaCandidates: [createCandidate()],
    ...overrides,
  }
}

function createClock(now = 1_700_000_000_000) {
  return { now: () => now }
}

function createFallbackError() {
  const error = new Error('MEDIAKIT_DIRECT_DOWNLOAD_FAILED')
  error.operation = 'submit-asr'
  error.providerCode = 'URL_DOWNLOAD_FAILED'
  error.httpStatus = 400
  return error
}

function createAbortError() {
  return new DOMException('Aborted', 'AbortError')
}

test('pipeline prefers direct MediaKit URL before local download', async () => {
  const calls = []
  const events = []
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr({ audioUrl }) {
        calls.push(audioUrl)
        return {
          durationMs: 1000,
          detectedLanguage: 'zh',
          segments: [{ id: 's1', startMs: 0, endMs: 1000, text: 'hello', speaker: 'S1' }],
        }
      },
    },
    opfsStoreFactory() {
      throw new Error('local fallback should not run')
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: createClock(),
  })

  const transcription = await pipeline.transcribeFromSource({
    taskId: 'task-1',
    owner: { tabId: 1, documentId: 'doc-1', videoId: 'BV1task6001' },
    sourceSnapshot: createSnapshot(),
    settingsSnapshot: { speakerIdentification: true },
    requestSourceRefresh: async () => {
      throw new Error('refresh should not run')
    },
    signal: new AbortController().signal,
    onEvent(event) {
      events.push(event)
    },
  })

  assert.deepEqual(calls, [
    'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1790486400&token=secret',
  ])
  assert.deepEqual(events, [{ stage: 'submitting-url' }])
  assert.equal(transcription.segments.length, 1)
})

test('pipeline refreshes an expired signed candidate once before retrying the direct submission', async () => {
  const calls = []
  const refreshCalls = []
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr({ audioUrl }) {
        calls.push(audioUrl)
        return {
          durationMs: 1500,
          detectedLanguage: 'zh',
          segments: [{ startMs: 0, endMs: 1500, text: 'fresh audio' }],
        }
      },
    },
    opfsStoreFactory() {
      throw new Error('local fallback should not run')
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: createClock(5000),
  })

  const transcription = await pipeline.transcribeFromSource({
    taskId: 'task-2',
    owner: {
      tabId: 7,
      documentId: 'doc-7',
      platform: 'bilibili',
      videoId: 'BV1task6001',
    },
    sourceSnapshot: createSnapshot({
      mediaCandidates: [
        createCandidate({
          remoteCandidate: {
            url: 'https://upos-sz-mirrorcos.bilivideo.com/stale-audio.m4s?deadline=1000&token=stale',
            expiresAt: 1000,
          },
          localFetchRecipe: {
            primaryUrl:
              'https://upos-sz-mirrorali.bilivideo.com/stale-audio.m4s?deadline=1000&token=stale',
            backupUrls: [],
            credentialMode: 'include',
            requiredRequestOrigin: 'https://www.bilibili.com/',
          },
        }),
      ],
    }),
    settingsSnapshot: { speakerIdentification: false },
    requestSourceRefresh: async (request) => {
      refreshCalls.push(request)
      return createSnapshot({
        mediaCandidates: [
          createCandidate({
            remoteCandidate: {
              url: 'https://upos-sz-mirrorcos.bilivideo.com/fresh-audio.m4s?deadline=1790486400&token=fresh',
              expiresAt: 1_790_486_400_000,
            },
            localFetchRecipe: {
              primaryUrl:
                'https://upos-sz-mirrorali.bilivideo.com/fresh-audio.m4s?deadline=1790486400&token=fresh',
              backupUrls: [],
              credentialMode: 'include',
              requiredRequestOrigin: 'https://www.bilibili.com/',
            },
          }),
        ],
      })
    },
    signal: new AbortController().signal,
    onEvent() {},
  })

  assert.equal(refreshCalls.length, 1)
  assert.deepEqual(refreshCalls[0], {
    owner: {
      tabId: 7,
      documentId: 'doc-7',
      platform: 'bilibili',
      videoId: 'BV1task6001',
    },
    taskId: 'task-2',
    expectedPlatform: 'bilibili',
    expectedVideoId: 'BV1task6001',
    reason: 'SIGNED_URL_EXPIRED',
  })
  assert.deepEqual(calls, [
    'https://upos-sz-mirrorcos.bilivideo.com/fresh-audio.m4s?deadline=1790486400&token=fresh',
  ])
  assert.equal(transcription.segments[0].text, 'fresh audio')
})

test('pipeline performs one signed upload fallback after a documented direct-download failure', async () => {
  const calls = []
  const events = []
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr({ audioUrl }) {
        calls.push(['submit', audioUrl])
        if (audioUrl.startsWith('https://')) {
          throw createFallbackError()
        }
        return {
          durationMs: 2100,
          detectedLanguage: 'zh',
          segments: [{ startMs: 0, endMs: 2100, text: 'uploaded audio' }],
        }
      },
      async requestUploadTarget() {
        calls.push(['request-upload-target'])
        return {
          fileReference: 'mediakit://file-42',
          method: 'PUT',
          url: 'https://tob-upload-y.volcvod.com/tos-vod-cn-v-fixture/mediakit/upload/local/fixture?Authorization=redacted',
          headers: {},
          credentials: 'omit',
          redirect: 'error',
        }
      },
    },
    opfsStoreFactory() {
      return {
        async ensureQuota({ requiredBytes }) {
          calls.push(['ensure-quota', requiredBytes])
          return { quotaBytes: 4096, usageBytes: 0, availableBytes: 4096 }
        },
        async downloadCandidate({ candidate, onProgress }) {
          calls.push(['download', candidate.localFetchRecipe.primaryUrl])
          onProgress?.({ bytesWritten: 64, totalBytes: 64 })
          return {
            blob: new Blob(['a'.repeat(64)], { type: 'audio/mp4' }),
            bytesWritten: 64,
            totalBytes: 64,
            contentType: 'audio/mp4',
          }
        },
        async uploadBlob({ target, blob, onProgress }) {
          calls.push(['upload', target.fileReference, blob.size])
          onProgress?.({ bytesWritten: blob.size, totalBytes: blob.size })
        },
        async cleanup() {
          calls.push(['cleanup'])
          return { attempts: 1, retrySucceeded: false, initialError: null }
        },
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: createClock(),
  })

  const transcription = await pipeline.transcribeFromSource({
    taskId: 'task-3',
    owner: { tabId: 8, documentId: 'doc-8', videoId: 'BV1task6001' },
    sourceSnapshot: createSnapshot(),
    settingsSnapshot: { speakerIdentification: true },
    requestSourceRefresh: async () =>
      createSnapshot({
        mediaCandidates: [
          createCandidate({
            remoteCandidate: {
              url: 'https://upos-sz-mirrorcos.bilivideo.com/refreshed-audio.m4s?deadline=1790486500&token=fresh',
              expiresAt: 1_790_486_500_000,
            },
            localFetchRecipe: {
              primaryUrl:
                'https://upos-sz-mirrorali.bilivideo.com/refreshed-audio.m4s?deadline=1790486500&token=fresh',
              backupUrls: [],
              credentialMode: 'include',
              requiredRequestOrigin: 'https://www.bilibili.com/',
            },
          }),
        ],
      }),
    signal: new AbortController().signal,
    onEvent(event) {
      events.push(event)
    },
  })

  assert.deepEqual(calls, [
    [
      'submit',
      'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1790486400&token=secret',
    ],
    [
      'submit',
      'https://upos-sz-mirrorcos.bilivideo.com/refreshed-audio.m4s?deadline=1790486500&token=fresh',
    ],
    ['ensure-quota', 64],
    [
      'download',
      'https://upos-sz-mirrorali.bilivideo.com/refreshed-audio.m4s?deadline=1790486500&token=fresh',
    ],
    ['request-upload-target'],
    ['upload', 'mediakit://file-42', 64],
    ['submit', 'mediakit://file-42'],
    ['cleanup'],
  ])
  assert.deepEqual(events, [
    { stage: 'submitting-url' },
    { stage: 'submitting-url' },
    { stage: 'downloading', bytesWritten: 64, totalBytes: 64 },
    { stage: 'uploading', bytesWritten: 64, totalBytes: 64 },
    { stage: 'submitting-upload' },
  ])
  assert.equal(transcription.segments[0].text, 'uploaded audio')
})

test('pipeline checks quota before downloading during the local fallback', async () => {
  const calls = []
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr() {
        throw createFallbackError()
      },
    },
    opfsStoreFactory() {
      return {
        async ensureQuota({ requiredBytes }) {
          calls.push(['ensure-quota', requiredBytes])
          const error = new Error('OPFS_QUOTA_EXCEEDED')
          error.availableBytes = 8
          error.requiredBytes = requiredBytes
          throw error
        },
        async downloadCandidate() {
          calls.push(['download'])
          throw new Error('download should not run')
        },
        async uploadBlob() {
          calls.push(['upload'])
          throw new Error('upload should not run')
        },
        async cleanup() {
          calls.push(['cleanup'])
        },
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: createClock(),
  })

  await assert.rejects(
    () =>
      pipeline.transcribeFromSource({
        taskId: 'task-4',
        owner: { tabId: 9, documentId: 'doc-9', videoId: 'BV1task6001' },
        sourceSnapshot: createSnapshot(),
        settingsSnapshot: { speakerIdentification: true },
        requestSourceRefresh: async () => createSnapshot(),
        signal: new AbortController().signal,
        onEvent() {},
      }),
    { message: 'OPFS_QUOTA_EXCEEDED' },
  )

  assert.deepEqual(calls, [['ensure-quota', 64], ['cleanup']])
})

test('pipeline cleans up task files when cancellation interrupts the local fallback', async () => {
  const calls = []
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr({ audioUrl }) {
        calls.push(['submit', audioUrl])
        throw createFallbackError()
      },
    },
    opfsStoreFactory() {
      return {
        async ensureQuota() {
          calls.push(['ensure-quota'])
          return { quotaBytes: 4096, usageBytes: 0, availableBytes: 4096 }
        },
        async downloadCandidate({ onProgress }) {
          calls.push(['download'])
          onProgress?.({ bytesWritten: 16, totalBytes: 64 })
          throw createAbortError()
        },
        async uploadBlob() {
          calls.push(['upload'])
          throw new Error('upload should not run')
        },
        async cleanup() {
          calls.push(['cleanup'])
        },
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    clock: createClock(),
  })

  await assert.rejects(
    () =>
      pipeline.transcribeFromSource({
        taskId: 'task-5',
        owner: { tabId: 10, documentId: 'doc-10', videoId: 'BV1task6001' },
        sourceSnapshot: createSnapshot(),
        settingsSnapshot: { speakerIdentification: true },
        requestSourceRefresh: async () => createSnapshot(),
        signal: new AbortController().signal,
        onEvent() {},
      }),
    { name: 'AbortError' },
  )

  assert.deepEqual(calls, [
    [
      'submit',
      'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1790486400&token=secret',
    ],
    [
      'submit',
      'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?deadline=1790486400&token=secret',
    ],
    ['ensure-quota'],
    ['download'],
    ['cleanup'],
  ])
})

test('pipeline rejects refreshed snapshots that change platform or video identity', async (t) => {
  for (const [name, refreshedSnapshot] of [
    ['platform', createSnapshot({ platform: 'youtube' })],
    ['video', createSnapshot({ videoId: 'BV1different' })],
  ]) {
    await t.test(name, async () => {
      const pipeline = createMediaPipeline({
        mediaKitGateway: {
          async submitDirectAsr() {
            assert.fail('identity mismatch must prevent submission')
          },
        },
        opfsStoreFactory() {
          assert.fail('identity mismatch must prevent fallback')
        },
        logger: { info() {}, warn() {}, error() {} },
        clock: createClock(5000),
      })

      await assert.rejects(
        () =>
          pipeline.transcribeFromSource({
            taskId: `task-changed-${name}`,
            owner: {
              tabId: 11,
              documentId: 'doc-11',
              platform: 'bilibili',
              videoId: 'BV1task6001',
            },
            sourceSnapshot: createSnapshot({
              mediaCandidates: [
                createCandidate({
                  remoteCandidate: {
                    url: 'https://upos-sz-mirrorcos.bilivideo.com/stale.m4s',
                    expiresAt: 1000,
                  },
                }),
              ],
            }),
            requestSourceRefresh: async ({ expectedPlatform, expectedVideoId }) => {
              assert.equal(expectedPlatform, 'bilibili')
              assert.equal(expectedVideoId, 'BV1task6001')
              return refreshedSnapshot
            },
            signal: new AbortController().signal,
          }),
        { message: 'VIDEO_SOURCE_IDENTITY_CHANGED' },
      )
    })
  }
})

test('pipeline rejects media policy violations before paid or fallback work', async (t) => {
  for (const [name, sourceSnapshot, expected] of [
    [
      'overlong duration',
      createSnapshot({ durationMs: 10_800_001 }),
      'VIDEO_MEDIA_DURATION_REJECTED',
    ],
    [
      'candidate duration mismatch',
      createSnapshot({
        mediaCandidates: [
          createCandidate({
            mediaMetadata: { ...createCandidate().mediaMetadata, durationMs: 5201 },
          }),
        ],
      }),
      'VIDEO_MEDIA_DURATION_MISMATCH',
    ],
    [
      'wrong CDN host',
      createSnapshot({
        mediaCandidates: [
          createCandidate({
            remoteCandidate: { url: 'https://evil.test/audio', expiresAt: null },
          }),
        ],
      }),
      'VIDEO_MEDIA_HOST_REJECTED',
    ],
  ]) {
    await t.test(name, async () => {
      let paidCalls = 0
      const pipeline = createMediaPipeline({
        mediaKitGateway: {
          async submitDirectAsr() {
            paidCalls += 1
          },
          async requestUploadTarget() {
            paidCalls += 1
          },
        },
        opfsStoreFactory() {
          assert.fail('policy rejection must prevent fallback')
        },
        logger: {},
        clock: createClock(),
      })
      await assert.rejects(
        pipeline.transcribeFromSource({
          taskId: `task-policy-${name}`,
          owner: { platform: 'bilibili', videoId: 'BV1task6001' },
          sourceSnapshot,
        }),
        new RegExp(expected),
      )
      assert.equal(paidCalls, 0)
    })
  }
})

test('unsupported local transport fails before download and upload target request', async () => {
  const calls = []
  const invalidCandidate = createCandidate({
    localFetchRecipe: {
      ...createCandidate().localFetchRecipe,
      headers: { Origin: 'https://www.bilibili.com' },
    },
  })
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr() {
        calls.push('submit')
        throw createFallbackError()
      },
      async requestUploadTarget() {
        calls.push('request-upload-target')
      },
    },
    opfsStoreFactory() {
      calls.push('create-store')
      return {
        async downloadCandidate() {
          calls.push('download')
        },
        async cleanup() {
          calls.push('cleanup')
        },
      }
    },
    logger: {},
    clock: createClock(),
  })

  await assert.rejects(
    pipeline.transcribeFromSource({
      taskId: 'task-unsupported-transport',
      owner: { platform: 'bilibili', videoId: 'BV1task6001' },
      sourceSnapshot: createSnapshot({ mediaCandidates: [invalidCandidate] }),
      requestSourceRefresh: async () => createSnapshot({ mediaCandidates: [invalidCandidate] }),
    }),
    /VIDEO_MEDIA_LOCAL_TRANSPORT_UNSUPPORTED/,
  )
  assert.deepEqual(calls, [])
})

test('pipeline reports a generic error when no media candidate exists', async () => {
  const pipeline = createMediaPipeline({
    mediaKitGateway: {},
    opfsStoreFactory() {},
    logger: { info() {}, warn() {}, error() {} },
    clock: createClock(),
  })

  await assert.rejects(
    () =>
      pipeline.transcribeFromSource({
        taskId: 'task-no-candidate',
        owner: { platform: 'youtube', videoId: 'video-1' },
        sourceSnapshot: { platform: 'youtube', videoId: 'video-1', mediaCandidates: [] },
      }),
    { message: 'VIDEO_MEDIA_CANDIDATE_NOT_FOUND' },
  )
})
