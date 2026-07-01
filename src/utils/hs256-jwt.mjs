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

function signHs256Jwt(payload, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const encodedHeader = encodeJson(header)
  const encodedPayload = encodeJson(payload)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = hmac(sha256, textEncoder.encode(secret), textEncoder.encode(signingInput))

  return `${signingInput}.${toBase64Url(signature)}`
}

export { signHs256Jwt }
