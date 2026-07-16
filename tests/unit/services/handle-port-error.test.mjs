import assert from 'node:assert/strict'
import { test } from 'node:test'
import { t as translate } from 'i18next'
import {
  claimLatestPortSessionRequest,
  handlePortError,
  invalidateLatestPortSessionRequest,
} from '../../../src/services/wrappers.mjs'
import {
  FETCH_REQUEST_FAILED,
  FETCH_RESPONSE_STREAM_FAILED,
  INVALID_API_ENDPOINT,
} from '../../../src/utils/fetch-sse.mjs'
import { formatErrorMessage, formatErrorText } from '../../../src/utils/error-text.mjs'
import { createFakePort } from '../helpers/port.mjs'

test('claimLatestPortSessionRequest supersedes pending requests on the same port', () => {
  const port = {}
  const isFirstRequestLatest = claimLatestPortSessionRequest(port)
  const isSecondRequestLatest = claimLatestPortSessionRequest(port)

  assert.equal(isFirstRequestLatest(), false)
  assert.equal(isSecondRequestLatest(), true)
  assert.equal(port._sessionRequestGeneration, 2)
})

test('invalidateLatestPortSessionRequest cancels a pending request', () => {
  const port = {}
  const isRequestLatest = claimLatestPortSessionRequest(port)

  invalidateLatestPortSessionRequest(port)

  assert.equal(isRequestLatest(), false)
  assert.equal(port._sessionRequestGeneration, 1)
})

function translateOrFallback(key) {
  return translate(key) ?? key
}

function formatDetail(key, value) {
  return translateOrFallback(key).replace('%s', `\n\n${formatErrorText(value)}`)
}

test('handlePortError adds a neutral summary to Chromium fetch failures', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError('Failed to fetch'), {
      code: FETCH_REQUEST_FAILED,
      requestOrigin: 'https://api.example.com:8443',
    }),
  )

  assert.deepEqual(port.postedMessages, [
    {
      error: [
        translate('The browser could not complete the request to the API endpoint.'),
        translate('Check the API endpoint URL and service availability, then try again.'),
        formatDetail('API endpoint: %s', 'https://api.example.com:8443'),
        formatDetail('Browser message: %s', 'Failed to fetch'),
      ].join('\n\n'),
    },
  ])
})

test('handlePortError uses the same summary for Firefox fetch failures', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'NetworkError when attempting to fetch resource.'

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError(message), {
      code: FETCH_REQUEST_FAILED,
      requestOrigin: 'https://api.example.com',
    }),
  )

  assert.equal(
    port.postedMessages[0].error,
    [
      translate('The browser could not complete the request to the API endpoint.'),
      translate('Check the API endpoint URL and service availability, then try again.'),
      formatDetail('API endpoint: %s', 'https://api.example.com'),
      formatDetail('Browser message: %s', message),
    ].join('\n\n'),
  )
})

test('handlePortError reports an invalid API endpoint without exposing the malformed URL', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError(), {
      code: INVALID_API_ENDPOINT,
    }),
  )

  assert.equal(
    port.postedMessages[0].error,
    [
      translate('The configured API endpoint URL is invalid.'),
      translate('Check the API endpoint URL and service availability, then try again.'),
    ].join('\n\n'),
  )
})

test('handlePortError distinguishes an interrupted API response stream', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'The upstream aborted the response stream.'

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError(message), {
      code: FETCH_RESPONSE_STREAM_FAILED,
      requestOrigin: 'https://api.example.com',
    }),
  )

  assert.equal(
    port.postedMessages[0].error,
    [
      translate('The response stream from the API endpoint was interrupted.'),
      translate('Check the API endpoint URL and service availability, then try again.'),
      formatDetail('API endpoint: %s', 'https://api.example.com'),
      formatDetail('Browser message: %s', message),
    ].join('\n\n'),
  )
})

test('handlePortError formats HTML as fenced code in fetch failure details', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError('Failed <img src=x onerror=alert(1)> & retry'), {
      code: FETCH_REQUEST_FAILED,
      requestOrigin: 'https://api.example.com/<unsafe>',
    }),
  )

  const error = port.postedMessages[0].error
  assert.equal(error.includes(formatErrorText('Failed <img src=x onerror=alert(1)> & retry')), true)
  assert.equal(error.includes(formatErrorText('https://api.example.com/<unsafe>')), true)
})

test('handlePortError preserves replacement tokens in fetch failure details', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError('Failed $& $$ & retry'), {
      code: FETCH_REQUEST_FAILED,
      requestOrigin: 'https://api.example.com',
    }),
  )

  const error = port.postedMessages[0].error
  assert.equal(error.includes(formatErrorText('Failed $& $$ & retry')), true)
  assert.equal(error.includes('Failed %s'), false)
})

test('handlePortError preserves details when a translation omits its placeholder', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'Failed to fetch'
  const translateWithoutPlaceholder = (key) =>
    key === 'Browser message: %s' ? 'Browser message' : translateOrFallback(key)

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new TypeError(message), { code: FETCH_REQUEST_FAILED }),
    translateWithoutPlaceholder,
  )

  assert.equal(
    port.postedMessages[0].error.includes(`Browser message\n\n${formatErrorText(message)}`),
    true,
  )
})

