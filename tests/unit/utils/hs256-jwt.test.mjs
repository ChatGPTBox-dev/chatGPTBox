import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { signHs256Jwt } from '../../../src/utils/hs256-jwt.mjs'

function decodeTokenPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

function verifyHs256Token(token, secret) {
  const [header, payload, signature] = token.split('.')
  const expectedSignature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url')

  assert.equal(signature, expectedSignature)
  return {
    header: decodeTokenPart(header),
    payload: decodeTokenPart(payload),
  }
}

test('signHs256Jwt uses the standard HS256 JWT header by default', () => {
  const token = signHs256Jwt({ sub: 'user-1' }, 'secret')
  const verifiedToken = verifyHs256Token(token, 'secret')

  assert.equal(verifiedToken.header.alg, 'HS256')
  assert.equal(verifiedToken.header.typ, 'JWT')
  assert.deepEqual(verifiedToken.payload, { sub: 'user-1' })
})

test('signHs256Jwt preserves a custom header', () => {
  const token = signHs256Jwt({ api_key: 'kid' }, 'secret', {
    alg: 'HS256',
    typ: 'JWT',
    sign_type: 'SIGN',
  })
  const verifiedToken = verifyHs256Token(token, 'secret')

  assert.deepEqual(verifiedToken.header, {
    alg: 'HS256',
    typ: 'JWT',
    sign_type: 'SIGN',
  })
  assert.deepEqual(verifiedToken.payload, { api_key: 'kid' })
})

test('signHs256Jwt writes standard JWT header fields before custom fields', () => {
  const token = signHs256Jwt({ api_key: 'kid' }, 'secret', {
    sign_type: 'SIGN',
  })
  const [encodedHeader] = token.split('.')

  assert.equal(
    Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    '{"alg":"HS256","typ":"JWT","sign_type":"SIGN"}',
  )
})

test('signHs256Jwt pins the algorithm header to HS256', () => {
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', { alg: 'none' }), {
    message: 'signHs256Jwt only supports HS256',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', { alg: '' }), {
    message: 'signHs256Jwt only supports HS256',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', { typ: 'JWT+custom' }), {
    message: 'signHs256Jwt only supports JWT typ',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', { typ: '' }), {
    message: 'signHs256Jwt only supports JWT typ',
  })

  const token = signHs256Jwt({ sub: 'user-1' }, 'secret', {
    sign_type: 'SIGN',
  })
  const verifiedToken = verifyHs256Token(token, 'secret')

  assert.deepEqual(verifiedToken.header, {
    alg: 'HS256',
    typ: 'JWT',
    sign_type: 'SIGN',
  })
})

test('signHs256Jwt rejects missing or non-object payloads', () => {
  assert.throws(() => signHs256Jwt(undefined, 'secret'), {
    message: 'JWT payload must be a non-array object',
  })
  assert.throws(() => signHs256Jwt(null, 'secret'), {
    message: 'JWT payload must be a non-array object',
  })
  assert.throws(() => signHs256Jwt([], 'secret'), {
    message: 'JWT payload must be a non-array object',
  })
})

test('signHs256Jwt rejects missing or empty secrets', () => {
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, undefined), {
    message: 'JWT secret must be a non-empty string',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, null), {
    message: 'JWT secret must be a non-empty string',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, ''), {
    message: 'JWT secret must be a non-empty string',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, '   '), {
    message: 'JWT secret must be a non-empty string',
  })
})

test('signHs256Jwt rejects non-object headers', () => {
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', null), {
    message: 'JWT header must be a non-array object',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', []), {
    message: 'JWT header must be a non-array object',
  })
  assert.throws(() => signHs256Jwt({ sub: 'user-1' }, 'secret', 'HS256'), {
    message: 'JWT header must be a non-array object',
  })
})

test('signHs256Jwt signs UTF-8 payload and secret values', () => {
  const token = signHs256Jwt({ name: 'café', scope: 'read:résumé' }, 'sëcret-key')
  const verifiedToken = verifyHs256Token(token, 'sëcret-key')

  assert.deepEqual(verifiedToken.payload, {
    name: 'café',
    scope: 'read:résumé',
  })
})
