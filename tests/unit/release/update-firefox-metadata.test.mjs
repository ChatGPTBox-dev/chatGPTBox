import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findMissingFirefoxMetadataEnv,
  parseFirefoxMetadataArgs,
  updateFirefoxMetadata,
} from '../../../scripts/update-firefox-metadata.mjs'

test('parseFirefoxMetadataArgs reads the target version', () => {
  assert.deepEqual(parseFirefoxMetadataArgs(['--version', '2.6.1']), { version: '2.6.1' })
  assert.deepEqual(parseFirefoxMetadataArgs(['--version=2.6.1']), { version: '2.6.1' })
})

test('findMissingFirefoxMetadataEnv reports required Firefox secrets only', () => {
  assert.deepEqual(findMissingFirefoxMetadataEnv({}), [
    'FIREFOX_EXTENSION_ID',
    'FIREFOX_JWT_ISSUER',
    'FIREFOX_JWT_SECRET',
  ])

  assert.deepEqual(
    findMissingFirefoxMetadataEnv({
      FIREFOX_EXTENSION_ID: 'chatgptbox',
      FIREFOX_JWT_ISSUER: 'issuer',
      FIREFOX_JWT_SECRET: 'secret',
    }),
    [],
  )
})

test('findMissingFirefoxMetadataEnv treats whitespace-only secrets as missing', () => {
  assert.deepEqual(
    findMissingFirefoxMetadataEnv({
      FIREFOX_EXTENSION_ID: 'chatgptbox',
      FIREFOX_JWT_ISSUER: '   ',
      FIREFOX_JWT_SECRET: '   ',
    }),
    ['FIREFOX_JWT_ISSUER', 'FIREFOX_JWT_SECRET'],
  )
})

test('updateFirefoxMetadata patches the requested Firefox version only', async () => {
  const calls = []

  await updateFirefoxMetadata({
    argv: ['--version', '2.6.1'],
    env: {
      FIREFOX_EXTENSION_ID: 'chatgptbox',
      FIREFOX_JWT_ISSUER: 'issuer',
      FIREFOX_JWT_SECRET: 'secret',
    },
    updateImpl: async (params) => {
      calls.push(params)
    },
    logger: () => {},
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    extensionId: 'chatgptbox',
    version: '2.6.1',
    jwtIssuer: 'issuer',
    jwtSecret: 'secret',
  })
})

test('updateFirefoxMetadata fails before patching when version or secrets are missing', async () => {
  await assert.rejects(
    updateFirefoxMetadata({
      argv: [],
      env: {},
      updateImpl: async () => {
        throw new Error('should not patch')
      },
      logger: () => {},
    }),
    /Missing Firefox metadata version/,
  )

  await assert.rejects(
    updateFirefoxMetadata({
      argv: ['--version', '2.6.1'],
      env: {},
      updateImpl: async () => {
        throw new Error('should not patch')
      },
      logger: () => {},
    }),
    /Missing Firefox metadata environment variables/,
  )
})
