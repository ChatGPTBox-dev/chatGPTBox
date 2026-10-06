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

function createHarness({ target = { id: 'target-1' }, supported = true } = {}) {
  const state = {
    target,
    supported,
    bridges: [],
    mounts: [],
    intervals: new Map(),
    nextIntervalId: 1,
    waitCalls: [],
  }

  function createBridge() {
    const bridge = {
      id: `bridge-${state.bridges.length + 1}`,
      videoId: `video-${state.bridges.length + 1}`,
      listener: null,
      unsubscribeCount: 0,
      getCurrentVideoId() {
        return this.videoId
      },
      subscribeToVideoChanges(listener) {
        this.listener = listener
        return () => {
          this.unsubscribeCount += 1
          this.listener = null
        }
      },
    }
    state.bridges.push(bridge)
    return bridge
  }

  const controller = createVideoSummaryAdapterController({
    platform: 'youtube',
    createBridge,
    findTargetElement: () => state.target,
    waitForTargetElement: async () => {
      const pending = deferred()
      state.waitCalls.push(pending)
      return pending.promise
    },
    isPageSupported: () => state.supported,
    mountHost(options) {
      const mount = {
        ...options,
        disposed: false,
        dispose() {
          this.disposed = true
        },
      }
      state.mounts.push(mount)
      return mount
    },
    setIntervalFn(callback, delay) {
      const id = state.nextIntervalId
      state.nextIntervalId += 1
      state.intervals.set(id, { callback, delay })
      return id
    },
    clearIntervalFn(id) {
      state.intervals.delete(id)
    },
  })

  return { controller, state }
}

test('starts one healthy host and does not remount unchanged identity and target', async () => {
  const { controller, state } = createHarness()

  await controller.start()
  await controller.start()
  state.intervals.values().next().value.callback()
  await nextTask()

  assert.equal(state.bridges.length, 1)
  assert.equal(state.mounts.length, 1)
  assert.equal(state.mounts[0].platform, 'youtube')
  assert.equal(state.mounts[0].bridge, state.bridges[0])
  assert.equal(state.mounts[0].targetElement, state.target)
  assert.deepEqual(
    [...state.intervals.values()].map(({ delay }) => delay),
    [500],
  )
})

test('navigation replaces the bridge, subscription, and host', async () => {
  const { controller, state } = createHarness()
  await controller.start()

  state.bridges[0].listener()
  await waitFor(() => state.mounts.length === 2, 'navigation did not replace the host')

  assert.equal(state.bridges.length, 2)
  assert.equal(state.bridges[0].unsubscribeCount, 1)
  assert.equal(state.mounts[0].disposed, true)
  assert.equal(state.mounts[1].bridge, state.bridges[1])
})

test('target replacement remounts with the existing bridge', async () => {
  const { controller, state } = createHarness()
  await controller.start()
  state.target = { id: 'target-2' }

  state.intervals.values().next().value.callback()
  await waitFor(() => state.mounts.length === 2, 'target replacement did not remount')

  assert.equal(state.bridges.length, 1)
  assert.equal(state.mounts[0].disposed, true)
  assert.equal(state.mounts[1].bridge, state.bridges[0])
  assert.equal(state.mounts[1].targetElement, state.target)
})

test('temporary target absence disposes the host and recovery reuses the bridge', async () => {
  const { controller, state } = createHarness()
  await controller.start()
  state.target = null

  state.intervals.values().next().value.callback()
  await waitFor(() => state.waitCalls.length === 1, 'target absence did not start a wait')
  assert.equal(state.mounts[0].disposed, true)

  state.target = { id: 'target-2' }
  state.waitCalls[0].resolve(state.target)
  await waitFor(() => state.mounts.length === 2, 'target recovery did not remount')

  assert.equal(state.bridges.length, 1)
  assert.equal(state.mounts[1].bridge, state.bridges[0])
})

test('coalesces concurrent reconciliation and rejects a stale target wait', async () => {
  const { controller, state } = createHarness({ target: null })
  const start = controller.start()
  await waitFor(() => state.waitCalls.length === 1, 'initial target wait did not start')

  state.bridges[0].listener()
  state.bridges[0].listener()
  await waitFor(() => state.bridges.length === 2, 'navigation reconciliation did not run')
  assert.equal(state.waitCalls.length, 2)

  const staleTarget = { id: 'stale' }
  state.waitCalls[0].resolve(staleTarget)
  await nextTask()
  assert.equal(state.mounts.length, 0)

  state.target = { id: 'current' }
  state.waitCalls[1].resolve(state.target)
  await start
  await waitFor(() => state.mounts.length === 1, 'current target wait did not mount')

  assert.equal(state.bridges.length, 2)
  assert.equal(state.mounts[0].bridge, state.bridges[1])
  assert.equal(state.mounts[0].targetElement, state.target)
})

test('unsupported pages tear down and later recover with a replacement bridge', async () => {
  const { controller, state } = createHarness()
  await controller.start()
  state.supported = false

  state.bridges[0].listener()
  await waitFor(() => state.mounts[0].disposed, 'unsupported page did not tear down host')
  assert.equal(state.bridges[0].unsubscribeCount, 1)
  assert.equal(state.mounts.length, 1)

  state.supported = true
  state.bridges[1].listener()
  await waitFor(() => state.mounts.length === 2, 'supported page did not recover')
  assert.equal(state.mounts[1].bridge, state.bridges[2])
})

test('dispose releases host, subscription, monitor, and pending waits', async () => {
  const { controller, state } = createHarness()
  await controller.start()
  const callback = state.intervals.values().next().value.callback
  state.target = null
  callback()
  await waitFor(() => state.waitCalls.length === 1, 'target wait did not start before disposal')

  controller.dispose()
  callback()
  state.bridges[0].listener?.()
  state.waitCalls[0].resolve({ id: 'late-target' })
  await nextTask()

  assert.equal(state.mounts[0].disposed, true)
  assert.equal(state.bridges[0].unsubscribeCount, 1)
  assert.equal(state.intervals.size, 0)
  assert.equal(state.bridges.length, 1)
  assert.equal(state.mounts.length, 1)
})
