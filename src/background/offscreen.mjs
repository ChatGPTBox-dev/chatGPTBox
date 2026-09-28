import { VIDEO_SUMMARY_OFFSCREEN_PATH } from '../video-summary/contracts.mjs'

export { VIDEO_SUMMARY_OFFSCREEN_PORT_NAME } from '../video-summary/contracts.mjs'
const VIDEO_SUMMARY_OFFSCREEN_JUSTIFICATION =
  'Run the Bilibili video summary offscreen task lifecycle.'
let pendingOffscreenCreation = null

function isMatchingOffscreenContext(context, offscreenUrl) {
  if (!context || typeof context !== 'object') return false
  if (context.contextType !== 'OFFSCREEN_DOCUMENT') return false
  return (
    context.documentUrl === offscreenUrl || context.documentUrl === VIDEO_SUMMARY_OFFSCREEN_PATH
  )
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

export async function ensureVideoSummaryOffscreenDocument({ runtime, chromeOffscreen }) {
  if (typeof runtime?.getURL !== 'function') {
    throw new Error('VIDEO_SUMMARY_RUNTIME_UNAVAILABLE')
  }

  const offscreenUrl = runtime.getURL(VIDEO_SUMMARY_OFFSCREEN_PATH)
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
