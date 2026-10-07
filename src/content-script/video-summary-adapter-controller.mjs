import { pageIdentitiesEqual } from '../video-summary/protocol.mjs'

export function createVideoSummaryAdapterController({
  getPageIdentity,
  resolveMode,
  mountEnhanced,
  mountLegacy,
  subscribeToPageChanges,
  findTargetElement,
  waitForTargetElement,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let pageIdentity = null
  let pageGeneration = 0
  let reconciliationRevision = 0
  let mode = 'none'
  let handle = null
  let targetElement = null
  let unsubscribe = null
  let monitor = null
  let disposed = false
  let requested = false
  let reconciliation = null

  const identitiesEqual = (left, right) =>
    (left === null && right === null) || pageIdentitiesEqual(left, right)

  function isCurrentPage(expectedIdentity, expectedGeneration) {
    return (
      !disposed &&
      pageGeneration === expectedGeneration &&
      identitiesEqual(pageIdentity, expectedIdentity)
    )
  }

  function disposeHandle() {
    handle?.dispose()
    handle = null
    targetElement = null
  }

  async function mountMode({ expectedIdentity, expectedGeneration, expectedMode, target }) {
    const mount = expectedMode === 'enhanced' ? mountEnhanced : mountLegacy
    const nextHandle = await mount({
      pageIdentity: expectedIdentity,
      pageGeneration: expectedGeneration,
      targetElement: target,
      isCurrentPage: () => isCurrentPage(expectedIdentity, expectedGeneration),
    })
    if (!isCurrentPage(expectedIdentity, expectedGeneration) || mode !== expectedMode) {
      nextHandle?.dispose()
      return
    }
    if (
      !nextHandle ||
      typeof nextHandle.dispose !== 'function' ||
      typeof nextHandle.isConnected !== 'function'
    ) {
      nextHandle?.dispose?.()
      throw new Error('VIDEO_SUMMARY_PAGE_HANDLE_INVALID')
    }
    handle = nextHandle
    targetElement = target
  }

  async function reconcile(expectedRevision) {
    const nextIdentity = (await getPageIdentity()) || null
    if (disposed || reconciliationRevision !== expectedRevision) return
    const nextMode = await resolveMode({ pageIdentity: nextIdentity })
    if (disposed || reconciliationRevision !== expectedRevision) return
    if (!['enhanced', 'legacy', 'none'].includes(nextMode)) {
      throw new Error('VIDEO_SUMMARY_PAGE_MODE_INVALID')
    }

    const identityChanged = !identitiesEqual(pageIdentity, nextIdentity)
    const modeChanged = mode !== nextMode
    const disconnected = Boolean(handle && !handle.isConnected())
    const nextTarget = nextMode === 'none' ? null : findTargetElement()
    const targetChanged = targetElement !== nextTarget
    if (!identityChanged && !modeChanged && !disconnected && !targetChanged) return

    pageGeneration += 1
    const expectedGeneration = pageGeneration
    pageIdentity = nextIdentity
    mode = nextMode
    disposeHandle()
    if (nextMode === 'none' || !nextIdentity) return

    if (!nextTarget) {
      void Promise.resolve(waitForTargetElement()).then((resolvedTarget) => {
        if (!resolvedTarget || !isCurrentPage(nextIdentity, expectedGeneration)) return
        return mountMode({
          expectedIdentity: nextIdentity,
          expectedGeneration,
          expectedMode: nextMode,
          target: resolvedTarget,
        })
      })
      return
    }

    await mountMode({
      expectedIdentity: nextIdentity,
      expectedGeneration,
      expectedMode: nextMode,
      target: nextTarget,
    })
  }

  function requestReconciliation() {
    if (disposed) return Promise.resolve()
    reconciliationRevision += 1
    requested = true
    if (!reconciliation) {
      reconciliation = Promise.resolve().then(async () => {
        while (requested && !disposed) {
          requested = false
          const expectedRevision = reconciliationRevision
          await reconcile(expectedRevision)
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
      if (!unsubscribe) unsubscribe = subscribeToPageChanges(() => void requestReconciliation())
      if (monitor === null) {
        monitor = setIntervalFn(() => {
          const nextTarget = mode === 'none' ? null : findTargetElement()
          if (nextTarget !== targetElement || (handle && !handle.isConnected())) {
            void requestReconciliation()
          }
        }, 500)
      }
      await requestReconciliation()
    },
    dispose() {
      if (disposed) return
      disposed = true
      pageGeneration += 1
      requested = false
      if (monitor !== null) clearIntervalFn(monitor)
      monitor = null
      unsubscribe?.()
      unsubscribe = null
      disposeHandle()
    },
  }
}
