import { VIDEO_SUMMARY_OFFSCREEN_PATH } from '../video-summary/contracts.mjs'
import { createVideoSummaryOwner, parsePageIdentity } from '../video-summary/protocol.mjs'

const CONTENT_PORT_UNAUTHORIZED = 'VIDEO_SUMMARY_CONTENT_PORT_UNAUTHORIZED'
const OFFSCREEN_PORT_UNAUTHORIZED = 'VIDEO_SUMMARY_OFFSCREEN_PORT_UNAUTHORIZED'

function unauthorized(code) {
  throw new Error(code)
}

function parseSenderUrl(value, code) {
  if (typeof value !== 'string') unauthorized(code)
  try {
    return new URL(value)
  } catch {
    return unauthorized(code)
  }
}

function isPlatformHost(hostname, platform) {
  const domain = platform === 'bilibili' ? 'bilibili.com' : 'youtube.com'
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

export function authenticateVideoSummaryContentPort({ port, runtime, pageIdentity }) {
  const sender = port?.sender
  if (sender?.id !== runtime?.id) unauthorized(CONTENT_PORT_UNAUTHORIZED)
  if (!Number.isSafeInteger(sender?.tab?.id)) unauthorized(CONTENT_PORT_UNAUTHORIZED)
  if (sender?.frameId !== 0) unauthorized(CONTENT_PORT_UNAUTHORIZED)

  const documentId = typeof sender?.documentId === 'string' ? sender.documentId.trim() : ''
  if (!documentId) unauthorized(CONTENT_PORT_UNAUTHORIZED)

  let parsedPageIdentity
  try {
    parsedPageIdentity = parsePageIdentity(pageIdentity)
  } catch {
    return unauthorized(CONTENT_PORT_UNAUTHORIZED)
  }

  const senderUrl = parseSenderUrl(sender?.url ?? sender?.documentUrl, CONTENT_PORT_UNAUTHORIZED)
  if (
    senderUrl.protocol !== 'https:' ||
    !isPlatformHost(senderUrl.hostname, parsedPageIdentity.platform)
  ) {
    unauthorized(CONTENT_PORT_UNAUTHORIZED)
  }

  const owner = createVideoSummaryOwner({
    tabId: sender.tab.id,
    documentId,
    platform: parsedPageIdentity.platform,
    mediaId: parsedPageIdentity.mediaId,
  })
  return {
    tabId: sender.tab.id,
    documentId,
    frameId: 0,
    pageIdentity: parsedPageIdentity,
    owner,
  }
}

export function authenticateVideoSummaryOffscreenPort({ port, runtime }) {
  const sender = port?.sender
  const documentUrl = runtime?.getURL?.(VIDEO_SUMMARY_OFFSCREEN_PATH)
  if (
    sender?.id !== runtime?.id ||
    sender?.tab !== undefined ||
    parseSenderUrl(sender?.url ?? sender?.documentUrl, OFFSCREEN_PORT_UNAUTHORIZED).href !==
      documentUrl
  ) {
    unauthorized(OFFSCREEN_PORT_UNAUTHORIZED)
  }
  return { documentUrl }
}
