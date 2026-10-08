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

function createPollingHarness({ results, random = () => 0.5, startTime = 0 } = {}) {
  let now = startTime
  let queryIndex = 0
  const sleeps = []
  const queries = []
  const clock = {
    now: () => now,
    async sleep(ms, { signal } = {}) {
      assert.ok(ms >= 2000)
      assert.ok(ms <= 30000)
      assert.ok(signal)
      sleeps.push(ms)
      now += ms
    },
  }
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async queryTask({ taskId, signal }) {
        queries.push({ taskId, signal })
        const result = results[queryIndex]
        queryIndex += 1
        if (result instanceof Error) throw result
        return result
      },
    },
    opfsStoreFactory() {},
    logger: {},
    clock,
    random,
  })
  return { clock, pipeline, queries, sleeps }
}

function pending(retryAfterMs) {
  return retryAfterMs === undefined ? { status: 'pending' } : { status: 'pending', retryAfterMs }
}

function completed() {
  return { status: 'completed', result: { segments: [] } }
}

function transientError(message = 'temporary query failure') {
  const error = new TypeError(message)
  error.transient = true
  return error
}

test('MediaKit polling sleeps before the first query and exponentially backs off to 30 seconds', async () => {
  const harness = createPollingHarness({
    results: [pending(), pending(), pending(), pending(), pending(), pending(), completed()],
  })

  await harness.pipeline.pollMediaKitTask({
    taskId: 'provider-task',
    signal: new AbortController().signal,
  })

  assert.deepEqual(harness.sleeps, [2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.equal(harness.queries.length, 7)
})

test('MediaKit polling applies injectable jitter and clamps final delays to 2-30 seconds', async (t) => {
  for (const [name, random, expected] of [
    ['lower jitter', () => 0, [2000, 3200, 6400, 12800, 24000]],
    ['upper jitter', () => 1, [2400, 4800, 9600, 19200, 30000]],
  ]) {
    await t.test(name, async () => {
      const harness = createPollingHarness({
        random,
        results: [pending(), pending(), pending(), pending(), completed()],
      })
      await harness.pipeline.pollMediaKitTask({
        taskId: 'provider-task',
        signal: new AbortController().signal,
      })
      assert.deepEqual(harness.sleeps, expected)
    })
  }
})

test('MediaKit polling clamps retryAfterMs before applying jitter and final bounds', async (t) => {
  for (const [name, retryAfterMs, random, expected] of [
    ['below minimum', 1, () => 0.5, 2000],
    ['above maximum', 60000, () => 0.5, 30000],
    ['minimum with lower jitter', 2000, () => 0, 2000],
    ['maximum with upper jitter', 30000, () => 1, 30000],
  ]) {
    await t.test(name, async () => {
      const harness = createPollingHarness({
        results: [pending(retryAfterMs), completed()],
        random,
      })
      await harness.pipeline.pollMediaKitTask({
        taskId: 'provider-task',
        signal: new AbortController().signal,
      })
      assert.equal(harness.sleeps[1], expected)
    })
  }
})

test('MediaKit polling clamps transient retryAfterMs before applying jitter', async () => {
  const error = transientError()
  error.retryAfterMs = 60000
  const harness = createPollingHarness({ results: [error, completed()] })

  await harness.pipeline.pollMediaKitTask({
    taskId: 'provider-task',
    signal: new AbortController().signal,
  })

  assert.deepEqual(harness.sleeps, [2000, 30000])
})

test('MediaKit polling stops on five consecutive transient failures', async () => {
  const harness = createPollingHarness({
    results: Array.from({ length: 5 }, () => transientError()),
  })

  await assert.rejects(
    harness.pipeline.pollMediaKitTask({
      taskId: 'provider-task',
      signal: new AbortController().signal,
    }),
    /temporary query failure/,
  )

  assert.equal(harness.queries.length, 5)
  assert.deepEqual(harness.sleeps, [2000, 2000, 2000, 2000, 2000])
})

test('a valid pending response resets the consecutive transient failure count', async () => {
  const failures = Array.from({ length: 4 }, () => transientError())
  const harness = createPollingHarness({
    results: [...failures, pending(), ...failures, completed()],
  })

  await harness.pipeline.pollMediaKitTask({
    taskId: 'provider-task',
    signal: new AbortController().signal,
  })

  assert.equal(harness.queries.length, 10)
})

test('MediaKit polling stops exactly at the two-hour deadline without another query', async () => {
  const harness = createPollingHarness({
    results: Array.from({ length: 243 }, () => pending()),
  })

  await assert.rejects(
    harness.pipeline.pollMediaKitTask({
      taskId: 'provider-task',
      signal: new AbortController().signal,
    }),
    /MEDIAKIT_POLL_DEADLINE_EXCEEDED/,
  )

  assert.equal(
    harness.sleeps.reduce((total, delay) => total + delay, 0),
    7_200_000,
  )
  assert.equal(harness.queries.length, harness.sleeps.length - 1)
})

test('aborting during polling sleep clears the timer and prevents another query', async () => {
  const controller = new AbortController()
  let activeTimers = 0
  const clock = {
    now: () => 0,
    sleep(ms, { signal }) {
      assert.equal(ms, 2000)
      activeTimers += 1
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          activeTimers -= 1
          signal.removeEventListener('abort', onAbort)
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
  let queries = 0
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async queryTask() {
        queries += 1
      },
    },
    opfsStoreFactory() {},
    logger: {},
    clock,
    random: () => 0.5,
  })
  const polling = pipeline.pollMediaKitTask({ taskId: 'provider-task', signal: controller.signal })
  controller.abort(createAbortError())

  await assert.rejects(polling, { name: 'AbortError' })
  assert.equal(queries, 0)
  assert.equal(activeTimers, 0)
})

test('terminal polling results leave no timer and never use a Promise.resolve busy loop', async () => {
  let activeTimers = 0
  let sleepCalls = 0
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async queryTask() {
        return completed()
      },
    },
    opfsStoreFactory() {},
    logger: {},
    clock: {
      now: () => 0,
      async sleep(ms, { signal }) {
        assert.equal(ms, 2000)
        assert.ok(signal)
        sleepCalls += 1
        activeTimers += 1
        activeTimers -= 1
      },
    },
    random: () => 0.5,
  })

  await pipeline.pollMediaKitTask({
    taskId: 'provider-task',
    signal: new AbortController().signal,
  })

  assert.equal(sleepCalls, 1)
  assert.equal(activeTimers, 0)
})

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

  assert.deepEqual(calls, [['ensure-quota', 64]])
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
  ])
})

