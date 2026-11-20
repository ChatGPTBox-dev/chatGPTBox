import { VIDEO_SUMMARY_OFFSCREEN_PATH } from '../video-summary/contracts.mjs'

export { VIDEO_SUMMARY_OFFSCREEN_PORT_NAME } from '../video-summary/contracts.mjs'
const VIDEO_SUMMARY_OFFSCREEN_JUSTIFICATION = 'Run the enhanced video summary task lifecycle.'
const VIDEO_SUMMARY_OFFSCREEN_CONNECTION_TIMEOUT_MS = 10_000
let pendingOffscreenCreation = null
let pendingOffscreenReset = null

export function createVideoSummaryOffscreenConnectionWaiter({
  timeoutMs = VIDEO_SUMMARY_OFFSCREEN_CONNECTION_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  let attachedPort = null
  const waiters = new Set()

  return {
    attach(port) {
      attachedPort = port
      for (const waiter of waiters) {
        clearTimeoutImpl(waiter.timeoutId)
        waiter.resolve(port)
      }
      waiters.clear()
    },
    detach(port = attachedPort) {
      if (attachedPort === port) attachedPort = null
    },
    waitUntilConnected() {
      if (attachedPort) return Promise.resolve(attachedPort)
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timeoutId: null }
        waiter.timeoutId = setTimeoutImpl(() => {
          waiters.delete(waiter)
          reject(new Error('VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED'))
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
  }
}

function isMatchingOffscreenContext(context, offscreenUrl) {
  if (!context || typeof context !== 'object') return false
  if (context.contextType !== 'OFFSCREEN_DOCUMENT') return false
  return context.documentUrl === offscreenUrl
}

async function getMatchingOffscreenContexts(runtime, offscreenUrl) {
  if (typeof runtime?.getContexts !== 'function') return []

  try {
    const contexts = await runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    })
    return Array.isArray(contexts)
      ? contexts.filter((context) => isMatchingOffscreenContext(context, offscreenUrl))
      : []
  } catch {
    const contexts = await runtime.getContexts()
    return Array.isArray(contexts)
      ? contexts.filter((context) => isMatchingOffscreenContext(context, offscreenUrl))
      : []
  }
}

function getOffscreenUrl(runtime) {
  if (typeof runtime?.getURL !== 'function') {
    throw new Error('VIDEO_SUMMARY_RUNTIME_UNAVAILABLE')
  }
  return runtime.getURL(VIDEO_SUMMARY_OFFSCREEN_PATH)
}

export async function closeVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) {
  const offscreenUrl = getOffscreenUrl(runtime)
  if ((await getMatchingOffscreenContexts(runtime, offscreenUrl)).length === 0) return false
  if (typeof chromeOffscreen?.closeDocument !== 'function') {
    throw new Error('VIDEO_SUMMARY_OFFSCREEN_API_UNAVAILABLE')
  }

  await chromeOffscreen.closeDocument()
  return true
}

export async function ensureVideoSummaryOffscreenReady({ runtime, chromeOffscreen, connection }) {
  await ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen })
  await connection.waitUntilConnected()
}

export async function ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) {
  const offscreenUrl = getOffscreenUrl(runtime)
  if ((await getMatchingOffscreenContexts(runtime, offscreenUrl)).length > 0) return

  if (!pendingOffscreenCreation) {
    pendingOffscreenCreation = (async () => {
      if ((await getMatchingOffscreenContexts(runtime, offscreenUrl)).length > 0) return
      if (typeof chromeOffscreen?.createDocument !== 'function') {
        throw new Error('VIDEO_SUMMARY_OFFSCREEN_API_UNAVAILABLE')
      }

      await chromeOffscreen.createDocument({
        url: VIDEO_SUMMARY_OFFSCREEN_PATH,
        reasons: ['DOM_PARSER'],
        justification: VIDEO_SUMMARY_OFFSCREEN_JUSTIFICATION,
      })
    })()
  }

  try {
    await pendingOffscreenCreation
  } finally {
    pendingOffscreenCreation = null
  }
}

export async function resetVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) {
  if (!pendingOffscreenReset) {
    pendingOffscreenReset = (async () => {
      if (pendingOffscreenCreation) await pendingOffscreenCreation
      await closeVideoSummaryOffscreenDocument({ runtime, chromeOffscreen })
      await ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen })
    })()
  }

  try {
    await pendingOffscreenReset
  } finally {
    pendingOffscreenReset = null
  }
}
