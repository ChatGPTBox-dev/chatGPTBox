import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildConfigRollbackPatch,
  mergeConfigUpdate,
  queueConfigWrite,
} from '../../../src/popup/popup-config-utils.mjs'

test('mergeConfigUpdate applies a partial config payload on top of the current config', () => {
  const currentConfig = {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'myproxy' },
    providerSecrets: { myproxy: 'old-key' },
    themeMode: 'light',
  }

  const result = mergeConfigUpdate(currentConfig, {
    providerSecrets: { myproxy: 'new-key' },
  })

  assert.deepEqual(result, {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'myproxy' },
    providerSecrets: { myproxy: 'new-key' },
    themeMode: 'light',
  })
})

test('mergeConfigUpdate does not mutate the previous config object', () => {
  const currentConfig = {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'myproxy' },
    providerSecrets: { myproxy: 'old-key' },
    themeMode: 'light',
  }
  const optimistic = mergeConfigUpdate(currentConfig, {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'selected-mode-2' },
    providerSecrets: { 'selected-mode-2': 'override-key' },
  })

  assert.deepEqual(optimistic, {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'selected-mode-2' },
    providerSecrets: { 'selected-mode-2': 'override-key' },
    themeMode: 'light',
  })
  assert.deepEqual(currentConfig, {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'myproxy' },
    providerSecrets: { myproxy: 'old-key' },
    themeMode: 'light',
  })
})

test('buildConfigRollbackPatch captures only the keys still owned by the failed request', () => {
  const persistedConfig = {
    apiMode: { groupName: 'customApiModelKeys', providerId: 'myproxy' },
    providerSecrets: { myproxy: 'old-key' },
    themeMode: 'light',
  }

  const rollbackPatch = buildConfigRollbackPatch(
    persistedConfig,
    {
      providerSecrets: { 'selected-mode-2': 'override-key' },
      themeMode: 'dark',
    },
    {
      providerSecrets: 1,
      themeMode: 2,
    },
    1,
  )

  assert.deepEqual(rollbackPatch, {
    providerSecrets: { myproxy: 'old-key' },
  })
})

test('queueConfigWrite runs writes in call order', async () => {
  const events = []
  let resolveFirstWrite
  const firstWriteDone = new Promise((resolve) => {
    resolveFirstWrite = resolve
  })

  const firstWrite = queueConfigWrite(Promise.resolve(), async () => {
    events.push('start-first')
    await firstWriteDone
    events.push('end-first')
  })
  const secondWrite = queueConfigWrite(firstWrite.nextQueue, async () => {
    events.push('start-second')
    events.push('end-second')
  })

  await Promise.resolve()
  assert.deepEqual(events, ['start-first'])

  resolveFirstWrite()
  await secondWrite.writePromise

  assert.deepEqual(events, ['start-first', 'end-first', 'start-second', 'end-second'])
})

test('queueConfigWrite keeps later writes running after an earlier failure', async () => {
  const events = []
  const firstWrite = queueConfigWrite(Promise.resolve(), async () => {
    events.push('start-first')
    throw new Error('write failed')
  })
  const secondWrite = queueConfigWrite(firstWrite.nextQueue, async () => {
    events.push('start-second')
    events.push('end-second')
  })

  await assert.rejects(firstWrite.writePromise, /write failed/)
  await secondWrite.writePromise

  assert.deepEqual(events, ['start-first', 'start-second', 'end-second'])
})

test('queueConfigWrite waits for the initial config load gate before running writes', async () => {
  const events = []
  let releaseInitialLoad
  const initialLoadGate = new Promise((resolve) => {
    releaseInitialLoad = resolve
  })
  const firstWrite = queueConfigWrite(initialLoadGate, async () => {
    events.push('write')
  })

  await Promise.resolve()
  assert.deepEqual(events, [])

  releaseInitialLoad()
  await firstWrite.writePromise

  assert.deepEqual(events, ['write'])
})

test('per-key rollback restores persisted values while preserving newer non-overlapping updates', () => {
  const state0 = {
    foo: 0,
    bar: 0,
    baz: 0,
  }
  const rollbackPatchA = buildConfigRollbackPatch(state0, { foo: 1 }, { foo: 1, bar: 2 }, 1)
  const optimisticA = mergeConfigUpdate(state0, { foo: 1 })
  const optimisticB = mergeConfigUpdate(optimisticA, { bar: 2 })
  const afterRollbackA = mergeConfigUpdate(optimisticB, rollbackPatchA)

  assert.deepEqual(afterRollbackA, {
    foo: 0,
    bar: 2,
    baz: 0,
  })
})

test('per-key rollback skips same-key rollback when a newer request owns the key', () => {
  const persistedConfig = {
    foo: 0,
    bar: 0,
    baz: 0,
  }
  const rollbackPatchA = buildConfigRollbackPatch(
    persistedConfig,
    { foo: 1, bar: 1 },
    { foo: 1, bar: 2, baz: 2 },
    1,
  )

  assert.deepEqual(rollbackPatchA, {
    foo: 0,
  })
})

test('serialized writes let same-key rollback restore the previous persisted optimistic value', () => {
  const persistedConfig = {
    foo: 0,
  }
  const persistedAfterFirstWrite = mergeConfigUpdate(persistedConfig, { foo: 1 })
  const rollbackPatchA = buildConfigRollbackPatch(
    persistedAfterFirstWrite,
    { foo: 2 },
    { foo: 2 },
    2,
  )
  const afterRollback = mergeConfigUpdate({ foo: 2 }, rollbackPatchA)

  assert.deepEqual(afterRollback, {
    foo: 1,
  })
})
