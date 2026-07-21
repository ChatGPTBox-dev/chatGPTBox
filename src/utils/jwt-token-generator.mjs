import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { signHs256Jwt } from './hs256-jwt.mjs'

const textEncoder = new TextEncoder()

let jwtToken = null
let tokenApiKeyFingerprint = null
let tokenExpiration = null // Declare tokenExpiration in the module scope

function assertValidApiKeyType(apiKey) {
  if (typeof apiKey !== 'string') {
    throw new Error('Invalid API key')
  }
}

function parseApiKey(apiKey) {
  assertValidApiKeyType(apiKey)
  const parts = apiKey.split('.')
  if (parts.length !== 2) {
    throw new Error('Invalid API key')
  }

  const [id, secret] = parts
  if ([id, secret].some((part) => part.trim().length === 0)) {
    throw new Error('Invalid API key')
  }

  return { id, secret }
}

function getApiKeyFingerprint(apiKey) {
  return bytesToHex(sha256(textEncoder.encode(apiKey)))
}

function generateToken(apiKey, timeoutSeconds) {
  const { id, secret } = parseApiKey(apiKey)
  const ms = Date.now()
  const currentSeconds = Math.floor(ms / 1000)
  const payload = {
    api_key: id,
    exp: currentSeconds + timeoutSeconds,
    iat: currentSeconds,
    timestamp: currentSeconds,
  }

  jwtToken = signHs256Jwt(payload, secret, {
    alg: 'HS256',
    typ: 'JWT',
    sign_type: 'SIGN',
  })
  tokenApiKeyFingerprint = getApiKeyFingerprint(apiKey)
  tokenExpiration = payload.exp * 1000
}

function shouldRegenerateToken(apiKey) {
  const ms = Date.now()
  return (
    !jwtToken || ms >= tokenExpiration || getApiKeyFingerprint(apiKey) !== tokenApiKeyFingerprint
  )
}

function getToken(apiKey) {
  assertValidApiKeyType(apiKey)
  if (shouldRegenerateToken(apiKey)) {
    generateToken(apiKey, 86400) // Hard-coded to regenerate the token every 24 hours
  }
  return jwtToken
}

export { getToken }
