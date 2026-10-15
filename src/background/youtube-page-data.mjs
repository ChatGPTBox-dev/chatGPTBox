export function readYouTubeMainWorldPlayerResponse(expectedVideoId) {
  const parseCandidate = (candidate) => {
    if (typeof candidate === 'string') {
      try {
        return JSON.parse(candidate)
      } catch {
        return null
      }
    }
    return candidate && typeof candidate === 'object' ? candidate : null
  }

  const candidates = [
    globalThis.ytInitialPlayerResponse,
    globalThis.ytplayer?.bootstrapPlayerResponse,
    globalThis.ytplayer?.config?.args?.raw_player_response,
  ]
  try {
    candidates.push(globalThis.movie_player?.getPlayerResponse?.())
  } catch {
    candidates.push(null)
  }

  for (const candidate of candidates) {
    const playerResponse = parseCandidate(candidate)
    if (playerResponse?.videoDetails?.videoId === expectedVideoId) return playerResponse
  }
  return null
}

export async function captureYouTubeMainWorldCaption(
  expectedVideoId,
  requestedTrack,
  timeoutMs,
  maxResponseBytes = 5 * 1024 * 1024,
) {
  const player = globalThis.movie_player || document.querySelector('#movie_player')
  const ccButton = document.querySelector('.ytp-subtitles-button.ytp-button, .ytp-subtitles-button')
  const currentVideoId = () => player?.getPlayerResponse?.()?.videoDetails?.videoId
  if (currentVideoId() !== expectedVideoId) {
    throw new Error('YOUTUBE_PLAYER_RESPONSE_IDENTITY_MISMATCH')
  }

  const descriptor =
    requestedTrack && typeof requestedTrack === 'object'
      ? requestedTrack
      : { language: String(requestedTrack || '') }
  const originalFetch = globalThis.fetch
  const originalOpen = globalThis.XMLHttpRequest?.prototype?.open
  const wasEnabled = ccButton?.getAttribute('aria-pressed') === 'true'
  const originalTrack = player.getOption?.('captions', 'track')
  const deadline = Date.now() + timeoutMs
  let settleCapture
  let settled = false
  const capture = new Promise((resolve) => {
    settleCapture = resolve
  })

  const bodySize = (body) => {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(body).byteLength
    return body.length * 2
  }
  const acceptResponse = (rawUrl, rawBody) => {
    const body = typeof rawBody === 'string' ? rawBody : ''
    if (settled || !body.trim() || bodySize(body) > maxResponseBytes) return
    try {
      const url = new URL(String(rawUrl), location.href)
      if (
        currentVideoId() !== expectedVideoId ||
        new URL(location.href).searchParams.get('v') !== expectedVideoId ||
        url.pathname !== '/api/timedtext' ||
        url.searchParams.get('v') !== expectedVideoId ||
        url.searchParams.get('type') === 'list'
      ) {
        return
      }
      const responseLanguage = url.searchParams.get('tlang') || url.searchParams.get('lang')
      const requestedBase = String(descriptor.language || '').split('-')[0]
      const responseBase = String(responseLanguage || '').split('-')[0]
      if (
        descriptor.language &&
        responseLanguage &&
        descriptor.language !== responseLanguage &&
        requestedBase !== responseBase
      ) {
        return
      }
      const responseKind = url.searchParams.get('kind') === 'asr' ? 'automatic' : 'author'
      if (descriptor.sourceKind && responseKind !== descriptor.sourceKind) return
      settled = true
      settleCapture({
        body,
        videoId: expectedVideoId,
        language: responseLanguage || descriptor.language || null,
      })
    } catch {
      return
    }
  }

  function hookedFetch(input, init) {
    const rawUrl = typeof input === 'string' ? input : input?.url || String(input)
    const responsePromise = originalFetch.call(this, input, init)
    if (String(rawUrl).includes('/api/timedtext')) {
      void responsePromise
        .then((response) => {
          const length = Number(response.headers?.get?.('content-length'))
          if (Number.isFinite(length) && length > maxResponseBytes) return ''
          return response.clone().text()
        })
        .then((body) => acceptResponse(rawUrl, body))
        .catch(() => {})
    }
    return responsePromise
  }

  function hookedOpen(method, url, ...rest) {
    const rawUrl = String(url)
    if (rawUrl.includes('/api/timedtext')) {
      this.addEventListener(
        'load',
        () => {
          try {
            if (!this.responseType || this.responseType === 'text') {
              acceptResponse(rawUrl, this.responseText)
            }
          } catch {
            return
          }
        },
        { once: true },
      )
    }
    return originalOpen.call(this, method, url, ...rest)
  }

  globalThis.fetch = hookedFetch
  if (originalOpen) globalThis.XMLHttpRequest.prototype.open = hookedOpen

  try {
    player.loadModule?.('captions')
    let tracks = player.getOption?.('captions', 'tracklist', { includeAsr: true }) || []
    while (tracks.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (
        currentVideoId() !== expectedVideoId ||
        new URL(location.href).searchParams.get('v') !== expectedVideoId
      ) {
        throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
      }
      tracks = player.getOption?.('captions', 'tracklist', { includeAsr: true }) || []
    }
    const languageBase = String(descriptor.language || '').split('-')[0]
    const sourceKindOf = (track) =>
      track?.kind === 'asr' || String(track?.vssId || '').startsWith('a.') ? 'automatic' : 'author'
    const track =
      tracks.find((item) => descriptor.vssId && item?.vssId === descriptor.vssId) ||
      tracks.find(
        (item) =>
          item?.languageCode === descriptor.language &&
          (!descriptor.sourceKind || sourceKindOf(item) === descriptor.sourceKind),
      ) ||
      tracks.find(
        (item) =>
          String(item?.languageCode || '').split('-')[0] === languageBase &&
          (!descriptor.sourceKind || sourceKindOf(item) === descriptor.sourceKind),
      )
    if (!track) throw new Error('YOUTUBE_CAPTION_TRACK_NOT_FOUND')
    player.setOption?.('captions', 'track', track)
    if (!wasEnabled && ccButton?.getAttribute('aria-pressed') !== 'true') ccButton?.click()
    let timeout
    try {
      const result = await Promise.race([
        capture,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            settled = true
            reject(
              new Error(
                currentVideoId() === expectedVideoId &&
                new URL(location.href).searchParams.get('v') === expectedVideoId
                  ? 'YOUTUBE_TIMED_TEXT_CAPTURE_TIMEOUT'
                  : 'VIDEO_SOURCE_IDENTITY_CHANGED',
              ),
            )
          }, Math.max(0, deadline - Date.now()))
        }),
      ])
      if (currentVideoId() !== expectedVideoId) throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
      return result
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    if (globalThis.fetch === hookedFetch) globalThis.fetch = originalFetch
    if (originalOpen && globalThis.XMLHttpRequest?.prototype?.open === hookedOpen) {
      globalThis.XMLHttpRequest.prototype.open = originalOpen
    }
    if (currentVideoId() === expectedVideoId) {
      player.setOption?.('captions', 'track', originalTrack)
    }
    if (currentVideoId() === expectedVideoId && ccButton) {
      const isEnabled = ccButton.getAttribute('aria-pressed') === 'true'
      if (isEnabled !== wasEnabled) ccButton.click()
    }
  }
}

