import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

// Count storage reads. The patch has to be installed before anything walks the
// storage API, so the config module is imported dynamically below.
let storageReadCount = 0
const originalStorageGet = globalThis.chrome.storage.local.get
globalThis.chrome.storage.local.get = function countedStorageGet(...args) {
  storageReadCount += 1
  return originalStorageGet.apply(this, args)
}

const { defaultConfig, getUserConfig, setUserConfig } = await import(
  '../../../src/config/index.mjs'
)
const shim = globalThis.__TEST_BROWSER_SHIM__

beforeEach(() => {
  // Write a real config key so the storage event invalidates the cache whatever
  // the previous test left behind, then start from empty storage.
  shim.setStorage({ modelName: 'reset-between-tests' })
  shim.clearStorage()
  storageReadCount = 0
})

// Reading fresh storage performs one-time migration writes, and those writes
// invalidate the read that made them, so the first read never reaches the cache.
// Tests that count storage reads read until the count stops growing, so they
// measure the cache and not however many reads the migration happens to need.
const warmUpCache = async () => {
  let previousCount = -1
  for (let attempt = 0; attempt < 10 && previousCount !== storageReadCount; attempt++) {
    previousCount = storageReadCount
    await getUserConfig()
  }
  storageReadCount = 0
}

test('repeated reads reuse one storage read', async () => {
  await warmUpCache()
  shim.setStorage({ modelName: 'one-read-only' })

  const first = await getUserConfig()
  const second = await getUserConfig()
  const third = await getUserConfig()

  // The first read after a change misses, the two after it hit the cache.
  assert.equal(storageReadCount, 1)
  assert.equal(first.modelName, 'one-read-only')
  assert.deepEqual(second, first)
  assert.deepEqual(third, first)
})

test('concurrent reads share a single storage read', async () => {
  await warmUpCache()
  shim.setStorage({ modelName: 'concurrent' })

  const configs = await Promise.all([getUserConfig(), getUserConfig(), getUserConfig()])

  // The cache is cold here, so the three calls have to share one read.
  assert.equal(storageReadCount, 1)
  assert.equal(configs[0].modelName, 'concurrent')
  assert.deepEqual(configs[1], configs[0])
  assert.deepEqual(configs[2], configs[0])
})

test('each caller gets an independent object', async () => {
  shim.setStorage({
    providerSecrets: { openai: 'sk-test-original' },
    customApiModes: [
      {
        id: 'custom-mode',
        name: 'Custom',
        apiMode: 'customModel',
        active: false,
        customUrl: 'https://example.com/v1/chat/completions',
        customProvider: 'openai',
      },
    ],
  })

  const first = await getUserConfig()
  const second = await getUserConfig()

  first.modelName = 'mutated'
  first.providerSecrets.openai = 'sk-test-mutated'
  first.customApiModes[0].active = true

  assert.notEqual(second.modelName, 'mutated')
  assert.equal(second.providerSecrets.openai, 'sk-test-original')
  assert.equal(second.customApiModes[0].active, false)

  const third = await getUserConfig()
  assert.equal(third.providerSecrets.openai, 'sk-test-original')
  assert.equal(third.customApiModes[0].active, false)
})

test('setUserConfig invalidates the cache', async () => {
  await warmUpCache()
  await setUserConfig({ modelName: 'gpt-4o' })
  const config = await getUserConfig()

  assert.equal(config.modelName, 'gpt-4o')
  assert.equal(storageReadCount, 1)
})

test('a direct storage write invalidates the cache', async () => {
  await warmUpCache()
  shim.setStorage({ modelName: 'gpt-4o-mini' })

  assert.equal((await getUserConfig()).modelName, 'gpt-4o-mini')
  assert.equal(storageReadCount, 1, 'the write must cost a storage read')
})

test('a sessions write does not invalidate the cache', async () => {
  await warmUpCache()
  shim.setStorage({ sessions: [{ conversations: [] }] })

  await getUserConfig()
  assert.equal(storageReadCount, 0)
})

test('a config write does invalidate the cache', async () => {
  // Control for the sessions test above: the counter has to move here.
  await warmUpCache()
  shim.setStorage({ modelName: 'gpt-4o' })

  await getUserConfig()
  assert.equal(storageReadCount, 1)
})

test('a reported config key invalidates the cache even when its value is unchanged', async () => {
  // Stored first, so writing the same value back is a real no-op that only
  // Firefox would report.
  shim.setStorage({ activeSelectionTools: ['translate'] })
  await warmUpCache()

  // Firefox reports the keys of the set call without checking whether the value
  // actually changed, so a config key written next to a conversation history
  // update arrives as a no-op change. Dropping the cache there is a missed
  // optimisation, never a stale read.
  shim.setStorage(
    { sessions: [{ conversations: [] }], activeSelectionTools: ['translate'] },
    { fireUnchangedKeys: true },
  )

  await getUserConfig()
  assert.equal(storageReadCount, 1)
})

test('removing a config key invalidates the cache', async () => {
  await setUserConfig({ modelName: 'gpt-4o' })
  await getUserConfig()
  shim.clearStorage()

  assert.notEqual((await getUserConfig()).modelName, 'gpt-4o')
})

test('a migration is applied once and then cached', async () => {
  shim.setStorage({ claudeApiKey: 'legacy-key' })

  const first = await getUserConfig()
  assert.equal(first.anthropicApiKey, 'legacy-key')
  assert.equal(Object.hasOwn(shim.getStorage(), 'claudeApiKey'), false)

  // The migration write invalidates the read that triggered it, so the next one
  // re-reads the migrated storage and every read after that is served from the
  // cache.
  await getUserConfig()
  await getUserConfig()
  assert.equal(storageReadCount, 2)
  assert.equal((await getUserConfig()).anthropicApiKey, 'legacy-key')
  assert.equal(storageReadCount, 2)
})

