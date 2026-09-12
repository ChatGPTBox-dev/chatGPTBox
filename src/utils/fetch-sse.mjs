import { createParser } from './eventsource-parser.mjs'
import { isAbortError } from './abort-error.mjs'

export const FETCH_REQUEST_FAILED = 'FETCH_REQUEST_FAILED'
export const FETCH_RESPONSE_STREAM_FAILED = 'FETCH_RESPONSE_STREAM_FAILED'
export const FETCH_JSON_RESPONSE_TOO_LARGE = 'FETCH_JSON_RESPONSE_TOO_LARGE'
export const INVALID_API_ENDPOINT = 'INVALID_API_ENDPOINT'

// Decoded UTF-16 code units; this is not a byte-accurate heap limit.
const MAX_SSE_BUFFER_SIZE = 8 * 1024 * 1024
// Byte budget for the plain-JSON fallback; format probes are capped separately below.
const MAX_SSE_START_JSON_SIZE = 8 * 1024 * 1024
const MAX_SSE_START_PREVIEW_SIZE = 64 * 1024
const UTF8_BOM = [0xef, 0xbb, 0xbf]

function setErrorProperty(err, key, value) {
  try {
    err[key] = value
    return err[key] === value
  } catch {
    return false
  }
}

function getHttpRequestUrl(resource) {
  let url
  try {
    url = new URL(resource?.url ?? resource)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  return url
}

function createInvalidApiEndpointError() {
  const err = new TypeError()
  setErrorProperty(err, 'code', INVALID_API_ENDPOINT)
  return err
}

function createJsonResponseTooLargeError() {
  const err = new RangeError(
    `JSON response exceeded the ${MAX_SSE_START_JSON_SIZE}-byte fallback inspection limit`,
  )
  setErrorProperty(err, 'code', FETCH_JSON_RESPONSE_TOO_LARGE)
  return err
}

function classifyTransportError(err, code, requestOrigin) {
  const hasCode = setErrorProperty(err, 'code', code)
  const hasRequestOrigin =
    !requestOrigin || (hasCode && setErrorProperty(err, 'requestOrigin', requestOrigin))
  if (hasCode && hasRequestOrigin) return err

  const classifiedError = new Error(typeof err.message === 'string' ? err.message : '')
  if (typeof err.name === 'string') classifiedError.name = err.name
  if (typeof err.stack === 'string') classifiedError.stack = err.stack
  classifiedError.code = code
  if (requestOrigin) classifiedError.requestOrigin = requestOrigin
  classifiedError.cause = err
  return classifiedError
}

function annotateRequestError(resource, err) {
  if (!err || typeof err !== 'object' || isAbortError(err)) return err

  const url = getHttpRequestUrl(resource)
  return classifyTransportError(err, url ? FETCH_REQUEST_FAILED : INVALID_API_ENDPOINT, url?.origin)
}

function annotateResponseStreamError(resource, err) {
  if (!err || typeof err !== 'object' || isAbortError(err)) return err

  const url = getHttpRequestUrl(resource)
  return classifyTransportError(err, FETCH_RESPONSE_STREAM_FAILED, url?.origin)
}

function hasJsonContentType(resp) {
  const contentType = resp.headers?.get?.('content-type')
  if (typeof contentType !== 'string') return false

  const mimeType = contentType.split(';', 1)[0].trim().toLowerCase()
  return mimeType === 'application/json' || mimeType === 'text/json' || mimeType.endsWith('+json')
}

function getJsonContainerProbeKind(chunk) {
  let index = 0
  if (chunk.byteLength < UTF8_BOM.length && chunk.byteLength > 0) {
    const isPartialBom = UTF8_BOM.slice(0, chunk.byteLength).every(
      (byte, i) => chunk[i] === byte,
    )
    if (isPartialBom) return 'partial-bom'
  }
  if (UTF8_BOM.every((byte, i) => chunk[i] === byte)) index = UTF8_BOM.length

  while (
    index < chunk.byteLength &&
    (chunk[index] === 0x20 ||
      chunk[index] === 0x09 ||
      chunk[index] === 0x0a ||
      chunk[index] === 0x0d)
  ) {
    ++index
  }
  if (index === chunk.byteLength) return 'blank'
  return chunk[index] === 0x7b || chunk[index] === 0x5b ? 'container' : 'other'
}

export async function fetchSSE(resource, options) {
  const { onMessage, onStart, onEnd, onError, ...fetchOptions } = options
  if (!getHttpRequestUrl(resource)) {
    await onError(createInvalidApiEndpointError())
    return
  }
  let resp
  try {
    resp = await fetch(resource, fetchOptions)
  } catch (err) {
    if (isAbortError(err)) {
      try {
        await onEnd(true)
      } catch (e) {
        console.warn('[fetch-sse] onEnd threw during abort:', e)
      }
      return
    }
    await onError(annotateRequestError(resource, err))
    return
  }
  if (!resp.ok) {
    await onError(resp)
    return
  }
  let hasSseEvent = false
  const parser = createParser(
    (event) => {
      if (event.type === 'event') {
        hasSseEvent = true
        onMessage(event.data)
      }
    },
    { maxBufferSize: MAX_SSE_BUFFER_SIZE },
  )
  const handleCallbackError = async (err) => {
    try {
      await onError(err)
    } catch (onErrorError) {
      console.warn('[fetch-sse] onError threw while handling processing failure:', onErrorError)
    }
    throw err
  }
  const handleResponseStreamError = async (err) => {
    if (isAbortError(err)) {
      try {
        await onEnd(true)
      } catch (e) {
        console.warn('[fetch-sse] onEnd threw during abort:', e)
      }
      return
    }
    await onError(annotateResponseStreamError(resource, err))
  }
  let hasStarted = false
  let oversizedJsonCandidate = hasJsonContentType(resp)
  let jsonShapeDetectionPending = !oversizedJsonCandidate
  let jsonShapeProbePrefix = new Uint8Array()
  let responseBytes = 0
  let reader
  try {
    reader = resp.body.getReader()
  } catch (err) {
    await handleResponseStreamError(err)
    return
  }
  let readerReleased = false
  const cleanupReader = async (cancel, waitForCancel = true) => {
    if (readerReleased) return
    readerReleased = true

    let cancellation
    if (cancel) {
      try {
        cancellation = Promise.resolve(reader.cancel?.())
      } catch (err) {
        console.warn('[fetch-sse] reader cancellation failed:', err)
      }
    }
    try {
      reader.releaseLock?.()
    } catch (err) {
      console.warn('[fetch-sse] reader lock release failed:', err)
    }
    if (!cancellation) return
    if (!waitForCancel) {
      cancellation.catch((err) => {
        console.warn('[fetch-sse] reader cancellation failed:', err)
      })
      return
    }
    try {
      await cancellation
    } catch (err) {
      console.warn('[fetch-sse] reader cancellation failed:', err)
    }
  }
  let result
  let done = false
  while (!done) {
    try {
      result = await reader.read()
    } catch (err) {
      await cleanupReader(false)
      await handleResponseStreamError(err)
      return
    }

    done = result.done
    if (done) break

    const chunk = result.value
    if (!hasStarted && chunk.byteLength === 0) continue

    responseBytes = Math.min(
      MAX_SSE_START_JSON_SIZE + 1,
      responseBytes + chunk.byteLength,
    )

    if (jsonShapeDetectionPending && chunk.byteLength > 0) {
      const rawProbeChunk =
        chunk.byteLength > MAX_SSE_START_PREVIEW_SIZE
          ? chunk.subarray(0, MAX_SSE_START_PREVIEW_SIZE)
          : chunk
      let probeChunk = rawProbeChunk
      if (jsonShapeProbePrefix.byteLength > 0) {
        probeChunk = new Uint8Array(
          jsonShapeProbePrefix.byteLength + rawProbeChunk.byteLength,
        )
        probeChunk.set(jsonShapeProbePrefix)
        probeChunk.set(rawProbeChunk, jsonShapeProbePrefix.byteLength)
      }

      const probeKind = getJsonContainerProbeKind(probeChunk)
      if (probeKind === 'partial-bom') {
        jsonShapeProbePrefix = probeChunk
      } else {
        jsonShapeProbePrefix = new Uint8Array()
        if (probeKind === 'container') {
          oversizedJsonCandidate = true
          jsonShapeDetectionPending = false
        } else if (probeKind === 'other') {
          jsonShapeDetectionPending = false
        } else if (chunk.byteLength > rawProbeChunk.byteLength) {
          // The bounded probe is entirely framing but the chunk continues. Treat the
          // unseen remainder as ambiguous instead of scanning attacker-sized input.
          // A later parsed SSE event still wins at EOF via hasSseEvent.
          oversizedJsonCandidate = true
          jsonShapeDetectionPending = false
        }
      }
    }

    if (!hasStarted) {
      const startChunk =
        chunk.byteLength > MAX_SSE_START_JSON_SIZE
          ? chunk.subarray(0, MAX_SSE_START_PREVIEW_SIZE)
          : chunk
      const str = new TextDecoder().decode(startChunk)
      hasStarted = true
      try {
        await onStart(str)
      } catch (err) {
        await cleanupReader(true, false)
        await handleCallbackError(err)
      }

      let commonResponse
      let isCommonResponse = false
      if (chunk.byteLength <= MAX_SSE_START_JSON_SIZE) {
        try {
          commonResponse = JSON.parse(str)
          isCommonResponse = true
        } catch (error) {
          console.debug('not common response', error)
        }
      }
      if (isCommonResponse) {
        try {
          onMessage(JSON.stringify(commonResponse))
          onMessage('[DONE]')
        } catch (err) {
          await cleanupReader(true, false)
          await handleCallbackError(err)
        }
        await cleanupReader(true, false)
        await onEnd()
        return
      }
    }
    try {
      parser.feed(chunk)
    } catch (err) {
      await cleanupReader(true, false)
      await handleCallbackError(err)
    }
  }
  await cleanupReader(false)
  if (
    oversizedJsonCandidate &&
    responseBytes > MAX_SSE_START_JSON_SIZE &&
    !hasSseEvent
  ) {
    await handleCallbackError(createJsonResponseTooLargeError())
  }
  await onEnd()
}
