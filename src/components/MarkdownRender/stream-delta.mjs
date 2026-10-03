/**
 * Tracks what has already been handed to a streaming renderer, so a growing snapshot can
 * be fed to it as deltas. Returns null when there is nothing to do.
 * @returns {{ next: (content: string, done: boolean) => ({reset: boolean, write: string, finalize: boolean} | null) }}
 */
export function createStreamDelta() {
  let written = null
  let finalized = false

  return {
    next(content, done) {
      // The first snapshot, and one that no longer extends what was written, both start a
      // new render rather than growing the previous one.
      if (written === null || !content.startsWith(written)) {
        written = content
        finalized = done
        return { reset: true, write: content, finalize: done }
      }
      const delta = content.slice(written.length)
      if (delta) {
        written = content
        finalized = done
        return { reset: false, write: delta, finalize: done }
      }
      if (done && !finalized) {
        finalized = true
        return { reset: false, write: '', finalize: true }
      }
      return null
    },
  }
}
