import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  buildFirefoxReleaseNotes,
  buildPublishExtensionArgs,
  FIREFOX_COMPATIBILITY,
  findMissingArtifacts,
  findMissingEnv,
  parseArgs,
  stripFirefoxExtensionId,
  updateFirefoxVersionNotes,
} from '../../../scripts/submit-stores.mjs'

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

test('parseArgs detects dry run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true })
  assert.deepEqual(parseArgs([]), { dryRun: false })
})

test('findMissingEnv reports all required secrets', () => {
  const missing = findMissingEnv({})
  assert.deepEqual(missing, [
    'CHROME_EXTENSION_ID',
    'CHROME_CLIENT_ID',
    'CHROME_CLIENT_SECRET',
    'CHROME_REFRESH_TOKEN',
    'FIREFOX_EXTENSION_ID',
    'FIREFOX_JWT_ISSUER',
    'FIREFOX_JWT_SECRET',
    'EDGE_PRODUCT_ID',
    'EDGE_CLIENT_ID',
    'EDGE_API_KEY',
  ])
})

test('findMissingEnv accepts required secrets', () => {
  const env = {
    CHROME_EXTENSION_ID: 'chrome-id',
    CHROME_CLIENT_ID: 'chrome-client',
    CHROME_CLIENT_SECRET: 'chrome-secret',
    CHROME_REFRESH_TOKEN: 'chrome-refresh',
    FIREFOX_EXTENSION_ID: 'chatgptbox',
    FIREFOX_JWT_ISSUER: 'firefox-issuer',
    FIREFOX_JWT_SECRET: 'firefox-secret',
    EDGE_PRODUCT_ID: 'edge-product',
    EDGE_CLIENT_ID: 'edge-client',
    EDGE_API_KEY: 'edge-key',
  }

  assert.deepEqual(findMissingEnv(env), [])
})

test('findMissingEnv treats whitespace-only secrets as missing', () => {
  const env = {
    CHROME_EXTENSION_ID: 'chrome-id',
    CHROME_CLIENT_ID: 'chrome-client',
    CHROME_CLIENT_SECRET: '   ',
    CHROME_REFRESH_TOKEN: 'chrome-refresh',
    FIREFOX_EXTENSION_ID: 'chatgptbox',
    FIREFOX_JWT_ISSUER: 'firefox-issuer',
    FIREFOX_JWT_SECRET: '   ',
    EDGE_PRODUCT_ID: 'edge-product',
    EDGE_CLIENT_ID: 'edge-client',
    EDGE_API_KEY: 'edge-key',
  }

  assert.deepEqual(findMissingEnv(env), ['CHROME_CLIENT_SECRET', 'FIREFOX_JWT_SECRET'])
})

test('findMissingArtifacts reports missing artifacts', async () => {
  const exists = async (file) => file.endsWith('firefox.zip')
  const missing = await findMissingArtifacts({ exists })

  assert.deepEqual(missing, ['build/chromium.zip', 'build/firefox-sources.zip'])
})

test('buildPublishExtensionArgs includes all stores and dry run', () => {
  const args = buildPublishExtensionArgs({ dryRun: true })

  assert.deepEqual(args, [
    '--dry-run',
    '--chrome-zip',
    'build/chromium.zip',
    '--firefox-zip',
    'build/firefox.zip',
    '--firefox-sources-zip',
    'build/firefox-sources.zip',
    '--edge-zip',
    'build/chromium.zip',
  ])
})

test('buildFirefoxReleaseNotes returns the fixed GitHub release URL', () => {
  assert.equal(
    buildFirefoxReleaseNotes('2.6.1'),
    'https://github.com/josStorer/chatGPTBox/releases/tag/v2.6.1',
  )
})

test('stripFirefoxExtensionId removes AMO GUID braces', () => {
  assert.equal(stripFirefoxExtensionId('{chatgptbox@example.com}'), 'chatgptbox@example.com')
  assert.equal(stripFirefoxExtensionId('chatgptbox'), 'chatgptbox')
})

test('updateFirefoxVersionNotes patches release notes and compatibility for the matching AMO version', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })

    return {
      ok: true,
      async text() {
        return ''
      },
    }
  }

  const issuedBefore = Math.floor(Date.now() / 1000)
  await updateFirefoxVersionNotes({
    extensionId: '{chatgptbox}',
    version: '2.6.1',
    jwtIssuer: 'issuer',
    jwtSecret: 'secret',
    fetchImpl,
    logger: () => {},
  })
  const issuedAfter = Math.floor(Date.now() / 1000)

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://addons.mozilla.org/api/v5/addons/addon/chatgptbox/versions/v2.6.1/',
  )
  assert.equal(calls[0].init.method, 'PATCH')

  const authorization = calls[0].init.headers.Authorization
  assert.match(authorization, /^JWT /)
  const authToken = authorization.slice(4)
  const verifiedToken = verifyHs256Token(authToken, 'secret')
  assert.equal(verifiedToken.header.alg, 'HS256')
  assert.equal(verifiedToken.header.typ, 'JWT')
  assert.equal(verifiedToken.payload.iss, 'issuer')
  assert.ok(verifiedToken.payload.iat >= issuedBefore)
  assert.ok(verifiedToken.payload.iat <= issuedAfter)
  assert.equal(verifiedToken.payload.exp - verifiedToken.payload.iat, 300)
  assert.match(verifiedToken.payload.jti, /^[0-9a-f-]{36}$/)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    compatibility: FIREFOX_COMPATIBILITY,
    release_notes: {
      'en-US': 'https://github.com/josStorer/chatGPTBox/releases/tag/v2.6.1',
    },
  })
})

test('updateFirefoxVersionNotes retries when the AMO version endpoint is not ready yet', async (t) => {
  const calls = []
  let now = 10_000_000_000
  t.mock.method(Date, 'now', () => now)
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })

    if (calls.length < 3) {
      return {
        ok: false,
        status: 404,
        async text() {
          return 'not found'
        },
      }
    }

    return {
      ok: true,
      async text() {
        return ''
      },
    }
  }
  const sleepImpl = async (ms) => {
    now += ms
  }

  await updateFirefoxVersionNotes({
    extensionId: 'chatgptbox',
    version: '2.6.1',
    jwtIssuer: 'issuer',
    jwtSecret: 'secret',
    fetchImpl,
    logger: () => {},
    sleepImpl,
    retryDelayMs: 60000,
    maxAttempts: 3,
  })

  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.url.endsWith('/versions/v2.6.1/')))
  const payloads = calls.map((call) => {
    const authorization = call.init.headers.Authorization
    assert.match(authorization, /^JWT /)
    return verifyHs256Token(authorization.slice(4), 'secret').payload
  })
  assert.deepEqual(
    payloads.map((payload) => payload.iat),
    [10000000, 10000060, 10000120],
  )
  assert.deepEqual(
    payloads.map((payload) => payload.exp - payload.iat),
    [300, 300, 300],
  )
  assert.equal(new Set(payloads.map((payload) => payload.jti)).size, 3)
})
