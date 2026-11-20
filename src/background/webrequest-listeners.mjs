export const bingHeaderRewrites = {
  origin: 'https://www.bing.com',
  referer: 'https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx',
}

export const claudeHeaderRewrites = {
  origin: 'https://claude.ai',
  referer: 'https://claude.ai',
}

const rewriteHeaders = (headers, rewrites) => {
  let modified = false
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    if (!header || !header.name) {
      continue
    }
    const headerNameLower = header.name.toLowerCase()
    if (headerNameLower === 'origin') {
      header.value = rewrites.origin
      modified = true
    } else if (headerNameLower === 'referer') {
      header.value = rewrites.referer
      modified = true
    }
  }
  return modified
}

const createHeaderRewriteListener = (label, rewrites, logModified) => (details) => {
  // The browser hands out an array, so anything else means there is nothing
  // safe to rewrite; returning nothing leaves the request untouched instead of
  // handing the browser a requestHeaders value it would reject.
  if (!details || !Array.isArray(details.requestHeaders)) {
    return undefined
  }
  try {
    const modified = rewriteHeaders(details.requestHeaders, rewrites)
    if (!modified) return undefined
    if (logModified) {
      console.debug(
        `[background] Modified headers for ${label} (names only):`,
        details.requestHeaders.map((header) => header?.name).filter(Boolean),
      )
    }
    return { requestHeaders: details.requestHeaders }
  } catch (error) {
    // Only the URL is logged: `details` carries the full request headers, whose
    // values must never reach the logs.
    console.error(
      `[background] Error in ${label} onBeforeSendHeaders listener callback:`,
      error,
      details?.url,
    )
    // Discard the partial rewrite by returning no modification. The request
    // continues without applying this listener's rewritten headers.
    return undefined
  }
}

/**
 * Register the blocking onBeforeSendHeaders header rewrite listeners for Bing
 * and Claude.
 *
 * This project's manifest v2 grants `webRequestBlocking` and declares no DNR
 * rules. Its manifest v3 omits that permission and uses rules 1 and 3 in
 * rules.json to set Origin/Referer for Bing and Claude instead.
 *
 * The two mechanisms have different coverage:
 * - DNR matches `requestDomains` on any scheme and on sub-domains, so rule 1
 *   also rewrites requests the manifest v2 filters never match, such as
 *   `https://sydney.bing.com/*` or `wss://www.bing.com/*`, and rule 3 likewise
 *   covers sub-domains such as `https://api.claude.ai/*` on manifest v3.
 * - DNR's `set` operation also adds a header when the request has none, while
 *   these listeners only rewrite the entries a request already carries.
 *
 * Both listeners log rewrite errors and return no modification on failure or
 * invalid header arrays, leaving the request to continue. Bing additionally
 * logs header names after successful rewrites; header values are not logged.
 *
 * `extraHeaders` is deliberately absent from the extraInfoSpec even though
 * Chromium hides `Origin`/`Referer` from `onBeforeSendHeaders` without it:
 * Firefox rejects the value outright ("Invalid enumeration value"), and these
 * listeners only register on manifest v2, which is what manifest.v2.json and
 * the Safari build (derived from the Firefox build) ship. Manifest v3 targets
 * are served by the DNR rules, which do rewrite the headers.
 *
 * @param {object} webRequest the `Browser.webRequest` API object
 * @param {number} manifestVersion the active manifest version
 * @returns {number} how many listeners were registered
 */
export function registerBlockingHeaderListeners(webRequest, manifestVersion) {
  if (manifestVersion >= 3) return 0
  // A manifest that grants neither webRequest nor webRequestBlocking would have
  // no API here; the caller reports that through its own try/catch.
  const onBeforeSendHeaders = webRequest?.onBeforeSendHeaders
  if (typeof onBeforeSendHeaders?.addListener !== 'function') return 0

  onBeforeSendHeaders.addListener(
    createHeaderRewriteListener('Bing', bingHeaderRewrites, true),
    {
      urls: ['wss://sydney.bing.com/*', 'https://www.bing.com/*'],
      types: ['xmlhttprequest', 'websocket'],
    },
    ['requestHeaders', 'blocking'],
  )

  onBeforeSendHeaders.addListener(
    createHeaderRewriteListener('Claude', claudeHeaderRewrites, false),
    {
      urls: ['https://claude.ai/*'],
      types: ['xmlhttprequest'],
    },
    ['requestHeaders', 'blocking'],
  )

  return 2
}
