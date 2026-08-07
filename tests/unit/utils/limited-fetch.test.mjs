import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { limitedFetch } from '../../../src/utils/limited-fetch.mjs'

const originalXMLHttpRequestDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'XMLHttpRequest',
)

const restoreXMLHttpRequest = () => {
  if (originalXMLHttpRequestDescriptor) {
    Object.defineProperty(globalThis, 'XMLHttpRequest', originalXMLHttpRequestDescriptor)
  } else {
    delete globalThis.XMLHttpRequest
  }
}

const installFakeXMLHttpRequest = ({ openError, sendError, status = 200 } = {}) => {
  const requests = []

  class FakeXMLHttpRequest {
    constructor() {
      this.aborted = false
      this.status = status
      requests.push(this)
    }

    open(method, url) {
      if (openError) throw openError
      this.method = method
      this.url = url
    }

    send() {
      if (sendError) throw sendError
      this.sent = true
    }

    abort() {
      this.aborted = true
    }
  }

  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    value: FakeXMLHttpRequest,
    configurable: true,
  })

  return requests
}

afterEach(() => {
  restoreXMLHttpRequest()
})

test('limitedFetch keeps downloading while progress remains below the byte limit', async () => {
  const requests = installFakeXMLHttpRequest()
  const responsePromise = limitedFetch('https://example.com/data', 5)
  let settled = false
  const settlementPromise = responsePromise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const [request] = requests

  request.onprogress({
    loaded: 4,
    target: { responseText: 'data' },
  })
  await Promise.resolve()

  assert.equal(request.aborted, false)
  assert.equal(settled, false)

  request.onload({
    target: { responseText: 'data' },
  })

  assert.equal(await responsePromise, 'data')
  await settlementPromise
  assert.equal(request.method, 'GET')
  assert.equal(request.url, 'https://example.com/data')
  assert.equal(request.sent, true)
})

test('limitedFetch truncates and aborts when progress reaches the byte limit', async () => {
  const requests = installFakeXMLHttpRequest()
  const responsePromise = limitedFetch('https://example.com/data', 5)
  const [request] = requests

  request.onprogress({
    loaded: 5,
    target: { responseText: '123456789' },
  })

  assert.equal(await responsePromise, '12345')
  assert.equal(request.aborted, true)
})

test('limitedFetch truncates a completed response without aborting it', async () => {
  const requests = installFakeXMLHttpRequest()
  const responsePromise = limitedFetch('https://example.com/data', 4)
  const [request] = requests

  request.onload({
    target: { responseText: 'abcdefgh' },
  })

  assert.equal(await responsePromise, 'abcd')
  assert.equal(request.aborted, false)
})

test('limitedFetch rejects HTTP errors that complete with response data', async () => {
  const requests = installFakeXMLHttpRequest({ status: 503 })
  const responsePromise = limitedFetch('https://example.com/data', 20)
  const [request] = requests

  request.onload({
    target: { responseText: 'service unavailable' },
  })

  await assert.rejects(responsePromise, {
    name: 'Error',
    message: '503',
  })
  assert.equal(request.aborted, false)
})

test('limitedFetch rejects and aborts an oversized HTTP error response', async () => {
  const requests = installFakeXMLHttpRequest({ status: 429 })
  const responsePromise = limitedFetch('https://example.com/data', 5)
  const [request] = requests

  request.onprogress({
    loaded: 5,
    target: { responseText: 'rate limited' },
  })

  await assert.rejects(responsePromise, {
    name: 'Error',
    message: '429',
  })
  assert.equal(request.aborted, true)
})

test('limitedFetch accepts successful partial-content responses', async () => {
  const requests = installFakeXMLHttpRequest({ status: 206 })
  const responsePromise = limitedFetch('https://example.com/data', 4)
  const [request] = requests

  request.onload({
    target: { responseText: 'partial content' },
  })

  assert.equal(await responsePromise, 'part')
})

test('limitedFetch truncates and aborts partial content at the byte limit', async () => {
  const requests = installFakeXMLHttpRequest({ status: 206 })
  const responsePromise = limitedFetch('https://example.com/data', 4)
  const [request] = requests

  request.onprogress({
    loaded: 4,
    target: { responseText: 'partial content' },
  })

  assert.equal(await responsePromise, 'part')
  assert.equal(request.aborted, true)
})

test('limitedFetch rejects with the XHR status when the request fails', async () => {
  const requests = installFakeXMLHttpRequest()
  const responsePromise = limitedFetch('https://example.com/data', 10)
  const [request] = requests

  request.onerror({
    target: { status: 503 },
  })

  await assert.rejects(responsePromise, {
    name: 'Error',
    message: '503',
  })
})

test('limitedFetch rejects when constructing XMLHttpRequest throws', async () => {
  const constructorError = new Error('XMLHttpRequest unavailable')
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    value: class {
      constructor() {
        throw constructorError
      }
    },
    configurable: true,
  })

  await assert.rejects(limitedFetch('https://example.com/data', 10), (error) => {
    assert.equal(error, constructorError)
    return true
  })
})

test('limitedFetch rejects when opening the request throws', async () => {
  const openError = new Error('Invalid URL')
  installFakeXMLHttpRequest({ openError })

  await assert.rejects(limitedFetch('not a url', 10), (error) => {
    assert.equal(error, openError)
    return true
  })
})

test('limitedFetch rejects when sending the request throws', async () => {
  const sendError = new Error('Request blocked')
  installFakeXMLHttpRequest({ sendError })

  await assert.rejects(limitedFetch('https://example.com/data', 10), (error) => {
    assert.equal(error, sendError)
    return true
  })
})
