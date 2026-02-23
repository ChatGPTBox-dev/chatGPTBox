import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t as translate } from 'i18next'
import { handlePortError } from '../../../src/services/wrappers.mjs'
import { createFakePort } from '../helpers/port.mjs'

test('handlePortError reports exceeded maximum context length', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'maximum context length is 4096 tokens'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message,
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error.includes(message), true)
  assert.notEqual(port.postedMessages[0].error, message)
})

test('handlePortError treats "message you submitted was too long" as context-length error', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'message you submitted was too long for this model'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message,
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error.includes(message), true)
  assert.notEqual(port.postedMessages[0].error, message)
})

test('handlePortError reports exceeded quota messages', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const quotaMessage = 'You exceeded your current quota.'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message: quotaMessage,
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error.includes(quotaMessage), true)
  assert.notEqual(port.postedMessages[0].error, quotaMessage)
})

test('handlePortError reports rate-limit messages', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const rateMessage = 'Rate limit reached for requests'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message: rateMessage,
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error.includes(rateMessage), true)
  assert.notEqual(port.postedMessages[0].error, rateMessage)
})

test('handlePortError reports Bing captcha challenge message', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'CAPTCHA challenge required'

  handlePortError({ modelName: 'bingFree4' }, port, {
    message,
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error.includes(message), true)
  assert.notEqual(port.postedMessages[0].error, message)
})

test('handlePortError maps expired authentication token to UNAUTHORIZED', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message: 'authentication token has expired',
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, 'UNAUTHORIZED')
})

test('handlePortError ignores aborted errors', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message: 'request aborted by user',
  })

  assert.deepEqual(port.postedMessages, [])
})

test('handlePortError reports Claude web authorization hint', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError({ modelName: 'claude2WebFree' }, port, {
    message: 'Invalid authorization',
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(
    port.postedMessages[0].error,
    translate('Please login at https://claude.ai first, and then click the retry button'),
  )
  assert.notEqual(port.postedMessages[0].error, 'Invalid authorization')
})

test('handlePortError reports Bing login hint for turing parse-response failures', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = '/turing/conversation/create: failed to parse response body.'

  handlePortError({ modelName: 'bingFree4' }, port, { message })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, translate('Please login at https://bing.com first'))
  assert.notEqual(port.postedMessages[0].error, message)
})

test('handlePortError reports Bing login hint when trusted error has no message', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const err = { isTrusted: true }

  handlePortError({ modelName: 'bingFree4' }, port, err)

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, translate('Please login at https://bing.com first'))
  assert.notEqual(port.postedMessages[0].error, JSON.stringify(err))
})

test('handlePortError forwards unknown message errors as-is', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'unknown upstream error'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, { message })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, message)
})

test('handlePortError stringifies non-message errors for non-Bing models', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const err = { code: 'E_UNKNOWN', detail: 'network disconnected' }

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, err)

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, JSON.stringify(err))
})
