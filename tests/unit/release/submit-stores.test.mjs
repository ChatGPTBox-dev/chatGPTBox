import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import process from 'node:process'
import test from 'node:test'
import {
  buildFirefoxReleaseNotes,
  buildPublishExtensionArgs,
  runPublishExtension,
  FIREFOX_COMPATIBILITY,
  findMissingArtifacts,
  findMissingEnv,
  parseArgs,
  stripFirefoxExtensionId,
  submitStores,
  updateFirefoxVersionNotes,
} from '../../../scripts/submit-stores.mjs'

const require = createRequire(import.meta.url)
const publishExtensionCli = require.resolve('publish-browser-extension/cli')

test('parseArgs detects dry run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, preflightOnly: false })
  assert.deepEqual(parseArgs(['--preflight-only']), { dryRun: false, preflightOnly: true })
  assert.deepEqual(parseArgs(['--dry-run', '--preflight-only']), {
    dryRun: true,
    preflightOnly: true,
  })
  assert.deepEqual(parseArgs([]), { dryRun: false, preflightOnly: false })
})

function createStoreEnv() {
  return {
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
}

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
  assert.deepEqual(findMissingEnv(createStoreEnv()), [])
})

test('findMissingEnv rejects blank required secrets', () => {
  const env = createStoreEnv()
  env.FIREFOX_JWT_SECRET = '   '

  assert.deepEqual(findMissingEnv(env), ['FIREFOX_JWT_SECRET'])
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

test('runPublishExtension merges env overrides before spawning publish-extension', async () => {
  const child = new EventEmitter()
  const spawnCalls = []

  await runPublishExtension(['--dry-run'], {
    baseEnv: { PATH: 'parent-path', CHROME_EXTENSION_ID: 'parent-chrome-id' },
    env: { CHROME_EXTENSION_ID: 'override-chrome-id' },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options })
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })

  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].command, process.execPath)
  assert.equal(spawnCalls[0].args[0], publishExtensionCli)
  assert.deepEqual(spawnCalls[0].args.slice(1), ['--dry-run'])
  assert.equal(spawnCalls[0].options.shell, false)
  assert.equal(spawnCalls[0].options.env.PATH, 'parent-path')
  assert.equal(spawnCalls[0].options.env.CHROME_EXTENSION_ID, 'override-chrome-id')
})

test('runPublishExtension omits nullish env values before spawning publish-extension', async () => {
  const child = new EventEmitter()
  const spawnCalls = []

  await runPublishExtension([], {
    baseEnv: {
      PATH: 'parent-path',
      CHROME_EXTENSION_ID: 'parent-chrome-id',
      EMPTY_VALUE: 'parent-empty',
    },
    env: {
      CHROME_EXTENSION_ID: undefined,
      FIREFOX_JWT_SECRET: null,
      EMPTY_VALUE: '',
      NUMERIC_VALUE: 123,
      BOOLEAN_VALUE: false,
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options })
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })

  assert.equal(spawnCalls[0].options.env.PATH, 'parent-path')
  assert.equal(spawnCalls[0].options.env.EMPTY_VALUE, '')
  assert.equal(spawnCalls[0].options.env.NUMERIC_VALUE, '123')
  assert.equal(spawnCalls[0].options.env.BOOLEAN_VALUE, 'false')
  assert.equal('CHROME_EXTENSION_ID' in spawnCalls[0].options.env, false)
  assert.equal('FIREFOX_JWT_SECRET' in spawnCalls[0].options.env, false)
})

test('runPublishExtension invokes publish-extension through node', async () => {
  const child = new EventEmitter()
  const spawnCalls = []

  await runPublishExtension(['--dry-run'], {
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options })
      queueMicrotask(() => child.emit('exit', 0))
      return child
    },
  })

  assert.equal(spawnCalls[0].command, process.execPath)
  assert.equal(spawnCalls[0].args[0], publishExtensionCli)
  assert.deepEqual(spawnCalls[0].args.slice(1), ['--dry-run'])
  assert.equal(spawnCalls[0].options.shell, false)
})

test('runPublishExtension rejects when publish-extension exits with non-zero code', async () => {
  const child = new EventEmitter()

  await assert.rejects(
    runPublishExtension(['--dry-run'], {
      spawnImpl: () => {
        queueMicrotask(() => child.emit('exit', 1))
        return child
      },
    }),
    /publish-extension exited with code 1/,
  )
})

test('runPublishExtension rejects when publish-extension cannot start', async () => {
  const child = new EventEmitter()
  const error = new Error('spawn failed')

  await assert.rejects(
    runPublishExtension(['--dry-run'], {
      spawnImpl: () => {
        queueMicrotask(() => child.emit('error', error))
        return child
      },
    }),
    (actual) => actual === error,
  )
})

