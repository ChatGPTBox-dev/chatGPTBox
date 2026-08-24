/* global process */

import fs from 'fs-extra'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { signHs256Jwt } from '../src/utils/hs256-jwt.mjs'

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

const STORE_ENV = {
  chrome: [
    'CHROME_EXTENSION_ID',
    'CHROME_CLIENT_ID',
    'CHROME_CLIENT_SECRET',
    'CHROME_REFRESH_TOKEN',
  ],
  firefox: ['FIREFOX_EXTENSION_ID', 'FIREFOX_JWT_ISSUER', 'FIREFOX_JWT_SECRET'],
  edge: ['EDGE_PRODUCT_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY'],
}
const STORE_IDS = Object.keys(STORE_ENV)

export function parseArgs(args) {
  const storeFlag = args.find((arg) => arg.startsWith('--store='))
  const storeIndex = args.indexOf('--store')
  const selectedStore = storeFlag
    ? storeFlag.slice('--store='.length)
    : storeIndex >= 0
    ? args[storeIndex + 1]
    : null

  if (selectedStore !== null && !STORE_IDS.includes(selectedStore)) {
    throw new Error(`Unknown store: ${selectedStore || '(missing)'}`)
  }

  return {
    dryRun: args.includes('--dry-run'),
    preflightOnly: args.includes('--preflight-only'),
    stores: selectedStore ? [selectedStore] : STORE_IDS,
  }
}

export function findMissingEnv(env = process.env, stores = STORE_IDS) {
  return stores.flatMap((store) =>
    STORE_ENV[store].filter(
      (name) => typeof env[name] !== 'string' || env[name].trim().length === 0,
    ),
  )
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

export function buildPublishExtensionArgs({ dryRun, stores = STORE_IDS }) {
  const args = dryRun ? ['--dry-run'] : []

  if (stores.includes('chrome')) {
    args.push('--chrome-zip', 'build/chromium.zip')
  }
  if (stores.includes('firefox')) {
    args.push('--firefox-zip', 'build/firefox.zip')
    args.push('--firefox-sources-zip', 'build/firefox-sources.zip')
  }
  if (stores.includes('edge')) {
    args.push('--edge-zip', 'build/chromium.zip')
  }

  return args
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
  return signHs256Jwt(
    {
      iss: jwtIssuer,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + 300,
    },
    jwtSecret,
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
  const amoVersion = encodeURIComponent(`v${version}`)
  const releaseNotes = buildFirefoxReleaseNotes(version)
  const patchUrl = `${AMO_BASE_URL}/api/v5/addons/addon/${amoId}/versions/${amoVersion}/`

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const authHeader = `JWT ${createFirefoxJwt(jwtIssuer, jwtSecret)}`
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
  const { dryRun, preflightOnly, stores } = parseArgs(argv)
  const skipFirefoxMetadata = argv.includes('--skip-firefox-metadata')
  const env = envInput ?? process.env
  const missingArtifacts = await findMissingArtifacts({ exists })
  const missingEnv = preflightOnly ? [] : findMissingEnv(env, stores)

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

  if (
    !manifest ||
    typeof manifest.version !== 'string' ||
    manifest.version.trim().length === 0 ||
    manifest.version !== manifest.version.trim()
  ) {
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

  const args = buildPublishExtensionArgs({ dryRun, stores })
  await runPublishExtensionImpl(args, { env })

  if (!dryRun && stores.includes('firefox') && !skipFirefoxMetadata) {
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