test('handlePortError ignores classified AbortError before reporting fetch failure', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new Error('The operation was canceled.'), {
      name: 'AbortError',
      code: FETCH_REQUEST_FAILED,
    }),
  )

  assert.deepEqual(port.postedMessages, [])
  assert.equal(consoleError.mock.callCount(), 0)
})

test('handlePortError ignores legacy DOMException abort errors', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const abortError = new DOMException('The operation was canceled.', 'AbortError')
  Object.defineProperty(abortError, 'name', { value: 'TypeError' })

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, abortError)

  assert.deepEqual(port.postedMessages, [])
  assert.equal(consoleError.mock.callCount(), 0)
})

test('handlePortError does not treat inherited object keys as transport error codes', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'Provider returned an unexpected error'

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new Error(message), { code: 'constructor' }),
  )

  assert.deepEqual(port.postedMessages, [{ error: formatErrorMessage(message) }])
})

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

test('handlePortError preserves protocol error messages', (t) => {
  t.mock.method(console, 'error', () => {})

  for (const message of ['UNAUTHORIZED', 'CLOUDFLARE']) {
    const port = createFakePort()
    handlePortError({ modelName: 'chatgptApi4oMini' }, port, new Error(message))
    assert.deepEqual(port.postedMessages, [{ error: message }])
  }
})

test('handlePortError reports upstream errors that mention aborted requests', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'request aborted by upstream provider'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message,
  })

  assert.deepEqual(port.postedMessages, [{ error: formatErrorMessage(message) }])
})

test('handlePortError ignores AbortError by name even when message text differs', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError(
    { modelName: 'chatgptApi4oMini' },
    port,
    Object.assign(new Error('The operation was canceled.'), { name: 'AbortError' }),
  )

  assert.deepEqual(port.postedMessages, [])
  assert.equal(consoleError.mock.callCount(), 0)
})

test('handlePortError ignores disconnected port errors', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  const consoleWarn = t.mock.method(console, 'warn', () => {})

  for (const message of [
    'Attempting to use a disconnected port object',
    'Attempt to postMessage on disconnected port',
  ]) {
    const port = createFakePort()

    handlePortError({ modelName: 'chatgptApi4oMini' }, port, { message })

    assert.deepEqual(port.postedMessages, [])
  }
  assert.equal(consoleError.mock.callCount(), 0)
  assert.equal(consoleWarn.mock.callCount(), 2)
})

test('handlePortError reports upstream errors that mention a closed port', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
    message: 'Upstream reset the request because its port closed',
  })

  assert.deepEqual(port.postedMessages, [
    { error: formatErrorMessage('Upstream reset the request because its port closed') },
  ])
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

test('handlePortError preserves plain unknown message errors for display translation', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'unknown upstream error'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, { message })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, formatErrorMessage(message))
})

test('handlePortError formats HTML as fenced code in non-transport error messages', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'Rate limit reached <img src=x onerror=alert(1)> & retry'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, { message })

  const error = port.postedMessages[0].error
  assert.equal(error.includes(formatErrorText(message)), true)
})

test('handlePortError formats Markdown images as fenced code in non-transport errors', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const message = 'Rate limit reached ![track](https://attacker.example/pixel)'

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, { message })

  const error = port.postedMessages[0].error
  assert.equal(error.includes(formatErrorText(message)), true)
})

test('handlePortError stringifies non-message errors for non-Bing models', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const err = { code: 'E_UNKNOWN', detail: 'network disconnected' }

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, err)

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, formatErrorMessage(JSON.stringify(err)))
})

test('handlePortError formats HTML as fenced code in stringified errors', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()
  const err = { detail: '<img src=x onerror=alert(1)>' }

  handlePortError({ modelName: 'chatgptApi4oMini' }, port, err)

  assert.deepEqual(port.postedMessages, [{ error: formatErrorMessage(JSON.stringify(err)) }])
})

test('handlePortError handles null thrown values without throwing again', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  assert.doesNotThrow(() => {
    handlePortError({ modelName: 'chatgptApi4oMini' }, port, null)
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, formatErrorMessage('null'))
})

test('handlePortError handles undefined thrown values without throwing again', (t) => {
  t.mock.method(console, 'error', () => {})
  const port = createFakePort()

  assert.doesNotThrow(() => {
    handlePortError({ modelName: 'chatgptApi4oMini' }, port, undefined)
  })

  assert.equal(port.postedMessages.length, 1)
  assert.equal(port.postedMessages[0].error, formatErrorMessage('unknown error'))
})

test('handlePortError does not throw when the error port is closed', (t) => {
  t.mock.method(console, 'error', () => {})
  const consoleWarn = t.mock.method(console, 'warn', () => {})
  const port = {
    postMessage() {
      throw new Error('Port closed')
    },
  }

  assert.doesNotThrow(() => {
    handlePortError({ modelName: 'chatgptApi4oMini' }, port, {
      message: 'done failed',
    })
  })
  assert.equal(consoleWarn.mock.callCount(), 1)
})
