import { mountVideoSummaryHost } from './video-summary-host.mjs'

export function createVideoSummaryAdapterController({
  platform,
  createBridge,
  findTargetElement,
  waitForTargetElement,
  isPageSupported,
  mountHost = mountVideoSummaryHost,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let bridge = null
  let unsubscribe = null
  let host = null
  let hostBridge = null
  let targetElement = null
  let videoId = null
  let monitor = null
  let generation = 0
  let disposed = false
  let pendingReconciliation = null
  let reconciliation = null

  function disposeHost() {
    host?.dispose()
    host = null
    hostBridge = null
    targetElement = null
    videoId = null
  }

  function replaceBridge() {
    unsubscribe?.()
    bridge = createBridge()
    generation += 1
    unsubscribe = bridge.subscribeToVideoChanges(() => {
      void requestReconciliation({ replaceBridge: true })
    })
  }

  function waitForRecovery(expectedGeneration, expectedBridge, expectedVideoId) {
    void Promise.resolve(waitForTargetElement()).then((nextTarget) => {
      if (
        disposed ||
        generation !== expectedGeneration ||
        bridge !== expectedBridge ||
        bridge.getCurrentVideoId?.() !== expectedVideoId
      ) {
        return
      }
      void requestReconciliation({ targetElement: nextTarget })
    })
  }

  async function reconcile(options) {
    if (disposed) return
    if (options.replaceBridge || !bridge) replaceBridge()

    const expectedGeneration = generation
    const expectedBridge = bridge
    const expectedVideoId = bridge.getCurrentVideoId?.()
    if (!(await isPageSupported())) {
      disposeHost()
      return
    }
    if (
      disposed ||
      generation !== expectedGeneration ||
      bridge !== expectedBridge ||
      bridge.getCurrentVideoId?.() !== expectedVideoId
    ) {
      return
    }

    const nextTarget = options.targetElement || findTargetElement()
    if (!nextTarget) {
      disposeHost()
      waitForRecovery(expectedGeneration, expectedBridge, expectedVideoId)
      return
    }
    if (
      host &&
      hostBridge === expectedBridge &&
      targetElement === nextTarget &&
      videoId === expectedVideoId
    ) {
      return
    }

    disposeHost()
    host = mountHost({ platform, bridge: expectedBridge, targetElement: nextTarget })
    hostBridge = expectedBridge
    targetElement = nextTarget
    videoId = expectedVideoId
  }

  function requestReconciliation(options = {}) {
    if (disposed) return Promise.resolve()
    pendingReconciliation = {
      replaceBridge:
        pendingReconciliation?.replaceBridge === true || options.replaceBridge === true,
      targetElement: options.targetElement || pendingReconciliation?.targetElement || null,
    }
    if (!reconciliation) {
      reconciliation = Promise.resolve().then(async () => {
        while (pendingReconciliation && !disposed) {
          const nextOptions = pendingReconciliation
          pendingReconciliation = null
          await reconcile(nextOptions)
        }
      })
      reconciliation = reconciliation.finally(() => {
        reconciliation = null
      })
    }
    return reconciliation
  }

  return {
    async start() {
      if (disposed) return
      if (monitor === null) {
        monitor = setIntervalFn(() => {
          if (findTargetElement() !== targetElement) void requestReconciliation()
        }, 500)
      }
      await requestReconciliation()
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      pendingReconciliation = null
      if (monitor !== null) {
        clearIntervalFn(monitor)
        monitor = null
      }
      disposeHost()
      unsubscribe?.()
      unsubscribe = null
      bridge = null
    },
  }
}
