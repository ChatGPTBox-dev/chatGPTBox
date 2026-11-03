import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

register('./tests/setup/video-summary-host-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

const { createVideoSummaryAdapterController } = await import(
  '../../../src/content-script/video-summary-adapter-controller.mjs'
)

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(message)
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function identity(platform, videoId, mediaId = videoId) {
  return { platform, videoId, mediaId }
}

function createHarness({ initialIdentity = null, initialMode = 'none', target = null } = {}) {
  const state = {
    identity: initialIdentity,
    mode: initialMode,
    target,
    listeners: new Set(),
    mounts: [],
    waitResults: [],
    intervals: new Map(),
    nextIntervalId: 1,
  }

  const mount = (mode) => async (options) => {
    const handle = {
      ...options,
      mode,
      connected: true,
      disposeCount: 0,
      dispose() {
        this.disposeCount += 1
        this.connected = false
      },
      isConnected() {
        return this.connected
      },
    }
    state.mounts.push(handle)
    return handle
  }

  const controller = createVideoSummaryAdapterController({
    getPageIdentity: () => state.identity,
    resolveMode: () => state.mode,
    mountEnhanced: mount('enhanced'),
    mountLegacy: mount('legacy'),
    subscribeToPageChanges(listener) {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    findTargetElement: () => state.target,
    waitForTargetElement: async () => {
      const result = deferred()
      state.waitResults.push(result)
      return result.promise
    },
    setIntervalFn(callback, delay) {
      const id = state.nextIntervalId++
      state.intervals.set(id, { callback, delay })
      return id
    },
    clearIntervalFn(id) {
      state.intervals.delete(id)
    },
  })

  const navigate = async ({ pageIdentity, mode, nextTarget = state.target }) => {
    state.identity = pageIdentity
    state.mode = mode
    state.target = nextTarget
    for (const listener of state.listeners) listener()
    await waitFor(
      () =>
        (mode === 'none' && liveHandles(state).length === 0) ||
        state.mounts.some(
          (handle) =>
            handle.mode === mode &&
            handle.pageIdentity?.mediaId === pageIdentity?.mediaId &&
            handle.disposeCount === 0,
        ),
      'navigation did not reconcile',
    )
  }

  return { controller, navigate, state }
}

function liveHandles(state) {
  return state.mounts.filter((handle) => handle.disposeCount === 0)
}

test('owns one handle across YouTube home, watch, live, Shorts, and unsupported transitions', async () => {
  const watchA = identity('youtube', 'SYNTHVID01A')
  const watchB = identity('youtube', 'SYNTHVID01B')
  const { controller, navigate, state } = createHarness()
  await controller.start()
  assert.equal(state.mounts.length, 0)

  await navigate({ pageIdentity: watchA, mode: 'enhanced', nextTarget: { id: 'secondary' } })
  assert.equal(liveHandles(state).length, 1)
  const first = liveHandles(state)[0]

  for (const listener of state.listeners) listener()
  await nextTask()
  assert.equal(state.mounts.length, 1)

  await navigate({ pageIdentity: watchB, mode: 'enhanced' })
  assert.equal(first.disposeCount, 1)
  assert.equal(liveHandles(state).length, 1)

  await navigate({ pageIdentity: watchB, mode: 'legacy' })
  assert.equal(liveHandles(state).length, 1)
  assert.equal(liveHandles(state)[0].mode, 'legacy')

  await navigate({ pageIdentity: watchB, mode: 'none' })
  assert.equal(liveHandles(state).length, 0)
  controller.dispose()
})

test('Bilibili BVID plus CID identity replacement disposes exactly once', async () => {
  const { controller, navigate, state } = createHarness({
    initialIdentity: identity('bilibili', 'BV1test', 'BV1test:100'),
    initialMode: 'enhanced',
    target: { id: 'danmuku' },
  })
  await controller.start()
  const first = state.mounts[0]

  await navigate({
    pageIdentity: identity('bilibili', 'BV1test', 'BV1test:200'),
    mode: 'enhanced',
  })

  assert.equal(first.disposeCount, 1)
  assert.equal(liveHandles(state).length, 1)
  assert.equal(liveHandles(state)[0].pageIdentity.mediaId, 'BV1test:200')
  controller.dispose()
  assert.equal(first.disposeCount, 1)
})

test('remounts when only the mounted host child becomes disconnected', async () => {
  const { controller, state } = createHarness({
    initialIdentity: identity('youtube', 'SYNTHVID01A'),
    initialMode: 'enhanced',
    target: { id: 'secondary' },
  })
  await controller.start()
  const first = state.mounts[0]
  first.connected = false

  state.intervals.values().next().value.callback()
  await waitFor(() => state.mounts.length === 2, 'disconnected child did not remount')

  assert.equal(first.disposeCount, 1)
  assert.equal(liveHandles(state).length, 1)
  assert.equal(state.mounts[1].pageGeneration > first.pageGeneration, true)
})

test('page generation rejects stale target waits and stale async mounts', async () => {
  const watchA = identity('youtube', 'SYNTHVID01A')
  const watchB = identity('youtube', 'SYNTHVID01B')
  const { controller, navigate, state } = createHarness({
    initialIdentity: watchA,
    initialMode: 'enhanced',
  })
  const start = controller.start()
  await waitFor(() => state.waitResults.length === 1, 'target wait did not start')

  state.identity = watchB
  state.target = { id: 'current' }
  for (const listener of state.listeners) listener()
  await waitFor(() => state.mounts.length === 1, 'current page did not mount')

  state.waitResults[0].resolve({ id: 'stale' })
  await start
  await nextTask()

  assert.equal(state.mounts.length, 1)
  assert.equal(state.mounts[0].pageIdentity.mediaId, watchB.mediaId)
  assert.equal(liveHandles(state).length, 1)
  await navigate({ pageIdentity: watchB, mode: 'enhanced' })
  assert.equal(state.mounts.length, 1)
})

test('dispose invalidates pending work and releases subscription and monitor', async () => {
  const { controller, state } = createHarness({
    initialIdentity: identity('youtube', 'SYNTHVID01A'),
    initialMode: 'enhanced',
  })
  const start = controller.start()
  await waitFor(() => state.waitResults.length === 1, 'target wait did not start')
  controller.dispose()
  state.waitResults[0].resolve({ id: 'late' })
  await start

  assert.equal(state.mounts.length, 0)
  assert.equal(state.listeners.size, 0)
  assert.equal(state.intervals.size, 0)
})
