import { signHs256Jwt } from './hs256-jwt.mjs'

let jwtToken = null
let tokenApiKey = null
let tokenExpiration = null // Declare tokenExpiration in the module scope

function generateToken(apiKey, timeoutSeconds) {
  const parts = apiKey.split('.')
  if (parts.length !== 2) {
    throw new Error('Invalid API key')
  }

  const ms = Date.now()
  const currentSeconds = Math.floor(ms / 1000)
  const [id, secret] = parts
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
  tokenApiKey = apiKey
  tokenExpiration = ms + timeoutSeconds * 1000
}

function shouldRegenerateToken(apiKey) {
  const ms = Date.now()
  return !jwtToken || apiKey !== tokenApiKey || ms >= tokenExpiration
}

function getToken(apiKey) {
  if (shouldRegenerateToken(apiKey)) {
    generateToken(apiKey, 86400) // Hard-coded to regenerate the token every 24 hours
  }
  return jwtToken
}

export { getToken }