test('buildFirefoxReleaseNotes returns the fixed GitHub release URL', () => {
  assert.equal(
    buildFirefoxReleaseNotes('2.6.1'),
    'https://github.com/josStorer/chatGPTBox/releases/tag/v2.6.1',
  )
})

test('submitStores preflight skips store env and publish-extension', async () => {
  const publishCalls = []

  await submitStores({
    argv: ['--preflight-only'],
    env: {},
    exists: async () => true,
    readJson: async () => ({ version: '2.6.1' }),
    runPublishExtensionImpl: async (args) => publishCalls.push(args),
    logger: () => {},
    errorLogger: () => {},
  })

  assert.deepEqual(publishCalls, [])
})

test('submitStores preflight takes precedence over dry run', async () => {
  const publishCalls = []
  const metadataCalls = []

  await submitStores({
    argv: ['--dry-run', '--preflight-only'],
    env: {},
    exists: async () => true,
    readJson: async () => ({ version: '2.6.1' }),
    runPublishExtensionImpl: async (args) => publishCalls.push(args),
    updateFirefoxVersionNotesImpl: async (options) => metadataCalls.push(options),
    logger: () => {},
    errorLogger: () => {},
  })

  assert.deepEqual(publishCalls, [])
  assert.deepEqual(metadataCalls, [])
})

test('submitStores preflight fails on missing artifacts before publishing', async () => {
  const publishCalls = []
  let manifestRead = false

  await assert.rejects(
    submitStores({
      argv: ['--preflight-only'],
      env: {},
      exists: async (file) => file !== 'build/firefox-sources.zip',
      readJson: async () => {
        manifestRead = true
        return { version: '2.6.1' }
      },
      runPublishExtensionImpl: async (args) => publishCalls.push(args),
      logger: () => {},
      errorLogger: () => {},
    }),
    /Store submission preflight failed/,
  )

  assert.equal(manifestRead, false)
  assert.deepEqual(publishCalls, [])
})

test('submitStores preflight fails when Firefox manifest cannot be read', async () => {
  const publishCalls = []

  await assert.rejects(
    submitStores({
      argv: ['--preflight-only'],
      env: {},
      exists: async () => true,
      readJson: async () => {
        throw new Error('ENOENT')
      },
      runPublishExtensionImpl: async (args) => publishCalls.push(args),
      logger: () => {},
      errorLogger: () => {},
    }),
    /Store submission preflight failed/,
  )

  assert.deepEqual(publishCalls, [])
})

test('submitStores preflight fails when Firefox manifest version is missing or invalid', async () => {
  for (const manifest of [
    null,
    {},
    { version: '' },
    { version: '   ' },
    { version: 123 },
    { version: null },
  ]) {
    const publishCalls = []

    await assert.rejects(
      submitStores({
        argv: ['--preflight-only'],
        env: {},
        exists: async () => true,
        readJson: async () => manifest,
        runPublishExtensionImpl: async (args) => publishCalls.push(args),
        logger: () => {},
        errorLogger: () => {},
      }),
      /Store submission preflight failed/,
    )

    assert.deepEqual(publishCalls, [])
  }
})

test('submitStores dry run and submit fail when Firefox manifest is invalid before publishing', async () => {
  for (const argv of [['--dry-run'], []]) {
    for (const readJson of [
      async () => {
        throw new Error('ENOENT')
      },
      async () => null,
      async () => ({ version: '   ' }),
    ]) {
      const publishCalls = []
      const metadataCalls = []

      await assert.rejects(
        submitStores({
          argv,
          env: createStoreEnv(),
          exists: async () => true,
          readJson,
          runPublishExtensionImpl: async (args) => publishCalls.push(args),
          updateFirefoxVersionNotesImpl: async (options) => metadataCalls.push(options),
          logger: () => {},
          errorLogger: () => {},
        }),
        /Store submission preflight failed/,
      )

      assert.deepEqual(publishCalls, [])
      assert.deepEqual(metadataCalls, [])
    }
  }
})

