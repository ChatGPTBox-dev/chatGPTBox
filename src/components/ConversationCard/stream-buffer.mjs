/**
 * Animation frames are the fastest way to coalesce a burst of updates, but not every host
 * has them (jsdom and other headless renderers do not). Fall back to a timer there so the
 * buffer can always be created.
 * @param {typeof globalThis} [host]
 * @returns {{requestFrame: (callback: () => void) => unknown, cancelFrame: (handle: unknown) => void}}
 */
export function createFrameScheduler(host = globalThis) {
  if (
    typeof host.requestAnimationFrame === 'function' &&
    typeof host.cancelAnimationFrame === 'function'
  ) {
    return {
      requestFrame: (callback) => host.requestAnimationFrame(callback),
      cancelFrame: (handle) => host.cancelAnimationFrame(handle),
    }
  }
  return {
    requestFrame: (callback) => setTimeout(callback, 16),
    cancelFrame: (handle) => clearTimeout(handle),
  }
}

/**
 * Coalesces a burst of streamed patches into one render per frame. A patch only carries the
 * fields it changes and later values win, so an answer chunk and a reasoning chunk that
 * arrive together reach the state in a single update instead of two.
 * @param {object} params
 * @param {(callback: () => void) => unknown} params.requestFrame
 * @param {(handle: unknown) => void} params.cancelFrame
 * @param {(patch: object) => void} params.render
 */
export function createStreamBuffer({ requestFrame, cancelFrame, render }) {
  let pending = null
  let frame = null

  const cancelPendingFrame = () => {
    if (frame === null) return
    cancelFrame(frame)
    frame = null
  }

  const takePending = () => {
    const patch = pending
    pending = null
    return patch
  }

  return {
    /** Merge a patch in, scheduling a render only when none is already scheduled. */
    push(patch) {
      pending = { ...pending, ...patch }
      if (frame !== null) return
      frame = requestFrame(() => {
        frame = null
        const latest = takePending()
        if (latest !== null) render(latest)
      })
    },
    /** Render the newest patch before the conversation is finalized. */
    flush() {
      cancelPendingFrame()
      const latest = takePending()
      if (latest !== null) render(latest)
    },
    /** Drop the newest patch without rendering it, e.g. when a retry starts. */
    discard() {
      cancelPendingFrame()
      pending = null
    },
  }
}
