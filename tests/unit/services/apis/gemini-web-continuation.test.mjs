import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGeminiContinuationGuard } from '../../../../src/services/apis/gemini-web-continuation.mjs'

function storageFixture() {
  const entries = {}
  return {
    entries,
    storage: {
      async get(key) {
        return { [key]: entries[key] }
      },
      async set(values) {
        Object.assign(entries, values)
      },
      async remove(key) {
        delete entries[key]
      },
    },
  }
}

const turn = (n) => ({ c: 'c_test', r: 'r_' + n, rc: 'rc_' + n, turnIndex: n })
const createGuard = (storage) => createGeminiContinuationGuard(storage, async (value) => value)

test('a pending remote turn blocks another card and survives background restart', async () => {
  const { storage } = storageFixture()
  const guard = createGuard(storage)
  const reservation = await guard.begin(turn(1), turn(1))
  await assert.rejects(guard.begin(turn(1), turn(1)), /previous Gemini request/)
  await assert.rejects(createGuard(storage).begin(turn(1), turn(1)), /previous Gemini request/)
  await reservation.release({ safe: false })
  await assert.rejects(createGuard(storage).begin(turn(1), turn(1)), /previous Gemini request/)
})

test('pre-submit cancellation restores the previous valid continuation', async () => {
  const { storage, entries } = storageFixture()
  const guard = createGuard(storage)
  const reservation = await guard.begin(turn(1), turn(1))
  await reservation.release({ safe: true })
  assert.deepEqual(entries, {})
  const next = await guard.begin(turn(1), turn(1))
  await next.complete(turn(2))
  await next.release({ safe: false })
  const cancelled = await guard.begin(turn(2), turn(2))
  await cancelled.release({ safe: true })
  const retry = await guard.begin(turn(2), turn(1))
  await retry.release({ safe: true })
})

test('a completed turn blocks stale saved sessions but permits a valid pre-turn Retry', async () => {
  const { storage } = storageFixture()
  const guard = createGuard(storage)
  const reservation = await guard.begin(turn(1), turn(1))
  await reservation.complete(turn(2))
  await reservation.release({ safe: false })
  const reopened = createGuard(storage)
  await assert.rejects(reopened.begin(turn(1), turn(1)), /previous Gemini request/)
  const retry = await reopened.begin(turn(2), turn(1))
  await retry.complete({ ...turn(2), r: 'r_retry', rc: 'rc_retry' })
  await retry.release({ safe: false })
  await assert.rejects(reopened.begin(turn(2), turn(2)), /previous Gemini request/)
})

test('failed persistence prevents reservation and a failed commit remains fail-closed', async () => {
  const { storage } = storageFixture()
  const guard = createGuard(storage)
  const write = storage.set
  storage.set = async () => {
    throw new Error('storage unavailable')
  }
  await assert.rejects(guard.begin(turn(1), turn(1)), /storage unavailable/)
  storage.set = write
  const reservation = await guard.begin(turn(1), turn(1))
  storage.set = async () => {
    throw new Error('storage unavailable')
  }
  await assert.rejects(reservation.complete(turn(2)), /storage unavailable/)
  await reservation.release({ safe: false })
  storage.set = write
  await assert.rejects(createGuard(storage).begin(turn(1), turn(1)), /previous Gemini request/)
})

test('a failed safe rollback can recover after storage returns', async () => {
  for (const hasPrevious of [false, true]) {
    const { storage } = storageFixture()
    const guard = createGuard(storage)
    if (hasPrevious) {
      const initial = await guard.begin(turn(1), turn(1))
      await initial.complete(turn(2))
      await initial.release({ safe: false })
    }
    const saved = turn(hasPrevious ? 2 : 1)
    const reservation = await guard.begin(saved, saved)
    const write = storage.set
    const remove = storage.remove
    storage.set = storage.remove = async () => {
      throw new Error('storage unavailable')
    }
    await assert.rejects(reservation.release({ safe: true }), /storage unavailable/)
    storage.set = write
    storage.remove = remove

    await assert.rejects(createGuard(storage).begin(saved, saved), /previous Gemini request/)
    const recovered = await guard.begin(saved, saved)
    await recovered.release({ safe: true })
  }
})
