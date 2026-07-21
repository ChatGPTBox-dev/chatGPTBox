/* global process */

import fs from 'fs-extra'
import jwt from 'jsonwebtoken'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_ARTIFACTS = ['build/chromium.zip', 'build/firefox.zip', 'build/firefox-sources.zip']
const AMO_BASE_URL = 'https://addons.mozilla.org'
const require = createRequire(import.meta.url)
export const FIREFOX_COMPATIBILITY = {
  firefox: {
    min: '58.0',
    max: '*',
  },
  android: {
    min: '120.0',
    max: '*',
  },
}

const REQUIRED_ENV = [
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
]

export function parseArgs(args) {
  return {
    dryRun: args.includes('--dry-run'),
    preflightOnly: args.includes('--preflight-only'),
  }
}

export function findMissingEnv(env = process.env) {
  return REQUIRED_ENV.filter((name) => String(env[name] ?? '').trim().length === 0)
}

export async function findMissingArtifacts({ exists = fs.pathExists } = {}) {
  const missing = []

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!(await exists(artifact))) {
      missing.push(artifact)
    }
  }

  return missing
}

export function buildPublishExtensionArgs({ dryRun }) {
  return [
    ...(dryRun ? ['--dry-run'] : []),
    '--chrome-zip',
    'build/chromium.zip',
    '--firefox-zip',
    'build/firefox.zip',
    '--firefox-sources-zip',
    'build/firefox-sources.zip',
    '--edge-zip',
    'build/chromium.zip',
  ]
}

export function buildFirefoxReleaseNotes(version) {
  return `https://github.com/josStorer/chatGPTBox/releases/tag/v${version}`
}

export function stripFirefoxExtensionId(extensionId) {
  let id = extensionId
  if (id.startsWith('{')) id = id.slice(1)
  if (id.endsWith('}')) id = id.slice(0, -1)
  return id
}

function createFirefoxJwt(jwtIssuer, jwtSecret) {
  const issuedAt = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      iss: jwtIssuer,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + 300,
    },
    jwtSecret,
    { algorithm: 'HS256' },
  )
}

async function readResponseText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function updateFirefoxVersionNotes({
  extensionId,
  version,
  jwtIssuer,
  jwtSecret,
  fetchImpl = fetch,
  logger = console.log,
  maxAttempts = 6,
  retryDelayMs = 10000,
  sleepImpl = sleep,
}) {
  const amoId = encodeURIComponent(stripFirefoxExtensionId(extensionId))
  const authHeader = `JWT ${createFirefoxJwt(jwtIssuer, jwtSecret)}`
  const amoVersion = encodeURIComponent(`v${version}`)
  const releaseNotes = buildFirefoxReleaseNotes(version)
  const patchUrl = `${AMO_BASE_URL}/api/v5/addons/addon/${amoId}/versions/${amoVersion}/`

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const patchResponse = await fetchImpl(patchUrl, {
      method: 'PATCH',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        compatibility: FIREFOX_COMPATIBILITY,
        release_notes: {
          'en-US': releaseNotes,
        },
      }),
    })

    if (patchResponse.ok) {
      logger(`Updated Firefox version metadata: ${releaseNotes}`)
      return
    }

    const body = await readResponseText(patchResponse)
    if (patchResponse.status !== 404 || attempt === maxAttempts) {
      throw new Error(`Failed to update Firefox version metadata: ${patchResponse.status} ${body}`)
    }

    logger(`Firefox AMO version ${version} is not ready yet, retrying metadata update`)
    await sleepImpl(retryDelayMs)
  }
}

function resolvePublishExtensionBin() {
  return require.resolve('publish-browser-extension/cli')
}

function buildPublishExtensionEnv(env, baseEnv = process.env) {
  const merged = { ...baseEnv, ...(env ?? {}) }
  return Object.fromEntries(
    Object.entries(merged)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [name, String(value)]),
  )
}

export async function runPublishExtension(
  args,
  { env, baseEnv = process.env, spawnImpl = spawn } = {},
) {
  const childArgs = [resolvePublishExtensionBin(), ...args]

  await new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, childArgs, {
      stdio: 'inherit',
      shell: false,
      env: buildPublishExtensionEnv(env, baseEnv),
    })

    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`publish-extension exited with code ${code}`))
    })
  })
}

export async function submitStores({
  argv = process.argv.slice(2),
  env: envInput,
  exists = fs.pathExists,
  readJson = fs.readJson,
  runPublishExtensionImpl = runPublishExtension,
  updateFirefoxVersionNotesImpl = updateFirefoxVersionNotes,
  logger = console.log,
  errorLogger = console.error,
} = {}) {
  const { dryRun, preflightOnly } = parseArgs(argv)
  const env = envInput ?? process.env
  const missingArtifacts = await findMissingArtifacts({ exists })
  const missingEnv = preflightOnly ? [] : findMissingEnv(env)

  if (missingArtifacts.length > 0 || missingEnv.length > 0) {
    if (missingArtifacts.length > 0) {
      errorLogger(`Missing release artifacts: ${missingArtifacts.join(', ')}`)
    }
    if (missingEnv.length > 0) {
      errorLogger(`Missing store submission environment variables: ${missingEnv.join(', ')}`)
    }
    throw new Error('Store submission preflight failed')
  }

  let manifest
  try {
    manifest = await readJson('build/firefox/manifest.json')
  } catch (error) {
    errorLogger('Missing or invalid Firefox manifest: build/firefox/manifest.json')
    throw new Error('Store submission preflight failed', { cause: error })
  }

  if (!manifest || typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    errorLogger('Missing Firefox manifest version: build/firefox/manifest.json')
    throw new Error('Store submission preflight failed')
  }

  const firefoxReleaseNotes = buildFirefoxReleaseNotes(manifest.version)
  const mode = preflightOnly ? 'preflight' : dryRun ? 'dry-run' : 'submit'

  logger(`${preflightOnly ? 'Checking' : 'Submitting'} ChatGPTBox ${manifest.version}`)
  logger(`Mode: ${mode}`)
  logger(`Artifacts: ${REQUIRED_ARTIFACTS.join(', ')}`)
  logger(`Firefox version notes: ${firefoxReleaseNotes}`)

  if (preflightOnly) {
    logger('Store authentication, upload, and submission are skipped in preflight mode')
    return
  }

  const args = buildPublishExtensionArgs({ dryRun })
  await runPublishExtensionImpl(args, { env })

  if (!dryRun) {
    await updateFirefoxVersionNotesImpl({
      extensionId: env.FIREFOX_EXTENSION_ID,
      version: manifest.version,
      jwtIssuer: env.FIREFOX_JWT_ISSUER,
      jwtSecret: env.FIREFOX_JWT_SECRET,
    })
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  submitStores().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
