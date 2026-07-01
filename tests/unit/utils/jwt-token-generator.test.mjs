import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

// Module caches a single token globally; tests must use monotonically
// increasing times so each test can force regeneration when needed.
import { getToken } from '../../../src/utils/jwt-token-generator.mjs'

function decodeTokenPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

function splitToken(token) {
  const parts = token.split('.')
  assert.equal(parts.length, 3)
  return parts
}

function decodeToken(token) {
  const [header, payload] = splitToken(token)
  return {
    header: decodeTokenPart(header),
    payload: decodeTokenPart(payload),
  }
}

function verifyHs256Token(token, secret) {
  const [header, payload, signature] = splitToken(token)
  const expectedSignature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')

  assert.equal(signature, expectedSignature)
  return decodeTokenPart(payload)
}

test('getToken generates a valid JWT with correct header and payload structure', (t) => {
  const now = 1_000_000_000_000
  t.mock.method(Date, 'now', () => now)

  const apiKey = 'my-kid.my-secret'
  const token = getToken(apiKey)

  const decoded = decodeToken(token)
  assert.equal(decoded.header.alg, 'HS256')
  assert.equal(decoded.header.typ, 'JWT')
  assert.equal(decoded.header.sign_type, 'SIGN')
  assert.equal(decoded.payload.api_key, 'my-kid')
  assert.equal(decoded.payload.iat, Math.floor(now / 1000))
  assert.equal(decoded.payload.timestamp, Math.floor(now / 1000))
  assert.equal(decoded.payload.exp, Math.floor(now / 1000) + 86400)
})

test('getToken verifies with the secret from the API key', (t) => {
  const now = 2_000_000_000_000
  t.mock.method(Date, 'now', () => now)

  const apiKey = 'kid123.supersecret'
  const token = getToken(apiKey)

  const verified = verifyHs256Token(token, 'supersecret')
  assert.equal(verified.api_key, 'kid123')
})

test('getToken returns cached token when not expired', (t) => {
  const now = 3_000_000_000_000
  let currentTime = now
  t.mock.method(Date, 'now', () => currentTime)

  const apiKey = 'cache-kid.cache-secret'
  const token1 = getToken(apiKey)

  // Advance time by 1 hour (well within 24h expiry)
  currentTime = now + 3600 * 1000
  const token2 = getToken(apiKey)

  assert.equal(token1, token2)
})

test('getToken regenerates token when API key changes within cache window', (t) => {
  const now = 3_100_000_000_000
  let currentTime = now
  t.mock.method(Date, 'now', () => currentTime)

  const token1 = getToken('first-kid.first-secret')
  currentTime = now + 3600 * 1000
  assert.equal(getToken('first-kid.first-secret'), token1)

  const token2 = getToken('second-kid.second-secret')

  assert.notEqual(token1, token2)

  const verified = verifyHs256Token(token2, 'second-secret')
  assert.equal(verified.api_key, 'second-kid')
})

test('getToken regenerates token when only the API key secret changes', (t) => {
  const now = 3_200_000_000_000
  let currentTime = now
  t.mock.method(Date, 'now', () => currentTime)

  const token1 = getToken('same-kid.first-secret')
  currentTime = now + 3600 * 1000

  const token2 = getToken('same-kid.second-secret')

  assert.notEqual(token1, token2)

  const verified = verifyHs256Token(token2, 'second-secret')
  assert.equal(verified.api_key, 'same-kid')
})

test('getToken regenerates token after expiration', (t) => {
  const now = 4_000_000_000_999
  let currentTime = now
  t.mock.method(Date, 'now', () => currentTime)

  const apiKey = 'regen-kid.regen-secret'
  const token1 = getToken(apiKey)

  const { payload: firstPayload } = decodeToken(token1)

  currentTime = firstPayload.exp * 1000 - 1
  assert.equal(getToken(apiKey), token1)

  currentTime = firstPayload.exp * 1000
  const token2 = getToken(apiKey)

  assert.notEqual(token1, token2)

  const { payload: decoded } = decodeToken(token2)
  assert.equal(decoded.timestamp, Math.floor(currentTime / 1000))
})

test('getToken throws on invalid API key format (no dot separator)', (t) => {
  // Time past previous token's expiration to force regeneration attempt
  t.mock.method(Date, 'now', () => 5_000_000_000_000)

  assert.throws(() => getToken('no-dot-separator'), {
    message: 'Invalid API key',
  })
})

test('getToken throws on non-string API key', (t) => {
  t.mock.method(Date, 'now', () => 5_500_000_000_000)
  // Seed a valid cache entry so non-string inputs must fail before fingerprinting.
  getToken('non-string-kid.non-string-secret')

  assert.throws(() => getToken(undefined), {
    message: 'Invalid API key',
  })
  assert.throws(() => getToken(null), {
    message: 'Invalid API key',
  })
  assert.throws(() => getToken(123), {
    message: 'Invalid API key',
  })
  assert.throws(() => getToken(Symbol('api-key')), {
    message: 'Invalid API key',
  })
})

test('getToken throws on API key with multiple dots', (t) => {
  // Previous test threw before updating the token fingerprint, so cache still
  // belongs to the last valid key. Use time past all previous expirations to avoid
  // time-based false positives if test order changes.
  t.mock.method(Date, 'now', () => 6_000_000_000_000)

  assert.throws(() => getToken('too.many.dots'), {
    message: 'Invalid API key',
  })
})

test('getToken throws on API key with empty id or secret', (t) => {
  // Previous test threw before updating the token fingerprint, so cache still
  // belongs to the last valid key. Use time past all previous expirations to avoid
  // time-based false positives if test order changes.
  t.mock.method(Date, 'now', () => 6_500_000_000_000)

  assert.throws(() => getToken('missing-secret.'), {
    message: 'Invalid API key',
  })
  assert.throws(() => getToken('.missing-id'), {
    message: 'Invalid API key',
  })
  assert.throws(() => getToken('blank-secret.   '), {
    message: 'Invalid API key',
  })
  assert.throws(() => getToken('   .blank-id'), {
    message: 'Invalid API key',
  })
})
