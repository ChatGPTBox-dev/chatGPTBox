import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const textEncoder = new TextEncoder()

function toBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function encodeJson(data) {
  return toBase64Url(textEncoder.encode(JSON.stringify(data)))
}

function signHs256Jwt(payload, secret, header = {}) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('JWT payload must be a non-array object')
  }
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new TypeError('JWT secret must be a non-empty string')
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new TypeError('JWT header must be a non-array object')
  }
  if (header.alg !== undefined && header.alg !== 'HS256') {
    throw new Error('signHs256Jwt only supports HS256')
  }
  if (header.typ !== undefined && header.typ !== 'JWT') {
    throw new Error('signHs256Jwt only supports JWT typ')
  }

  const customHeader = { ...header }
  delete customHeader.alg
  delete customHeader.typ
  const encodedHeader = encodeJson({ alg: 'HS256', typ: 'JWT', ...customHeader })
  const encodedPayload = encodeJson(payload)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = hmac(sha256, textEncoder.encode(secret), textEncoder.encode(signingInput))

  return `${signingInput}.${toBase64Url(signature)}`
}

export { signHs256Jwt }
