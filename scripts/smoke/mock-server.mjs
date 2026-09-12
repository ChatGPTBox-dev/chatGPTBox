import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { bounded } from './lifecycle.mjs'

export async function startMockServer({ lifecycle, signal }) {
  signal?.throwIfAborted()
  const requests = []
  const sockets = new Set()
  const pending = new Set()
  let released = false
  let closing
  const event = (content, finishReason = null) =>
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: finishReason }],
    })}\r\n\r\n`
  const finish = (response) => {
    pending.delete(response)
    if (response.destroyed) return
    const bytes = Buffer.from(event('世界🙂', 'stop') + 'data: [DONE]\r\n\r\n')
    // Exercise split UTF-8 and CRLF writes without assuming network read boundaries.
    for (const byte of bytes) response.write(Buffer.from([byte]))
    response.end()
  }
  const server = createServer((request, response) => {
    response.on('error', () => response.destroy())
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }
    const entry = { method: request.method, path: request.url, body: null, status: null }
    requests.push(entry)
    let body = ''
    request.setEncoding('utf8')
    request.on('error', () => response.destroy())
    request.on('data', (chunk) => {
      body += chunk
      if (Buffer.byteLength(body) > 65536) request.destroy()
    })
    request.on('end', () => {
      const json = (status, value) => {
        entry.status = status
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (
        request.method !== 'POST' ||
        !['/success/v1/chat/completions', '/error/v1/chat/completions'].includes(request.url)
      ) {
        json(404, { error: { message: 'Unknown smoke endpoint' } })
        return
      }
      try {
        entry.body = JSON.parse(body)
      } catch {
        json(400, { error: { message: 'Invalid JSON' } })
        return
      }
      if (
        request.headers.authorization !== 'Bearer smoke-local-only' ||
        entry.body?.model !== 'smoke-model' ||
        entry.body?.stream !== true ||
        !Array.isArray(entry.body?.messages)
      ) {
        json(400, { error: { message: 'Invalid Chat Completions request' } })
        return
      }
      if (request.url === '/error/v1/chat/completions') {
        json(503, { error: { message: 'Smoke upstream unavailable', code: 'smoke_503' } })
        return
      }
      entry.status = 200
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      pending.add(response)
      response.once('close', () => pending.delete(response))
      response.write(event('Hello '))
      if (released) finish(response)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  let listening
  const close = () => {
    closing ??= (async () => {
      // A cancelled startup may still finish listening; close it before returning.
      await listening?.catch(() => {})
      const closed = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
      })
      for (const socket of sockets) socket.destroy()
      await closed
    })()
    return closing
  }
  lifecycle.defer('mock HTTP server', close)
  listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  await bounded(listening, 10000, 'mock HTTP listen', signal)
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    release() {
      released = true
      for (const response of pending) finish(response)
    },
    close,
  }
}
