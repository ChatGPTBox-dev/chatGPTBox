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
  let hasStarted = false
  const reader = resp.body.getReader()
  let result
  try {
    while (!(result = await reader.read()).done) {
      const chunk = result.value
      if (!hasStarted) {
        const str = new TextDecoder().decode(chunk)
        hasStarted = true
        await onStart(str)

        let fakeSseData
        try {
          const commonResponse = JSON.parse(str)
          fakeSseData = 'data: ' + JSON.stringify(commonResponse) + '\n\ndata: [DONE]\n\n'
        } catch (error) {
          console.debug('not common response', error)
        }
        if (fakeSseData) {
          parser.feed(new TextEncoder().encode(fakeSseData))
          break
        }
      }
      parser.feed(chunk)
    }
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
  await onEnd()
}
