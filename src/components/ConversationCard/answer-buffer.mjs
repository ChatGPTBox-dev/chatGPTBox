/**
 * Coalesces streamed answer text so a burst of chunks renders once per frame instead of
 * once per chunk, while never losing the newest text.
 * @param {object} params
 * @param {(callback: () => void) => unknown} params.requestFrame
 * @param {(handle: unknown) => void} params.cancelFrame
 * @param {(answer: string) => void} params.render
 */
export function createAnswerBuffer({ requestFrame, cancelFrame, render }) {
  let pending = null
  let frame = null

  const cancelPendingFrame = () => {
    if (frame === null) return
    cancelFrame(frame)
    frame = null
  }

  const takePending = () => {
    const answer = pending
    pending = null
    return answer
  }

  return {
    /** Queue the newest answer, scheduling a render only when none is already scheduled. */
    push(answer) {
      pending = answer
      if (frame !== null) return
      frame = requestFrame(() => {
        frame = null
        const latest = takePending()
        if (latest !== null) render(latest)
      })
    },
    /** Render the newest answer before the conversation is finalized. */
    flush() {
      cancelPendingFrame()
      const latest = takePending()
      if (latest !== null) render(latest)
    },
    /** Drop the newest answer without rendering it, e.g. when a retry starts. */
    discard() {
      cancelPendingFrame()
      pending = null
    },
  }
}