test('submitStores falls back to process env when env is null', async () => {
  const storeEnv = createStoreEnv()
  const previousEnv = Object.fromEntries(
    Object.keys(storeEnv).map((name) => [name, process.env[name]]),
  )

  for (const [name, value] of Object.entries(storeEnv)) {
    process.env[name] = value
  }

  try {
    const publishCalls = []
    const metadataCalls = []

    await submitStores({
      argv: [],
      env: null,
      exists: async () => true,
      readJson: async () => ({ version: '2.6.1' }),
      runPublishExtensionImpl: async (args, options) => publishCalls.push({ args, options }),
      updateFirefoxVersionNotesImpl: async (options) => metadataCalls.push(options),
      logger: () => {},
      errorLogger: () => {},
    })

    assert.deepEqual(publishCalls[0].args, buildPublishExtensionArgs({ dryRun: false }))
    assert.equal(publishCalls[0].options.env, process.env)
    assert.equal(metadataCalls[0].extensionId, storeEnv.FIREFOX_EXTENSION_ID)
    assert.equal(metadataCalls[0].jwtIssuer, storeEnv.FIREFOX_JWT_ISSUER)
    assert.equal(metadataCalls[0].jwtSecret, storeEnv.FIREFOX_JWT_SECRET)
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
})

test('submitStores dry run still invokes publish-extension with dry-run args', async () => {
  const publishCalls = []
  const metadataCalls = []

  await submitStores({
    argv: ['--dry-run'],
    env: createStoreEnv(),
    exists: async () => true,
    readJson: async () => ({ version: '2.6.1' }),
    runPublishExtensionImpl: async (args) => publishCalls.push(args),
    updateFirefoxVersionNotesImpl: async (options) => metadataCalls.push(options),
    logger: () => {},
    errorLogger: () => {},
  })

  assert.deepEqual(publishCalls, [buildPublishExtensionArgs({ dryRun: true })])
  assert.deepEqual(metadataCalls, [])
})

test('submitStores dry run fails without store env before publishing', async () => {
  const publishCalls = []
  let manifestRead = false

  await assert.rejects(
    submitStores({
      argv: ['--dry-run'],
      env: {},
      exists: async () => true,
      readJson: async () => {
        manifestRead = true
        return { version: '2.6.1' }
      },
      runPublishExtensionImpl: async (args) => publishCalls.push(args),
      logger: () => {},
      errorLogger: () => {},
    }),
    /Store submission preflight failed/,
  )

  assert.equal(manifestRead, false)
  assert.deepEqual(publishCalls, [])
})

test('submitStores submit fails without store env before publishing', async () => {
  const publishCalls = []
  let manifestRead = false

  await assert.rejects(
    submitStores({
      argv: [],
      env: {},
      exists: async () => true,
      readJson: async () => {
        manifestRead = true
        return { version: '2.6.1' }
      },
      runPublishExtensionImpl: async (args) => publishCalls.push(args),
      logger: () => {},
      errorLogger: () => {},
    }),
    /Store submission preflight failed/,
  )

  assert.equal(manifestRead, false)
  assert.deepEqual(publishCalls, [])
})

test('submitStores submit invokes publish-extension and updates Firefox metadata', async () => {
  const env = createStoreEnv()
  const publishCalls = []
  const metadataCalls = []

  await submitStores({
    argv: [],
    env,
    exists: async () => true,
    readJson: async () => ({ version: '2.6.1' }),
    runPublishExtensionImpl: async (args, options) => publishCalls.push({ args, env: options.env }),
    updateFirefoxVersionNotesImpl: async (options) => metadataCalls.push(options),
    logger: () => {},
    errorLogger: () => {},
  })

  assert.deepEqual(publishCalls, [
    {
      args: buildPublishExtensionArgs({ dryRun: false }),
      env,
    },
  ])
  assert.deepEqual(metadataCalls, [
    {
      extensionId: 'chatgptbox',
      version: '2.6.1',
      jwtIssuer: 'firefox-issuer',
      jwtSecret: 'firefox-secret',
    },
  ])
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

  await updateFirefoxVersionNotes({
    extensionId: '{chatgptbox}',
    version: '2.6.1',
    jwtIssuer: 'issuer',
    jwtSecret: 'secret',
    fetchImpl,
    logger: () => {},
  })

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://addons.mozilla.org/api/v5/addons/addon/chatgptbox/versions/v2.6.1/',
  )
  assert.equal(calls[0].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    compatibility: FIREFOX_COMPATIBILITY,
    release_notes: {
      'en-US': 'https://github.com/josStorer/chatGPTBox/releases/tag/v2.6.1',
    },
  })
})

test('updateFirefoxVersionNotes retries when the AMO version endpoint is not ready yet', async () => {
  const calls = []
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

  await updateFirefoxVersionNotes({
    extensionId: 'chatgptbox',
    version: '2.6.1',
    jwtIssuer: 'issuer',
    jwtSecret: 'secret',
    fetchImpl,
    logger: () => {},
    retryDelayMs: 0,
    maxAttempts: 3,
  })

  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.url.endsWith('/versions/v2.6.1/')))
})
