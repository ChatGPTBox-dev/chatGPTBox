import assert from 'node:assert/strict'
import { test } from 'node:test'
import jwt from 'jsonwebtoken'

// Module caches a single token globally; tests must use monotonically
// increasing times so each test can force regeneration when needed.
import { getToken } from '../../../src/utils/jwt-token-generator.mjs'

test('getToken generates a valid JWT with correct header and payload structure', (t) => {
  const now = 1_000_000_000_000
  t.mock.method(Date, 'now', () => now)

  const apiKey = 'my-kid.my-secret'
  const token = getToken(apiKey)

  const decoded = jwt.decode(token, { complete: true })
  assert.equal(decoded.header.alg, 'HS256')
  assert.equal(decoded.header.typ, 'JWT')
  assert.equal(decoded.header.sign_type, 'SIGN')
  assert.equal(decoded.payload.api_key, 'my-kid')
  assert.equal(decoded.payload.timestamp, Math.floor(now / 1000))
  assert.equal(decoded.payload.exp, Math.floor(now / 1000) + 86400)
})

test('getToken verifies with the secret from the API key', (t) => {
  const now = 2_000_000_000_000
  t.mock.method(Date, 'now', () => now)

  const apiKey = 'kid123.supersecret'
  const token = getToken(apiKey)

  const verified = jwt.verify(token, 'supersecret')
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

test('getToken regenerates token after expiration', (t) => {
  const now = 4_000_000_000_000
  let currentTime = now
  t.mock.method(Date, 'now', () => currentTime)

  const apiKey = 'regen-kid.regen-secret'
  const token1 = getToken(apiKey)

  // Advance time past the 24-hour expiry
  currentTime = now + 86400 * 1000 + 1
  const token2 = getToken(apiKey)

  assert.notEqual(token1, token2)

  const decoded = jwt.decode(token2)
  assert.equal(decoded.timestamp, Math.floor(currentTime / 1000))
})

test('getToken throws on invalid API key format (no dot separator)', (t) => {
  // Time past previous token's expiration to force regeneration attempt
  t.mock.method(Date, 'now', () => 5_000_000_000_000)

  assert.throws(() => getToken('no-dot-separator'), {
    message: 'Invalid API key',
  })
})

test('getToken throws on API key with multiple dots', (t) => {
  // Previous test threw before updating cache, so cache still holds old expiry.
  // Use time past all previous expirations.
  t.mock.method(Date, 'now', () => 6_000_000_000_000)

  assert.throws(() => getToken('too.many.dots'), {
    message: 'Invalid API key',
  })
})
