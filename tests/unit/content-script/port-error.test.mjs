import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getPortErrorMessage,
  shouldDelegatePortError,
} from '../../../src/content-script/port-error.mjs'
import {
  FETCH_REQUEST_FAILED,
  FETCH_RESPONSE_STREAM_FAILED,
  INVALID_API_ENDPOINT,
} from '../../../src/utils/fetch-sse.mjs'

test('delegates classified fetch transport failures', () => {
  for (const code of [FETCH_REQUEST_FAILED, FETCH_RESPONSE_STREAM_FAILED, INVALID_API_ENDPOINT]) {
    assert.equal(shouldDelegatePortError({ code }), true)
  }
})

test('delegates AbortError by name', () => {
  assert.equal(shouldDelegatePortError({ name: 'AbortError' }), true)
})

test('delegates legacy DOMException abort errors', () => {
  const abortError = new DOMException('The operation was canceled.', 'AbortError')
  Object.defineProperty(abortError, 'name', { value: 'TypeError' })

  assert.equal(shouldDelegatePortError(abortError), true)
})

test('keeps ordinary provider errors in the content script', () => {
  assert.equal(shouldDelegatePortError(new Error('Provider failed')), false)
  assert.equal(shouldDelegatePortError(new Error('Upstream request aborted')), false)
})

test('keeps missing errors in the content script', () => {
  assert.equal(shouldDelegatePortError(null), false)
  assert.equal(shouldDelegatePortError(undefined), false)
})

test('formats content script errors with a fallback', () => {
  assert.equal(getPortErrorMessage(new Error('Provider failed')), 'Provider failed')
  assert.equal(
    getPortErrorMessage(null),
    'An unexpected error occurred in content script port listener.',
  )
  assert.equal(
    getPortErrorMessage(undefined),
    'An unexpected error occurred in content script port listener.',
  )
})

test('formats rich markup as a fenced code block in content script errors', () => {
  assert.equal(
    getPortErrorMessage(
      new Error('<img src=x onerror=alert(1)> ![track](https://attacker.example/pixel)'),
    ),
    '```diagnostic\n<img src=x onerror=alert(1)> ![track](https://attacker.example/pixel)\n```',
  )
})

test('preserves protocol error messages for ConversationCard handling', () => {
  assert.equal(getPortErrorMessage(new Error('UNAUTHORIZED')), 'UNAUTHORIZED')
  assert.equal(getPortErrorMessage(new Error('CLOUDFLARE')), 'CLOUDFLARE')
})

test('preserves plain i18n error keys for ConversationCard translation', () => {
  const message =
    'moonshot token required, please login at https://kimi.com first, and then click the retry button'

  assert.equal(getPortErrorMessage(new Error(message)), message)
})
