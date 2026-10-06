import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeVideoSummaryOffscreenDocument,
  ensureVideoSummaryOffscreenDocument,
  resetVideoSummaryOffscreenDocument,
} from '../../../src/background/offscreen.mjs'

const offscreenUrl = 'chrome-extension://extension-id/VideoSummaryOffscreen.html'

function createRuntime(initialContexts = []) {
  let contexts = initialContexts
  return {
    getURL(path) {
      return `chrome-extension://extension-id/${path}`
    },
    async getContexts() {
      return contexts
    },
    clearContexts() {
      contexts = []
    },
    setOffscreenContext() {
      contexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }]
    },
  }
}

test('close removes an existing matching Offscreen document', async () => {
  const calls = []
  const runtime = createRuntime([
    {
      contextType: 'OFFSCREEN_DOCUMENT',
      documentUrl: offscreenUrl,
    },
  ])
  const closed = await closeVideoSummaryOffscreenDocument({
    runtime,
    chromeOffscreen: {
      async closeDocument() {
        calls.push('close')
        runtime.clearContexts()
      },
    },
  })
  assert.equal(closed, true)
  assert.deepEqual(calls, ['close'])
})

test('close returns false when no matching Offscreen document exists', async () => {
  const runtime = createRuntime([])
  const closed = await closeVideoSummaryOffscreenDocument({
    runtime,
    chromeOffscreen: {
      async closeDocument() {
        assert.fail('closeDocument must not be called')
      },
    },
  })

  assert.equal(closed, false)
})

test('reset closes stale state and creates one fresh document', async () => {
  const calls = []
  const runtime = createRuntime([
    {
      contextType: 'OFFSCREEN_DOCUMENT',
      documentUrl: offscreenUrl,
    },
  ])
  await resetVideoSummaryOffscreenDocument({
    runtime,
    chromeOffscreen: {
      async closeDocument() {
        calls.push('close')
        runtime.clearContexts()
      },
      async createDocument(options) {
        calls.push(['create', options])
        runtime.setOffscreenContext()
      },
    },
  })
  assert.equal(calls[0], 'close')
  assert.deepEqual(calls[1], [
    'create',
    {
      url: 'VideoSummaryOffscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Run the enhanced video summary task lifecycle.',
    },
  ])
})

test('concurrent ensure calls create one document', async () => {
  const runtime = createRuntime()
  let createCalls = 0
  let releaseCreation
  const creationBlocked = new Promise((resolve) => {
    releaseCreation = resolve
  })
  const chromeOffscreen = {
    async createDocument() {
      createCalls += 1
      await creationBlocked
      runtime.setOffscreenContext()
    },
  }

  const first = ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen })
  const second = ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen })
  await Promise.resolve()
  releaseCreation()
  await Promise.all([first, second])

  assert.equal(createCalls, 1)
})

test('concurrent reset calls share one close and fresh creation', async () => {
  const runtime = createRuntime([{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }])
  const calls = []
  const chromeOffscreen = {
    async closeDocument() {
      calls.push('close')
      runtime.clearContexts()
    },
    async createDocument() {
      calls.push('create')
      runtime.setOffscreenContext()
    },
  }

  await Promise.all([
    resetVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }),
    resetVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }),
  ])

  assert.deepEqual(calls, ['close', 'create'])
})

test('missing runtime and Offscreen APIs return stable unavailable errors', async () => {
  await assert.rejects(
    ensureVideoSummaryOffscreenDocument({ runtime: {}, chromeOffscreen: {} }),
    /VIDEO_SUMMARY_RUNTIME_UNAVAILABLE/,
  )
  await assert.rejects(
    closeVideoSummaryOffscreenDocument({
      runtime: createRuntime([{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }]),
      chromeOffscreen: {},
    }),
    /VIDEO_SUMMARY_OFFSCREEN_API_UNAVAILABLE/,
  )
  await assert.rejects(
    ensureVideoSummaryOffscreenDocument({ runtime: createRuntime(), chromeOffscreen: {} }),
    /VIDEO_SUMMARY_OFFSCREEN_API_UNAVAILABLE/,
  )
})

test('close failure propagates without creating a replacement', async () => {
  const runtime = createRuntime([{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }])
  let createCalls = 0

  await assert.rejects(
    resetVideoSummaryOffscreenDocument({
      runtime,
      chromeOffscreen: {
        async closeDocument() {
          throw new Error('close failed')
        },
        async createDocument() {
          createCalls += 1
        },
      },
    }),
    /close failed/,
  )

  assert.equal(createCalls, 0)
})
