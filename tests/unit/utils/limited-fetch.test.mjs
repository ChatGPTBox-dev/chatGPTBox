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

const installFakeXMLHttpRequest = ({ openError, sendError } = {}) => {
  const requests = []

  class FakeXMLHttpRequest {
    constructor() {
      this.aborted = false
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