export async function readYouTubeInnertubeTranscript(
  expectedVideoId,
  suppliedContinuation,
  timeoutMs,
  maxResponseBytes = 5 * 1024 * 1024,
) {
  const currentVideoId = () => new URL(location.href).searchParams.get('v')
  if (currentVideoId() !== expectedVideoId) throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')

  const readTranscriptEndpoint = (initialData) => {
    const panels = Array.isArray(initialData?.engagementPanels) ? initialData.engagementPanels : []
    let continuation = null
    for (const entry of panels) {
      const panel = entry?.engagementPanelSectionListRenderer
      if (panel?.targetId !== 'engagement-panel-searchable-transcript') continue
      const pending = [panel.content]
      const seen = new Set()
      while (pending.length > 0) {
        const value = pending.pop()
        if (!value || typeof value !== 'object' || seen.has(value)) continue
        seen.add(value)
        const endpoints = [value, value.continuationEndpoint, value.command].filter(Boolean)
        for (const endpoint of endpoints) {
          if (
            endpoint?.commandMetadata?.webCommandMetadata?.apiUrl !== '/youtubei/v1/get_transcript'
          ) {
            continue
          }
          const params = endpoint?.getTranscriptEndpoint?.params
          if (typeof params === 'string' && params) return { params }
          const token = endpoint?.continuationCommand?.token
          if (typeof token === 'string' && token && !continuation) continuation = token
        }
        pending.push(...Object.values(value))
      }
    }
    return continuation ? { continuation } : null
  }
  const discoveredEndpoint = readTranscriptEndpoint(globalThis.ytInitialData)
  const requestEndpoint =
    discoveredEndpoint?.params || discoveredEndpoint?.continuation
      ? discoveredEndpoint
      : String(suppliedContinuation || '')
      ? { continuation: String(suppliedContinuation) }
      : null
  const apiKey = String(globalThis.ytcfg?.get?.('INNERTUBE_API_KEY') || '')
  const context = globalThis.ytcfg?.get?.('INNERTUBE_CONTEXT')
  if (!requestEndpoint || !apiKey || !context)
    throw new Error('YOUTUBE_TRANSCRIPT_CONTINUATION_MISSING')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context, ...requestEndpoint }),
      signal: controller.signal,
    })
    if (!response?.ok) throw new Error('YOUTUBE_TRANSCRIPT_HTTP_ERROR')
    const length = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(length) && length > maxResponseBytes) {
      throw new Error('YOUTUBE_TRANSCRIPT_RESPONSE_TOO_LARGE')
    }
    const body = await response.text()
    const size =
      typeof TextEncoder === 'function'
        ? new TextEncoder().encode(body).byteLength
        : body.length * 2
    if (!body.trim()) throw new Error('YOUTUBE_TRANSCRIPT_EMPTY')
    if (size > maxResponseBytes) throw new Error('YOUTUBE_TRANSCRIPT_RESPONSE_TOO_LARGE')
    if (currentVideoId() !== expectedVideoId) throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    const payload = JSON.parse(body)
    const renderers = []
    const collect = (value, seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (value.transcriptSegmentRenderer) renderers.push(value.transcriptSegmentRenderer)
      for (const child of Object.values(value)) collect(child, seen)
    }
    collect(payload)
    const segments = renderers
      .map((renderer) => {
        const startMs = Number(renderer?.startMs)
        const endMs = Number(renderer?.endMs)
        const text = (renderer?.snippet?.runs || [])
          .map((run) => String(run?.text || ''))
          .join('')
          .replace(/\s+/g, ' ')
          .trim()
        return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && text
          ? { startMs, endMs, text }
          : null
      })
      .filter(Boolean)
    if (segments.length === 0) throw new Error('YOUTUBE_TRANSCRIPT_EMPTY')
    return { videoId: expectedVideoId, language: 'und', label: 'Transcript', segments }
  } finally {
    clearTimeout(timer)
  }
}

