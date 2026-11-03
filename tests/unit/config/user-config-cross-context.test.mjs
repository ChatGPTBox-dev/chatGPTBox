import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  clearOldAccessToken,
  getUserConfig as getReaderConfig,
} from '../../../src/config/index.mjs'

const shim = globalThis.__TEST_BROWSER_SHIM__

// Extension contexts each evaluate their own copy of the config module but share
// one storage area, and the storage-change event that tells one context about a
// write in another arrives asynchronously. A second copy of the module stands in
// for the second context, so a test can hold the event back and read in the window
// where the two disagree.
let setWriterConfig
let getWriterConfig
let writerGeneration = 0
const loadWriterContext = async () => {
  writerGeneration += 1
  const writer = await import(`../../../src/config/index.mjs?cross-context=${writerGeneration}`)
  setWriterConfig = writer.setUserConfig
  getWriterConfig = writer.getUserConfig
}

beforeEach(async () => {
  // Reset stored migrations as well as the model so each test starts independently.
  shim.flushStorageEvents()
  shim.replaceStorage({ modelName: 'before-each' })
  await loadWriterContext()
  // Reading fresh storage performs migration writes, and those writes invalidate
  // the read that made them, so the first read never reaches the cache. Read until
  // the storage events stop arriving rather than assuming one read is enough.
  for (let attempt = 0; attempt < 10; attempt++) {
    shim.deferStorageEvents()
    await getReaderConfig()
    if (shim.pendingStorageEvents() === 0) break
    shim.flushStorageEvents()
  }
  shim.deferStorageEvents(false)
})

afterEach(() => {
  shim.flushStorageEvents()
})

test('the cached read serves the old config until the event arrives', async () => {
  await getReaderConfig()

  // Another context writes, and its event is held back.
  shim.deferStorageEvents()
  await setWriterConfig({ modelName: 'written-in-the-other-context' })
  assert.equal(shim.getStorage().modelName, 'written-in-the-other-context', 'the write completed')

  const stale = await getReaderConfig()
  assert.equal(
    stale.modelName,
    'before-each',
    'this is the window the cache cannot see, and the reason fresh exists',
  )

  shim.flushStorageEvents()
  assert.equal((await getReaderConfig()).modelName, 'written-in-the-other-context')
})

test('a fresh read observes a completed cross-context write before its event', async (t) => {
  await getReaderConfig()

  shim.deferStorageEvents()
  await setWriterConfig({ modelName: 'written-in-the-other-context' })

  let storageReads = 0
  const originalGet = globalThis.chrome.storage.local.get
  t.mock.method(globalThis.chrome.storage.local, 'get', function (...args) {
    storageReads += 1
    return originalGet.apply(this, args)
  })

  // This is what the selection toolbar and the context menu do: they start a
  // session on the user's gesture, so they cannot wait for the event.
  const fresh = await getReaderConfig({ fresh: true })
  assert.equal(fresh.modelName, 'written-in-the-other-context')
  assert.equal(storageReads, 1)

  // Check the hit before delivering the event, which invalidates the fresh cache.
  assert.equal((await getReaderConfig()).modelName, 'written-in-the-other-context')
  assert.equal(storageReads, 1, 'the fresh read must populate the cache')

  shim.flushStorageEvents()
  assert.equal((await getReaderConfig()).modelName, 'written-in-the-other-context')
  assert.equal(storageReads, 2, 'the delivered event must invalidate the cache')
})

test('an older read completing last cannot replace a fresh cached config', async (t) => {
  shim.setStorage({ modelName: 'older-read' })

  const callbacks = []
  const originalGet = globalThis.chrome.storage.local.get
  t.mock.method(globalThis.chrome.storage.local, 'get', function (keys, callback) {
    return originalGet.call(this, keys, (result) => {
      callbacks.push(() => callback(result))
    })
  })
  t.after(() => {
    for (const callback of callbacks.splice(0)) callback()
  })

  const older = getReaderConfig()
  await setImmediate()

  // Hold the change event so both reads have the same invalidation generation.
  shim.deferStorageEvents()
  await setWriterConfig({ modelName: 'newer-read' })
  const fresh = getReaderConfig({ fresh: true })
  await setImmediate()
  assert.equal(callbacks.length, 2, 'the fresh read must not join the older read')

  callbacks.splice(1, 1)[0]()
  assert.equal((await fresh).modelName, 'newer-read')
  callbacks.shift()()
  assert.equal((await older).modelName, 'older-read')

  assert.equal((await getReaderConfig()).modelName, 'newer-read')
  assert.equal(callbacks.length, 0, 'the cached result must not start another read')
})

