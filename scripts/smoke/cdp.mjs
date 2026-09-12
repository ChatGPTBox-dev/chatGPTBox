import { bounded } from './lifecycle.mjs'

// Register the transport before awaiting the handshake or issuing any RPCs.
export async function connectCDP(
  url,
  { lifecycle, signal, timeoutMs = 10000, WebSocketImpl = globalThis.WebSocket },
) {
  signal?.throwIfAborted()
  let socket
  let nextId = 0
  let failure
  let closed = false
  let closing
  const pending = new Map()
  let resolveOpen, rejectOpen, resolveClosed
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const finished = new Promise((resolve) => {
    resolveClosed = resolve
  })
  const fail = (error) => {
    failure ??= error
    rejectOpen(failure)
    for (const request of pending.values()) request.reject(failure)
    pending.clear()
  }
  const onAbort = () => {
    const error = signal.reason ?? new Error('CDP connection aborted')
    rejectOpen(error)
    for (const [id, request] of pending) {
      if (request.signal !== signal) continue
      request.reject(error)
      pending.delete(id)
    }
  }
  const close = () => {
    if (closing) return closing
    if (!socket) return Promise.resolve()
    signal?.removeEventListener('abort', onAbort)
    fail(new Error('CDP connection closed'))
    closing = (async () => {
      if (closed) return
      socket.close()
      await bounded(finished, 2000, 'Close CDP connection')
    })()
    return closing
  }
  lifecycle.defer('Close Chromium CDP connection', close)
  socket = new WebSocketImpl(url)
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', () => fail(new Error('CDP WebSocket transport error')))
  socket.addEventListener('close', () => {
    closed = true
    signal?.removeEventListener('abort', onAbort)
    fail(new Error('CDP WebSocket disconnected'))
    resolveClosed()
  })
  socket.addEventListener('message', ({ data }) => {
    let message
    try {
      message = JSON.parse(data)
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('Expected a CDP message object')
      }
    } catch (error) {
      fail(new Error('Invalid CDP WebSocket message', { cause: error }))
      return
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) {
      const error = new Error(`${request.method}: ${message.error.message}`)
      error.code = message.error.code
      request.reject(error)
    } else if (!Object.hasOwn(message, 'result')) {
      request.reject(new Error(`${request.method}: missing CDP result`))
    } else {
      request.resolve(message.result)
    }
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  await bounded(opened, timeoutMs, 'Connect Chromium CDP', signal)

  return {
    close,
    async request(method, params = {}, sessionId, options = {}) {
      const requestSignal = Object.hasOwn(options, 'signal') ? options.signal : signal
      requestSignal?.throwIfAborted()
      if (failure) throw failure
      const id = ++nextId
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method, signal: requestSignal })
      })
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        return await bounded(response, options.timeoutMs ?? timeoutMs, method, requestSignal)
      } finally {
        pending.delete(id)
      }
    },
  }
}
