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

test('signHs256Jwt signs UTF-8 payload and secret values', () => {
  const token = signHs256Jwt({ name: 'café', scope: 'read:résumé' }, 'sëcret-key')
  const verifiedToken = verifyHs256Token(token, 'sëcret-key')

  assert.deepEqual(verifiedToken.payload, {
    name: 'café',
    scope: 'read:résumé',
  })
})