test('an unpersisted fresh migration retires the previous cache', async (t) => {
  shim.deferStorageEvents()
  await setWriterConfig({ modelName: 'newer-config', claudeApiKey: 'TEST_LEGACY_SECRET' })
  t.mock.method(globalThis.chrome.storage.local, 'set', (_items, callback) => {
    globalThis.chrome.runtime.lastError = { message: 'quota exceeded' }
    try {
      callback()
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  })
  const reads = t.mock.method(globalThis.chrome.storage.local, 'get')

  assert.equal((await getReaderConfig({ fresh: true })).modelName, 'newer-config')
  assert.equal((await getReaderConfig()).modelName, 'newer-config')
  assert.equal(reads.mock.callCount(), 2, 'the ordinary read must retry the failed migration')
})

test('an unpersisted fresh migration prevents an older read repopulating the cache', async (t) => {
  shim.setStorage({ modelName: 'older-read' })
  const callbacks = []
  const originalGet = globalThis.chrome.storage.local.get
  t.mock.method(globalThis.chrome.storage.local, 'get', function (keys, callback) {
    return originalGet.call(this, keys, (result) => callbacks.push(() => callback(result)))
  })
  t.after(() => {
    for (const callback of callbacks.splice(0)) callback()
  })
  const older = getReaderConfig()
  await setImmediate()
  shim.deferStorageEvents()
  await setWriterConfig({ modelName: 'newer-read', claudeApiKey: 'TEST_LEGACY_SECRET' })
  t.mock.method(globalThis.chrome.storage.local, 'set', (_items, callback) => {
    globalThis.chrome.runtime.lastError = { message: 'quota exceeded' }
    try {
      callback()
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  })

  const fresh = getReaderConfig({ fresh: true })
  await setImmediate()
  callbacks.splice(1, 1)[0]()
  assert.equal((await fresh).modelName, 'newer-read')

  const retry = getReaderConfig()
  await setImmediate()
  assert.equal(callbacks.length, 2, 'retry must not reuse the older pending read')
  callbacks.shift()()
  assert.equal((await older).modelName, 'older-read')
  const concurrentRetry = getReaderConfig()
  await setImmediate()
  assert.equal(callbacks.length, 1, 'the older completion must not clear the shared retry')
  callbacks.shift()()
  assert.equal((await retry).modelName, 'newer-read')
  assert.equal((await concurrentRetry).modelName, 'newer-read')
})

test('the writer context is unaffected by holding events back', async () => {
  shim.deferStorageEvents()
  await setWriterConfig({ modelName: 'written-here' })

  // setUserConfig invalidates its own context directly, because the event can
  // arrive after the write resolves.
  assert.equal((await getWriterConfig()).modelName, 'written-here')
  shim.flushStorageEvents()
})

test('token cleanup observes a refreshed token before its storage event', async () => {
  shim.setStorage({ accessToken: 'TEST_EXPIRED_TOKEN', tokenSavedOn: 0 })
  await getReaderConfig()

  shim.deferStorageEvents()
  await setWriterConfig({ accessToken: 'TEST_CURRENT_TOKEN', tokenSavedOn: Date.now() })
  await clearOldAccessToken()

  assert.equal(shim.getStorage().accessToken, 'TEST_CURRENT_TOKEN')
})

// userLanguage and the default it feeds are derived from the browser locale rather
// than stored, so a locale change has to invalidate the cache the way a write does.
// Before the cache existed every read re-derived it, so a context that stayed alive
// across a change used to pick the new language and now would not.
test('a browser locale change re-derives the language', async () => {
  const setNavigatorLanguage = (language) => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language, userAgent: 'Mozilla/5.0 (test)' },
      configurable: true,
    })
  }

  shim.setStorage({ userLanguage: 'en-US' })
  shim.flushStorageEvents()
  setNavigatorLanguage('en-US')
  await getReaderConfig()

  const before = await getReaderConfig()
  assert.equal(before.userLanguage, 'en', 'derived from the locale at read time')

  // The browser switches to Traditional Chinese while this context stays alive.
  setNavigatorLanguage('zh-TW')
  shim.dispatchGlobalEvent('languagechange')

  const after = await getReaderConfig()
  assert.equal(after.userLanguage, 'zh-Hant', 'the new locale is picked up')
})