test('stream overflow fails before upload target request', async () => {
  let uploadTargetCalls = 0
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr() {
        throw createFallbackError()
      },
      async requestUploadTarget() {
        uploadTargetCalls += 1
      },
    },
    opfsStoreFactory() {
      return {
        async ensureQuota() {},
        async downloadCandidate() {
          throw new Error('OPFS_TASK_SIZE_LIMIT_EXCEEDED')
        },
      }
    },
    logger: {},
    clock: createClock(),
  })
  await assert.rejects(
    pipeline.transcribeFromSource({
      taskId: 'task-stream-overflow',
      owner: { platform: 'bilibili', videoId: 'BV1task6001' },
      sourceSnapshot: createSnapshot(),
      requestSourceRefresh: async () => createSnapshot(),
    }),
    /OPFS_TASK_SIZE_LIMIT_EXCEEDED/,
  )
  assert.equal(uploadTargetCalls, 0)
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

test('pipeline logs only allowlisted metadata at media failure boundaries', async () => {
  const entries = []
  const sensitiveError = Object.assign(new Error('SECRET_ERROR_MESSAGE'), {
    code: 'VIDEO_SUMMARY_FETCH_FAILED',
    operation: 'submitDirectAsr',
    providerCode: 'DOWNLOAD_FAILED',
    httpStatus: 503,
    requestId: 'req_pipeline-1',
    providerBody: 'SECRET_PROVIDER_BODY',
    prompt: 'SECRET_PROMPT',
    transcript: 'SECRET_TRANSCRIPT',
    nested: { token: 'SECRET_TOKEN' },
  })
  const pipeline = createMediaPipeline({
    mediaKitGateway: {
      async submitDirectAsr() {
        throw sensitiveError
      },
    },
    opfsStoreFactory() {},
    logger: {
      info(entry) {
        entries.push(entry)
      },
      warn(entry) {
        entries.push(entry)
      },
    },
    clock: createClock(),
  })

  await assert.rejects(
    pipeline.transcribeFromSource({
      taskId: 'task-SECRET_TASK_ID',
      owner: { platform: 'bilibili', videoId: 'BV1task6001' },
      sourceSnapshot: createSnapshot(),
    }),
    sensitiveError,
  )

  assert.deepEqual(entries, [
    {
      event: 'video-summary.media.submit-direct',
      operation: 'submitDirectAsr',
    },
    {
      event: 'video-summary.media.direct-failed',
      operation: 'submitDirectAsr',
      code: 'VIDEO_SUMMARY_FETCH_FAILED',
      providerCode: 'DOWNLOAD_FAILED',
      httpStatus: 503,
      requestId: 'req_pipeline-1',
      refreshed: false,
    },
  ])
  const logs = JSON.stringify(entries)
  for (const sentinel of [
    'SECRET_ERROR_MESSAGE',
    'SECRET_PROVIDER_BODY',
    'SECRET_PROMPT',
    'SECRET_TRANSCRIPT',
    'SECRET_TOKEN',
    'SECRET_TASK_ID',
    'token=secret',
  ]) {
    assert.equal(logs.includes(sentinel), false, sentinel)
  }
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
