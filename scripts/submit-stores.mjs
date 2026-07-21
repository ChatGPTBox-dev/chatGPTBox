/* global process */

import fs from 'fs-extra'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { signHs256Jwt } from '../src/utils/hs256-jwt.mjs'

const REQUIRED_ARTIFACTS = ['build/chromium.zip', 'build/firefox.zip', 'build/firefox-sources.zip']
const AMO_BASE_URL = 'https://addons.mozilla.org'
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
  }
}

export function findMissingEnv(env = process.env) {
  return REQUIRED_ENV.filter((name) => {
    const value = env[name]
    return typeof value !== 'string' || value.trim().length === 0
  })
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
  const command = process.platform === 'win32' ? 'publish-extension.cmd' : 'publish-extension'
  return path.join(process.cwd(), 'node_modules', '.bin', command)
}

async function runPublishExtension(args) {
  const command = resolvePublishExtensionBin()

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      env: process.env,
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

export async function submitStores({ argv = process.argv.slice(2), env = process.env } = {}) {
  const { dryRun } = parseArgs(argv)
  const missingArtifacts = await findMissingArtifacts()
  const missingEnv = findMissingEnv(env)

  if (missingArtifacts.length > 0 || missingEnv.length > 0) {
    if (missingArtifacts.length > 0) {
      console.error(`Missing release artifacts: ${missingArtifacts.join(', ')}`)
    }
    if (missingEnv.length > 0) {
      console.error(`Missing store submission environment variables: ${missingEnv.join(', ')}`)
    }
    throw new Error('Store submission preflight failed')
  }

  const manifest = await fs.readJson('build/firefox/manifest.json')
  const args = buildPublishExtensionArgs({ dryRun })
  const firefoxReleaseNotes = buildFirefoxReleaseNotes(manifest.version)

  console.log(`Submitting ChatGPTBox ${manifest.version} to Chrome, Firefox, and Edge`)
  console.log(`Mode: ${dryRun ? 'dry-run' : 'submit'}`)
  console.log(`Artifacts: ${REQUIRED_ARTIFACTS.join(', ')}`)
  console.log(`Firefox version notes: ${firefoxReleaseNotes}`)

  await runPublishExtension(args)

  if (!dryRun) {
    await updateFirefoxVersionNotes({
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