export async function readYouTubeTranscriptPanel(
  expectedVideoId,
  timeoutMs,
  maxResponseBytes = 5 * 1024 * 1024,
  maxSegmentCount = 10000,
) {
  const currentVideoId = () => new URL(location.href).searchParams.get('v')
  if (currentVideoId() !== expectedVideoId) throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
  const panelSelector = [
    'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
  ].join(', ')
  const segmentSelector = 'ytd-transcript-segment-renderer, transcript-segment-view-model'
  const closeSelector = '#visibility-button button'
  const hasHiddenAncestor = (element) => {
    for (let current = element; current; current = current.parentElement) {
      if (
        current.hidden === true ||
        current.hasAttribute?.('hidden') === true ||
        current.getAttribute?.('aria-hidden') === 'true'
      ) {
        return true
      }
    }
    return false
  }
  const panelIsExpanded = (element) =>
    Boolean(element) &&
    element.getAttribute?.('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' &&
    !hasHiddenAncestor(element)
  const controlIsUsable = (element) =>
    Boolean(element) &&
    element.disabled !== true &&
    element.getAttribute?.('aria-disabled') !== 'true' &&
    !hasHiddenAncestor(element)
  const findUsable = (selectors, preferLast = false) => {
    const usable = []
    const seen = new Set()
    for (const selector of selectors) {
      for (const element of Array.from(document.querySelectorAll?.(selector) || [])) {
        if (!seen.has(element) && controlIsUsable(element)) usable.push(element)
        seen.add(element)
      }
    }
    return preferLast ? usable.at(-1) || null : usable[0] || null
  }
  const transcriptPattern = /show transcript|transcript|显示转录稿|顯示轉錄稿|文字稿|内容转文字/i
  const findOpener = () => {
    const direct = findUsable(
      [
        'ytd-video-description-transcript-section-renderer button',
        'button[aria-label*="transcript" i]',
        'button[title*="transcript" i]',
        'button[aria-label*="显示转录稿"]',
        'button[title*="显示转录稿"]',
        'button[aria-label*="顯示轉錄稿"]',
        'button[title*="顯示轉錄稿"]',
        'button[aria-label*="文字稿"]',
        'button[title*="文字稿"]',
        'button[aria-label*="内容转文字"]',
        'button[title*="内容转文字"]',
      ],
      true,
    )
    if (direct) return direct
    return Array.from(document.querySelectorAll?.('button') || [])
      .filter((button) => {
        const label = `${button.textContent || ''} ${button.getAttribute?.('aria-label') || ''} ${
          button.getAttribute?.('title') || ''
        }`
        return controlIsUsable(button) && transcriptPattern.test(label)
      })
      .at(-1)
  }
  const findExpandedPanel = (requireSegments) => {
    for (const candidate of Array.from(document.querySelectorAll?.(panelSelector) || [])) {
      if (
        panelIsExpanded(candidate) &&
        (!requireSegments || candidate.querySelectorAll(segmentSelector).length > 0)
      ) {
        return candidate
      }
    }
    return null
  }

  let panel = findExpandedPanel(true)
  const openedByExtension = !findExpandedPanel(false)
  const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : 0
  const deadline = Date.now() + normalizedTimeoutMs
  let openerClicked = false
  if (openedByExtension) {
    findUsable([
      'tp-yt-paper-button#expand',
      '#expand-sizer',
      'ytd-text-inline-expander #expand',
    ])?.click()
  }

  let observer
  let pollTimer
  let timeoutTimer
  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        observer?.disconnect()
        clearTimeout(pollTimer)
        clearTimeout(timeoutTimer)
      }
      const finish = (error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const inspect = () => {
        if (currentVideoId() !== expectedVideoId) {
          finish(new Error('VIDEO_SOURCE_IDENTITY_CHANGED'))
          return
        }
        panel = findExpandedPanel(true)
        if (panel) {
          finish()
          return
        }
        if (openedByExtension && !openerClicked) {
          const opener = findOpener()
          if (opener) {
            openerClicked = true
            opener.click()
            panel = findExpandedPanel(true)
            if (panel) finish()
          }
        }
      }
      const poll = () => {
        inspect()
        if (!settled) pollTimer = setTimeout(poll, 50)
      }
      if (typeof MutationObserver === 'function' && document.body) {
        observer = new MutationObserver(inspect)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true })
      }
      timeoutTimer = setTimeout(
        () => finish(new Error('YOUTUBE_TRANSCRIPT_PANEL_TIMEOUT')),
        Math.max(0, deadline - Date.now()),
      )
      poll()
    })

    const elements = Array.from(panel.querySelectorAll(segmentSelector))
    if (elements.length > maxSegmentCount) throw new Error('YOUTUBE_TRANSCRIPT_PANEL_TOO_LARGE')
    const parseTimestamp = (value) => {
      const parts = String(value || '')
        .trim()
        .split(':')
        .map(Number)
      if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null
      return parts.reduce((total, part) => total * 60 + part, 0) * 1000
    }
    const seen = new Set()
    let totalBytes = 0
    const rawSegments = elements
      .map((element) => {
        const timestampElement =
          element.querySelector('.ytwTranscriptSegmentViewModelTimestamp') ||
          element.querySelector('.segment-timestamp, [class*="timestamp"]')
        const startMs = parseTimestamp(timestampElement?.textContent)
        const isInTimestampA11y = (node) => {
          for (
            let current = node;
            current && current !== element;
            current = current.parentElement
          ) {
            const className = String(current.className || '')
            if (className.includes('ytwTranscriptSegmentViewModelTimestampA11yLabel')) return true
          }
          return false
        }
        const modernText = [
          element.querySelector('span.ytAttributedStringHost[role="text"]'),
          ...Array.from(element.querySelectorAll?.('[role="text"]') || []),
        ].find((node) => node && !isInTimestampA11y(node))
        const text = String(
          modernText?.textContent ||
            element.querySelector(
              'yt-formatted-string.segment-text, .segment-text, [class*="segment-text"]',
            )?.textContent ||
            '',
        )
          .replace(/\s+/g, ' ')
          .trim()
        const key = `${startMs}:${text}`
        if (!Number.isFinite(startMs) || !text || seen.has(key)) return null
        seen.add(key)
        totalBytes +=
          typeof TextEncoder === 'function'
            ? new TextEncoder().encode(text).byteLength
            : text.length * 2
        if (totalBytes > maxResponseBytes) throw new Error('YOUTUBE_TRANSCRIPT_PANEL_TOO_LARGE')
        return { startMs, text }
      })
      .filter(Boolean)
    if (rawSegments.length === 0) throw new Error('YOUTUBE_TRANSCRIPT_EMPTY')
    if (currentVideoId() !== expectedVideoId) throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
    const durationSeconds = Number(
      (globalThis.movie_player || document.querySelector?.('#movie_player'))?.getDuration?.(),
    )
    const durationMs =
      Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * 1000 : 0
    const segments = rawSegments.map((segment, index) => {
      const nextStartMs = rawSegments[index + 1]?.startMs
      const terminalEndMs = durationMs > segment.startMs ? durationMs : segment.startMs + 1000
      return {
        ...segment,
        endMs:
          Number.isFinite(nextStartMs) && nextStartMs > segment.startMs
            ? nextStartMs
            : terminalEndMs,
      }
    })
    const languageElement = panel.querySelector(
      '[lang][class*="language"], [lang].language, [class*="language-menu"] [lang]',
    )
    const language = String(languageElement?.getAttribute?.('lang') || 'und')
    const label = String(languageElement?.textContent || '').trim() || 'Transcript'
    return { videoId: expectedVideoId, language, label, segments }
  } finally {
    observer?.disconnect()
    clearTimeout(pollTimer)
    clearTimeout(timeoutTimer)
    if (openedByExtension && panel && currentVideoId() === expectedVideoId) {
      panel.querySelector(closeSelector)?.click()
    }
  }
}

