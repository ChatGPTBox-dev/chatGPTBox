import Browser from 'webextension-polyfill'

/**
 * Messages that answer with data or reach stored credentials must come from extension
 * code. A sender that reports an id is trusted only when it is this extension; extension
 * pages in some browsers report no id, so their own URL is the fallback signal.
 * @param {{id?: string, url?: string, documentUrl?: string, origin?: string}} sender
 * @returns {boolean}
 */
export function isTrustedExtensionSender(sender) {
  if (sender?.id === Browser.runtime.id) return true
  if (sender?.id) return false
  const senderUrl = sender?.url || sender?.documentUrl || sender?.origin
  if (typeof senderUrl !== 'string') return false
  return senderUrl.startsWith(Browser.runtime.getURL('/'))
}
