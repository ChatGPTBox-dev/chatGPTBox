import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

const waitForCallback = async (register) => {
  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Expected callback to be called'))
    }, 100)

    register(() => {
      clearTimeout(timeoutId)
      resolve()
    })
  })
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('storage.local.get returns a promise when callback is omitted', async () => {
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ requested: 'stored-value' })

  const result = globalThis.chrome.storage.local.get('requested')

  assert.equal(typeof result.then, 'function')
  assert.deepEqual(await result.then((value) => value), { requested: 'stored-value' })
})

test('storage.local.get with object keys returns only requested keys and uses defaults', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    requested: 'stored-value',
    unrelated: 'should-not-be-returned',
  })

  const result = await globalThis.chrome.storage.local.get({
    requested: 'default-value',
    missing: 'default-missing',
  })

  assert.deepEqual(result, {
    requested: 'stored-value',
    missing: 'default-missing',
  })
  assert.equal('unrelated' in result, false)
})

test('storage.local.get with object defaults uses default for prototype-chain key names', async () => {
  const result = await globalThis.chrome.storage.local.get({
    toString: 'default-toString',
    constructor: 'default-constructor',
  })

  assert.deepEqual(result, {
    toString: 'default-toString',
    constructor: 'default-constructor',
  })
})

test('storage.local.get string key does not read prototype-chain properties', async () => {
  const result = await globalThis.chrome.storage.local.get('toString')

  assert.deepEqual(result, {})
})

test('storage.local.get array keys does not read prototype-chain properties', async () => {
  const result = await globalThis.chrome.storage.local.get(['toString', 'constructor'])

  assert.deepEqual(result, {})
})

test('storage.local.get prefers stored own property over object default', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    toString: 'stored-toString',
  })

  const result = await globalThis.chrome.storage.local.get({
    toString: 'default-toString',
  })

  assert.deepEqual(result, {
    toString: 'stored-toString',
  })
})

test('storage.local.get(null) returns all stored keys', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    alpha: 1,
    beta: 2,
  })

  const result = await globalThis.chrome.storage.local.get(null)

  assert.deepEqual(result, {
    alpha: 1,
    beta: 2,
  })
})

test('storage.local.get(undefined) returns all stored keys', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    alpha: 1,
    beta: 2,
  })

  const result = await globalThis.chrome.storage.local.get(undefined)

  assert.deepEqual(result, {
    alpha: 1,
    beta: 2,
  })
})

test('storage.local.get(null) keeps stored prototype-like key as data', async () => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    toString: 'stored-toString',
  })

  const result = await globalThis.chrome.storage.local.get(null)

  assert.deepEqual(result, {
    toString: 'stored-toString',
  })
})

test('tabs.sendMessage supports callback as third argument (without options)', async () => {
  await waitForCallback((done) => {
    globalThis.chrome.tabs.sendMessage(1, { type: 'PING' }, done)
  })
})

test('tabs.sendMessage supports callback as fourth argument (with options)', async () => {
  await waitForCallback((done) => {
    globalThis.chrome.tabs.sendMessage(1, { type: 'PING' }, { frameId: 0 }, done)
  })
})

test('runtime.sendMessage supports callback as second argument (without options)', async () => {
  await waitForCallback((done) => {
    globalThis.chrome.runtime.sendMessage({ type: 'PING' }, done)
  })
})

test('runtime.sendMessage supports callback as third argument (with options)', async () => {
  await waitForCallback((done) => {
    globalThis.chrome.runtime.sendMessage({ type: 'PING' }, { includeTlsChannelId: false }, done)
  })
})

test('tabs.sendMessage returns a resolved promise when callback is omitted', async () => {
  const result = await globalThis.chrome.tabs.sendMessage(1, { type: 'PING' })

  assert.equal(result, undefined)
})

test('runtime.sendMessage returns a resolved promise when callback is omitted', async () => {
  const result = await globalThis.chrome.runtime.sendMessage({ type: 'PING' })

  assert.equal(result, undefined)
})

const recordStorageChanges = () => {
  const areaChanges = []
  const globalChanges = []
  const onAreaChanged = (changes) => areaChanges.push(changes)
  const onGlobalChanged = (changes, areaName) => globalChanges.push([changes, areaName])
  globalThis.chrome.storage.local.onChanged.addListener(onAreaChanged)
  globalThis.chrome.storage.onChanged.addListener(onGlobalChanged)
  return {
    areaChanges,
    globalChanges,
    stop() {
      globalThis.chrome.storage.local.onChanged.removeListener(onAreaChanged)
      globalThis.chrome.storage.onChanged.removeListener(onGlobalChanged)
    },
  }
}

test('storage events report changed keys on both storage events', () => {
  const shim = globalThis.__TEST_BROWSER_SHIM__
  shim.setStorage({ alpha: 1 })
  const recorded = recordStorageChanges()

  shim.setStorage({ alpha: 2, beta: { nested: true } })

  recorded.stop()
  assert.deepEqual(recorded.areaChanges, [
    {
      alpha: { oldValue: 1, newValue: 2 },
      beta: { oldValue: undefined, newValue: { nested: true } },
    },
  ])
  assert.deepEqual(recorded.globalChanges, [[recorded.areaChanges[0], 'local']])
})

test('storage events skip keys whose value did not change', () => {
  const shim = globalThis.__TEST_BROWSER_SHIM__
  shim.setStorage({ alpha: 1, beta: [1, 2] })
  const recorded = recordStorageChanges()

  // Chromium compares by value, so a new object with identical content is not a
  // change and no event is reported for it.
  shim.setStorage({ alpha: 1, beta: [1, 2] })
  globalThis.chrome.storage.local.remove('missing-key')

  recorded.stop()
  assert.deepEqual(recorded.areaChanges, [])
})

test('storage events report keys added and removed with undefined values', () => {
  const shim = globalThis.__TEST_BROWSER_SHIM__
  shim.setStorage({ present: undefined })
  const recorded = recordStorageChanges()

  globalThis.chrome.storage.local.remove('present')

  recorded.stop()
  assert.deepEqual(recorded.areaChanges, [
    { present: { oldValue: undefined, newValue: undefined } },
  ])
})

test('fireUnchangedKeys reports only the written keys, like Firefox', () => {
  const shim = globalThis.__TEST_BROWSER_SHIM__
  shim.setStorage({ untouched: 'stored', rewritten: 'before' })
  const recorded = recordStorageChanges()

  shim.setStorage({ rewritten: 'before', added: 'new' }, { fireUnchangedKeys: true })

  recorded.stop()
  assert.deepEqual(Object.keys(recorded.areaChanges[0]).sort(), ['added', 'rewritten'])
})

test('disabling storage-event deferral preserves pending notifications', (t) => {
  const shim = globalThis.__TEST_BROWSER_SHIM__
  const recorded = recordStorageChanges()
  t.after(() => {
    shim.flushStorageEvents()
    recorded.stop()
  })
  shim.deferStorageEvents()
  shim.setStorage({ deferred: 'stored' })
  shim.deferStorageEvents(false)

  assert.equal(shim.pendingStorageEvents(), 1)
  assert.equal(recorded.areaChanges.length, 0)
  assert.equal(shim.flushStorageEvents(), 1)
  assert.equal(recorded.areaChanges[0].deferred.newValue, 'stored')
})
