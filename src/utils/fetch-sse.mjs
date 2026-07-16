import { createParser } from './eventsource-parser.mjs'
import { isAbortError } from './abort-error.mjs'

export const FETCH_REQUEST_FAILED = 'FETCH_REQUEST_FAILED'
export const FETCH_RESPONSE_STREAM_FAILED = 'FETCH_RESPONSE_STREAM_FAILED'
export const INVALID_API_ENDPOINT = 'INVALID_API_ENDPOINT'

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
  const parser = createParser((event) => {
    if (event.type === 'event') {
      onMessage(event.data)
    }
  })
  const handleCallbackError = async (err) => {
    await onError(err)
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
  let reader
  try {
    reader = resp.body.getReader()
  } catch (err) {
    await handleResponseStreamError(err)
    return
  }
  let result
  let done = false
  while (!done) {
    try {
      result = await reader.read()
    } catch (err) {
      await handleResponseStreamError(err)
      return
    }

    done = result.done
    if (done) break

    const chunk = result.value
    if (!hasStarted) {
      const str = new TextDecoder().decode(chunk)
      hasStarted = true
      try {
        await onStart(str)
      } catch (err) {
        await handleCallbackError(err)
      }

      let fakeSseData
      try {
        const commonResponse = JSON.parse(str)
        fakeSseData = 'data: ' + JSON.stringify(commonResponse) + '\n\ndata: [DONE]\n\n'
      } catch (error) {
        console.debug('not common response', error)
      }
      if (fakeSseData) {
        try {
          parser.feed(new TextEncoder().encode(fakeSseData))
        } catch (err) {
          await handleCallbackError(err)
        }
        break
      }
    }
    try {
      parser.feed(chunk)
    } catch (err) {
      await handleCallbackError(err)
    }
  }
  await onEnd()
}