test('a change during a read is not cached', async (t) => {
  const patchedGet = globalThis.chrome.storage.local.get
  t.after(() => {
    globalThis.chrome.storage.local.get = patchedGet
  })

  shim.setStorage({ modelName: 'before-read' })
  globalThis.chrome.storage.local.get = function racingGet(...args) {
    const result = patchedGet.apply(this, args)
    // A write that lands while the read is in flight must not leave the
    // pre-write value in the cache.
    shim.setStorage({ modelName: 'during-read' })
    return result
  }

  assert.equal((await getUserConfig()).modelName, 'before-read')
  assert.equal(storageReadCount, 1)
  assert.equal((await getUserConfig()).modelName, 'during-read')
  assert.equal(storageReadCount, 2, 'the value that landed mid-read must not be cached')
})

test('a failed read is not cached', async (t) => {
  const patchedGet = globalThis.chrome.storage.local.get
  t.after(() => {
    globalThis.chrome.storage.local.get = patchedGet
  })

  // The polyfill calls storage through a callback and reports failures with
  // runtime.lastError, so the failure has to be shaped that way.
  globalThis.chrome.storage.local.get = function failingGet(_keys, callback) {
    globalThis.chrome.runtime.lastError = { message: 'storage unavailable' }
    try {
      callback(undefined)
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  }
  await assert.rejects(async () => {
    await getUserConfig()
  }, /storage unavailable/)

  globalThis.chrome.storage.local.get = patchedGet
  const recovered = await getUserConfig()
  assert.equal(recovered.modelName, defaultConfig.modelName)
  // The failing reads replaced the counting wrapper, so only the recovery is
  // counted here.
  assert.equal(storageReadCount, 1, 'the recovery must read storage again')
})

test('a migration that could not be persisted is not cached', async (t) => {
  const patchedSet = globalThis.chrome.storage.local.set
  t.after(() => {
    globalThis.chrome.storage.local.set = patchedSet
  })

  shim.setStorage({ claudeApiKey: 'legacy-key' })

  // A failed write produces no storage event, so nothing else would ever
  // invalidate a cached result built from it.
  globalThis.chrome.storage.local.set = function failingSet(_items, callback) {
    globalThis.chrome.runtime.lastError = { message: 'quota exceeded' }
    try {
      callback?.()
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  }

  const config = await getUserConfig()
  assert.equal(config.anthropicApiKey, 'legacy-key')
  assert.equal(Object.hasOwn(shim.getStorage(), 'claudeApiKey'), true)

  // The next read retries the migration instead of serving a cached copy.
  globalThis.chrome.storage.local.set = patchedSet
  const retried = await getUserConfig()
  assert.equal(retried.anthropicApiKey, 'legacy-key')
  assert.equal(Object.hasOwn(shim.getStorage(), 'claudeApiKey'), false)
})

test('a legacy key removal that fails is retried on the next read', async (t) => {
  // Settle baseline migrations so their events cannot mask a cached failed removal.
  shim.setStorage({ anthropicApiKey: 'new-key' })
  await warmUpCache()
  const writes = t.mock.method(globalThis.chrome.storage.local, 'set')
  const patchedRemove = globalThis.chrome.storage.local.remove
  t.after(() => {
    globalThis.chrome.storage.local.remove = patchedRemove
  })

  // Both keys present: the read has to drop the legacy one, and a failed
  // removal produces no storage event, so the result must not be cached.
  shim.setStorage({ claudeApiKey: 'legacy-key' })

  const removals = []
  globalThis.chrome.storage.local.remove = function failingRemove(keys, callback) {
    removals.push(keys)
    globalThis.chrome.runtime.lastError = { message: 'removal failed' }
    try {
      callback?.()
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  }

  assert.equal((await getUserConfig()).anthropicApiKey, 'new-key')
  assert.deepEqual(removals, ['claudeApiKey'])
  assert.equal(writes.mock.callCount(), 0, 'no other migration may invalidate the failed read')
  assert.equal(Object.hasOwn(shim.getStorage(), 'claudeApiKey'), true)

  // The next read tries the removal again instead of serving a cached copy.
  globalThis.chrome.storage.local.remove = patchedRemove
  await getUserConfig()
  assert.equal(Object.hasOwn(shim.getStorage(), 'claudeApiKey'), false)
})

test('a change in another storage area does not invalidate the cache', async () => {
  await warmUpCache()

  globalThis.chrome.storage.onChanged._trigger(
    { modelName: { oldValue: 'gpt-4o', newValue: 'gpt-4o-mini' } },
    'sync',
  )

  await getUserConfig()
  assert.equal(storageReadCount, 0, 'only the local area holds the user config')
})

test('concurrent callers all see a rejected read and the next one recovers', async (t) => {
  const patchedGet = globalThis.chrome.storage.local.get
  t.after(() => {
    globalThis.chrome.storage.local.get = patchedGet
  })

  await warmUpCache()
  shim.setStorage({ modelName: 'read-that-fails' })
  globalThis.chrome.storage.local.get = function failingGet(_keys, callback) {
    globalThis.chrome.runtime.lastError = { message: 'storage unavailable' }
    try {
      callback(undefined)
    } finally {
      delete globalThis.chrome.runtime.lastError
    }
  }

  const reads = [getUserConfig(), getUserConfig(), getUserConfig()]
  for (const read of reads) {
    await assert.rejects(() => read, /storage unavailable/)
  }

  // The failed read must not be cached, and the rejected promise must not be
  // reused by later callers.
  globalThis.chrome.storage.local.get = patchedGet
  assert.equal((await getUserConfig()).modelName, 'read-that-fails')
})
