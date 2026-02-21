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