function assertAuthorizedYouTubeSender(sender, expectedVideoId) {
  let senderUrl
  try {
    senderUrl = new URL(String(sender?.url || sender?.documentUrl || ''))
  } catch {
    throw new Error('YOUTUBE_PAGE_DATA_UNAUTHORIZED')
  }

  if (
    sender?.frameId !== 0 ||
    !Number.isInteger(sender?.tab?.id) ||
    senderUrl.origin !== 'https://www.youtube.com' ||
    senderUrl.pathname !== '/watch' ||
    senderUrl.searchParams.get('v') !== expectedVideoId ||
    !/^[A-Za-z0-9_-]{11}$/.test(expectedVideoId)
  ) {
    throw new Error('YOUTUBE_PAGE_DATA_UNAUTHORIZED')
  }
  return sender.tab.id
}

const EXECUTION_ERROR_NAMES = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
])

function executionCauseCode(value) {
  const match = String(value || '').match(/(?:^|\s)([A-Za-z]+Error)(?=:\s|\s|$)/)
  return EXECUTION_ERROR_NAMES.has(match?.[1]) ? match[1] : 'UnknownError'
}

export function unwrapExecutionResult(results, stage) {
  const entry = results?.[0]
  if (entry?.error != null || !Object.prototype.hasOwnProperty.call(entry || {}, 'result')) {
    const error = new Error('YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED')
    error.causeCode = executionCauseCode(entry?.error)
    error.stage = stage
    throw error
  }
  return entry.result
}

