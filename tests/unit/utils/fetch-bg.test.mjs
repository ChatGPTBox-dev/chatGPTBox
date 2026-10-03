import assert from 'node:assert/strict'
import { test } from 'node:test'
import Browser from 'webextension-polyfill'
import { fetchBg } from '../../../src/utils/fetch-bg.mjs'

function mockSendMessage(t, implementation) {
  const originalSendMessage = Browser.runtime.sendMessage
  Object.defineProperty(Browser.runtime, 'sendMessage', {
    configurable: true,
    value: implementation,
  })
  t.after(() => {
    Object.defineProperty(Browser.runtime, 'sendMessage', {
      configurable: true,
      value: originalSendMessage,
    })
  })
}

test('fetchBg returns the response received from the background script', async (t) => {
  const calls = []
  mockSendMessage(t, async (message) => {
    calls.push(message)
    return [
      {
        body: 'response body',
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'text/plain' },
      },
      null,
    ]
  })

  const response = await fetchBg('https://example.com/resource', { method: 'POST' })

  assert.deepEqual(calls, [
    {
      type: 'FETCH',
      data: {
        input: 'https://example.com/resource',
        init: { method: 'POST' },
      },
    },
  ])
  assert.equal(response.status, 201)
  assert.equal(response.statusText, 'Created')
  assert.equal(response.headers.get('content-type'), 'text/plain')
  assert.equal(await response.text(), 'response body')
})

test('fetchBg rejects with the error received from the background script', async (t) => {
  const backgroundError = { message: 'background fetch failed' }
  mockSendMessage(t, async () => [null, backgroundError])

  await assert.rejects(fetchBg('https://example.com'), (error) => {
    assert.deepEqual(error, backgroundError)
    return true
  })
})

test('fetchBg forwards sendMessage rejections', async (t) => {
  const messageError = new Error('message channel closed')
  mockSendMessage(t, async () => {
    throw messageError
  })

  await assert.rejects(fetchBg('https://example.com'), (error) => {
    assert.equal(error, messageError)
    return true
  })
})

test('fetchBg forwards errors thrown while processing the response', async (t) => {
  const processingError = new Error('invalid message response')
  const messageResponse = {
    [Symbol.iterator]() {
      throw processingError
    },
  }
  mockSendMessage(t, async () => messageResponse)

  await assert.rejects(fetchBg('https://example.com'), (error) => {
    assert.equal(error, processingError)
    return true
  })
})
