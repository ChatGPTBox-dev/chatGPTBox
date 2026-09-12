import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  claimSessionTitleGeneration,
  createSession,
  updateSession,
} from '../../../src/services/local-session.mjs'
import { initSession } from '../../../src/services/init-session.mjs'

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('explicit title edits remain authoritative for existing sessions', async () => {
  const original = initSession({ sessionName: 'Original' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })

  const renamed = { ...original, sessionName: 'Renamed' }
  const upserted = await createSession(renamed)
  assert.equal(upserted.session.sessionName, 'Renamed')
  assert.equal(upserted.session.sessionNameSource, 'manual')

  const editedAgain = { ...upserted.session, sessionName: 'Renamed again' }
  const sessions = await updateSession(editedAgain)
  assert.equal(sessions[0].sessionName, 'Renamed again')
  assert.equal(sessions[0].sessionNameSource, 'manual')
})

test('manual title clears remain authoritative', async () => {
  for (const clearedName of ['', null]) {
    const original = initSession({
      sessionName: 'Generated title',
      sessionNameSource: 'generated',
      sessionTitleGenerationStatus: 'succeeded',
      sessionTitleGenerationAttempts: 1,
    })
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })

    const cleared = {
      ...original,
      sessionName: clearedName,
      sessionNameSource: 'manual',
    }
    const sessions = await updateSession(cleared)
    assert.equal(sessions[0].sessionName, clearedName)
    assert.equal(sessions[0].sessionNameSource, 'manual')
    assert.equal((await claimSessionTitleGeneration(original.sessionId)).claimed, false)
  }
})

test('title claims reject a cleared or replaced conversation lifecycle', async () => {
  const original = initSession()
  original.conversationRecords = [{ question: 'Old question', answer: 'Old answer' }]
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })

  const expectedTranscript = {
    lifecycleId: original.sessionLifecycleId,
    createdAt: original.createdAt,
    question: 'Old question',
    answer: 'Old answer',
  }
  const cleared = initSession({
    ...original,
    conversationRecords: [],
  })
  cleared.sessionId = original.sessionId
  cleared.createdAt = original.createdAt
  await updateSession(cleared)

  const claim = await claimSessionTitleGeneration(original.sessionId, expectedTranscript)
  assert.equal(claim.claimed, false)
  assert.equal(claim.updated, false)
  assert.equal(claim.session.sessionTitleGenerationStatus, 'idle')
  assert.equal(claim.session.conversationRecords.length, 0)
  assert.notEqual(claim.session.sessionLifecycleId, original.sessionLifecycleId)
})

test('invalid persisted attempt counts never grant additional title requests', async () => {
  for (const invalidAttempts of [-1, 0.5]) {
    const session = initSession({
      sessionTitleGenerationStatus: 'failed',
      sessionTitleGenerationAttempts: invalidAttempts,
    })
    globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })

    const first = await claimSessionTitleGeneration(session.sessionId)
    const second = await claimSessionTitleGeneration(session.sessionId)

    assert.equal(first.claimed, true)
    assert.equal(first.session.sessionTitleGenerationAttempts, 1)
    assert.equal(second.claimed, false)
  }
})
