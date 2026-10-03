import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createConfigStorageListener } from '../../../src/hooks/config-storage-listener.mjs'

const collectUpdates = () => {
  const updates = []
  return {
    updates,
    setConfig(update) {
      updates.push(update)
    },
  }
}

test('storage changes merge against the latest queued config state', () => {
  const { updates, setConfig } = collectUpdates()
  const listener = createConfigStorageListener(setConfig)

  listener({ themeMode: { oldValue: 'light', newValue: 'dark' } })
  listener({ preferredLanguage: { oldValue: 'en', newValue: 'zh_TW' } })

  assert.equal(updates.length, 2)
  assert.equal(typeof updates[0], 'function')
  assert.equal(typeof updates[1], 'function')

  const config = updates.reduce((currentConfig, update) => update(currentConfig), {
    themeMode: 'light',
    preferredLanguage: 'en',
    modelName: 'chatgptFree35',
  })

  assert.deepEqual(config, {
    themeMode: 'dark',
    preferredLanguage: 'zh_TW',
    modelName: 'chatgptFree35',
  })
})

test('session-only changes remain ignored by default', () => {
  const { updates, setConfig } = collectUpdates()
  const listener = createConfigStorageListener(setConfig)

  listener({ sessions: { oldValue: [], newValue: [{ id: 'session-1' }] } })

  assert.deepEqual(updates, [])
})

test('mixed changes still update config when sessions are ignored', () => {
  const { updates, setConfig } = collectUpdates()
  const listener = createConfigStorageListener(setConfig)

  listener({
    sessions: { oldValue: [], newValue: [{ id: 'session-1' }] },
    themeMode: { oldValue: 'light', newValue: 'dark' },
  })

  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0]({ themeMode: 'light' }), {
    sessions: [{ id: 'session-1' }],
    themeMode: 'dark',
  })
})

test('session-only changes update config when filtering is disabled', () => {
  const { updates, setConfig } = collectUpdates()
  const listener = createConfigStorageListener(setConfig, false)
  const sessions = [{ id: 'session-1' }]

  listener({ sessions: { oldValue: [], newValue: sessions } })

  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0]({ themeMode: 'light' }), {
    themeMode: 'light',
    sessions,
  })
})

test('special storage keys remain own config properties without prototype mutation', () => {
  const { updates, setConfig } = collectUpdates()
  const listener = createConfigStorageListener(setConfig)
  const changes = Object.create(null)
  const specialValue = { source: 'storage' }
  changes.__proto__ = { oldValue: undefined, newValue: specialValue }

  listener(changes)

  assert.equal(updates.length, 1)
  const config = updates[0]({ themeMode: 'light' })
  assert.equal(Object.getPrototypeOf(config), Object.prototype)
  assert.equal(Object.hasOwn(config, '__proto__'), true)
  assert.equal(config.__proto__, specialValue)
  assert.equal({}.source, undefined)
})
