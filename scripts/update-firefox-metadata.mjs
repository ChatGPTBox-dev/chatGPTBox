/* global process */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateFirefoxVersionNotes } from './submit-stores.mjs'

const REQUIRED_FIREFOX_METADATA_ENV = [
  'FIREFOX_EXTENSION_ID',
  'FIREFOX_JWT_ISSUER',
  'FIREFOX_JWT_SECRET',
]

export function parseFirefoxMetadataArgs(args) {
  let version = ''

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--version') {
      version = args[index + 1] || ''
      index += 1
    } else if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length)
    }
  }

  return { version }
}

export function findMissingFirefoxMetadataEnv(env = process.env) {
  return REQUIRED_FIREFOX_METADATA_ENV.filter((name) => {
    const value = env[name]
    return typeof value !== 'string' || value.trim().length === 0
  })
}

export async function updateFirefoxMetadata({
  argv = process.argv.slice(2),
  env = process.env,
  updateImpl = updateFirefoxVersionNotes,
  logger = console.log,
} = {}) {
  const { version } = parseFirefoxMetadataArgs(argv)
  if (!version) {
    throw new Error(
      'Missing Firefox metadata version. Use --version <version>, for example --version 2.6.1',
    )
  }

  const missingEnv = findMissingFirefoxMetadataEnv(env)
  if (missingEnv.length > 0) {
    throw new Error(`Missing Firefox metadata environment variables: ${missingEnv.join(', ')}`)
  }

  logger(`Updating Firefox metadata for ChatGPTBox ${version}`)
  await updateImpl({
    extensionId: env.FIREFOX_EXTENSION_ID,
    version,
    jwtIssuer: env.FIREFOX_JWT_ISSUER,
    jwtSecret: env.FIREFOX_JWT_SECRET,
  })
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  updateFirefoxMetadata().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