export async function createYouTubePageDataResponse(operation, fallbackStage) {
  try {
    return { ok: true, data: await operation() }
  } catch (error) {
    const errorCode = /^[A-Z][A-Z0-9_]+$/.test(error?.message || '')
      ? error.message
      : 'YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED'
    return {
      ok: false,
      errorCode,
      causeCode: EXECUTION_ERROR_NAMES.has(error?.causeCode)
        ? error.causeCode
        : error?.causeCode === 'UnknownError'
        ? 'UnknownError'
        : 'UnknownError',
      stage: /^[a-z-]+$/.test(error?.stage || '') ? error.stage : fallbackStage,
    }
  }
}

export function createYouTubePageDataReader({ executeScript }) {
  if (typeof executeScript !== 'function') throw new Error('YOUTUBE_SCRIPT_EXECUTOR_REQUIRED')
  const captureFlights = new Map()

  const read = async ({ sender, expectedVideoId }) => {
    const tabId = assertAuthorizedYouTubeSender(sender, expectedVideoId)
    const results = await executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: readYouTubeMainWorldPlayerResponse,
      args: [expectedVideoId],
    })
    return unwrapExecutionResult(results, 'player-response')
  }

  read.captureCaption = async ({
    sender,
    expectedVideoId,
    language,
    sourceKind,
    vssId,
    mode = 'nativeOnly',
  }) => {
    const tabId = assertAuthorizedYouTubeSender(sender, expectedVideoId)
    const normalizedLanguage = String(language || '')
    const normalizedVssId = String(vssId || '')
    if (!['panelOnly', 'nativeOnly', 'innertubeOnly'].includes(mode)) {
      throw new Error('YOUTUBE_CAPTURE_MODE_INVALID')
    }
    if (
      mode === 'nativeOnly' &&
      (!/^[A-Za-z0-9._-]{1,64}$/.test(normalizedLanguage) ||
        !/^[A-Za-z0-9._-]{0,256}$/.test(normalizedVssId) ||
        !['author', 'automatic'].includes(sourceKind))
    ) {
      throw new Error('YOUTUBE_CAPTION_DESCRIPTOR_INVALID')
    }
    const key = `${tabId}:${String(sender?.documentId || sender?.url || '')}:${expectedVideoId}`
    const previous = captureFlights.get(key) || Promise.resolve()
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const runMainWorld = async (func, args) => {
          const results = await executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func,
            args,
          })
          const stage =
            mode === 'panelOnly'
              ? 'caption-panel'
              : mode === 'innertubeOnly'
              ? 'caption-innertube'
              : 'caption-native'
          const result = unwrapExecutionResult(results, stage)
          if (result?.videoId && result.videoId !== expectedVideoId) {
            throw new Error('VIDEO_SOURCE_IDENTITY_CHANGED')
          }
          return result
        }

        if (mode === 'panelOnly') {
          return runMainWorld(readYouTubeTranscriptPanel, [
            expectedVideoId,
            15000,
            5 * 1024 * 1024,
            10000,
          ])
        }
        if (mode === 'innertubeOnly') {
          return runMainWorld(readYouTubeInnertubeTranscript, [
            expectedVideoId,
            '',
            5000,
            5 * 1024 * 1024,
          ])
        }
        return runMainWorld(captureYouTubeMainWorldCaption, [
          expectedVideoId,
          {
            language: normalizedLanguage,
            sourceKind,
            vssId: normalizedVssId,
          },
          5000,
          5 * 1024 * 1024,
        ])
      })
    captureFlights.set(key, operation)
    try {
      return await operation
    } finally {
      if (captureFlights.get(key) === operation) captureFlights.delete(key)
    }
  }

  return read
}
