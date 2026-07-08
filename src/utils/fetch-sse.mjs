import { createParser } from './eventsource-parser.mjs'

function isAbortError(err) {
  if (!err || typeof err !== 'object') return false
  const name = typeof err.name === 'string' ? err.name : ''
  return name === 'AbortError'
}

export async function fetchSSE(resource, options) {
  const { onMessage, onStart, onEnd, onError, ...fetchOptions } = options
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
    await onError(err)
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
  let hasStarted = false
  const reader = resp.body.getReader()
  let result
  let done = false
  while (!done) {
    try {
      result = await reader.read()
    } catch (err) {
      if (isAbortError(err)) {
        try {
          await onEnd(true)
        } catch (e) {
          console.warn('[fetch-sse] onEnd threw during abort:', e)
        }
        return
      }
      await onError(err)
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
