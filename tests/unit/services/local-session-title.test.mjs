import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  claimSessionTitleGeneration,
  completeSessionTitleGeneration,
  deleteSession,
  failSessionTitleGeneration,
  getSession,
  isSessionTitleGenerationStale,
  updateSession,
} from '../../../src/services/local-session.mjs'
import { initSession } from '../../../src/services/init-session.mjs'

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('newer generated title state survives a stale conversation write', async () => {
  const stored = initSession({
    sessionName: 'Generated title',
    sessionNameSource: 'generated',
    sessionTitleGenerationStatus: 'succeeded',
    sessionTitleGenerationAttempts: 1,
  })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [stored] })

  const stale = {
    ...stored,
    sessionName: null,
    sessionNameSource: null,
    sessionTitleGenerationStatus: 'idle',
    sessionTitleGenerationAttempts: 0,
    conversationRecords: [{ question: 'Next', answer: 'Answer' }],
  }
  const sessions = await updateSession(stale)
  assert.equal(sessions[0].sessionName, 'Generated title')
  assert.equal(sessions[0].sessionNameSource, 'generated')
  assert.deepEqual(sessions[0].conversationRecords, stale.conversationRecords)
})

test('concurrent conversation and title writes preserve both changes', async () => {
  const session = initSession()
  session.conversationRecords = [{ question: 'First', answer: 'First answer' }]
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })

  const claim = await claimSessionTitleGeneration(session.sessionId)
  const conversationUpdate = {
    ...session,
    conversationRecords: [
      ...session.conversationRecords,
      { question: 'Second', answer: 'Second answer' },
    ],
  }

  await Promise.all([
    updateSession(conversationUpdate),
    completeSessionTitleGeneration(
      session.sessionId,
      'Generated title',
      claim.session.sessionTitleGenerationId,
    ),
  ])

  const stored = (await getSession(session.sessionId)).session
  assert.equal(stored.sessionName, 'Generated title')
  assert.deepEqual(stored.conversationRecords, conversationUpdate.conversationRecords)
})

test('does not resurrect a session deleted while an answer is finishing', async () => {
  const existing = initSession({ sessionName: 'Existing' })
  const deleted = initSession({ sessionName: 'Deleted' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [existing] })
  const sessions = await updateSession(deleted)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, existing.sessionId)
})

test('delete of an already missing session is a no-op', async () => {
  const existing = initSession({ sessionName: 'Existing' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [existing] })
  const sessions = await deleteSession('missing')
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, existing.sessionId)
})

test('only one fresh title-generation claim is granted', async () => {
  const session = initSession()
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })
  const first = await claimSessionTitleGeneration(session.sessionId)
  const second = await claimSessionTitleGeneration(session.sessionId)
  assert.equal(first.claimed, true)
  assert.ok(first.session.sessionTitleGenerationId)
  assert.equal(first.session.sessionTitleGenerationAttempts, 1)
  assert.equal(second.claimed, false)
})

test('stale or malformed pending claims can be recovered', async () => {
  const malformed = initSession({
    sessionTitleGenerationStatus: 'pending',
    sessionTitleGenerationStartedAt: null,
    sessionTitleGenerationId: 'old',
    sessionTitleGenerationAttempts: 1,
  })
  assert.equal(isSessionTitleGenerationStale(malformed), true)

  malformed.sessionTitleGenerationStartedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString()
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [malformed] })
  const claim = await claimSessionTitleGeneration(malformed.sessionId)
  assert.equal(claim.claimed, true)
  assert.equal(claim.session.sessionTitleGenerationAttempts, 2)
  assert.notEqual(claim.session.sessionTitleGenerationId, 'old')
})

test('completion stores the title and rejects stale generation IDs', async () => {
  const session = initSession()
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })
  const claim = await claimSessionTitleGeneration(session.sessionId)

  const stale = await completeSessionTitleGeneration(session.sessionId, 'Wrong', 'stale-id')
  assert.equal(stale.updated, false)

  const completed = await completeSessionTitleGeneration(
    session.sessionId,
    'Correct title',
    claim.session.sessionTitleGenerationId,
  )
  assert.equal(completed.updated, true)
  assert.equal(completed.session.sessionName, 'Correct title')
  assert.equal(completed.session.sessionNameSource, 'generated')
  assert.equal(completed.session.sessionTitleGenerationStatus, 'succeeded')
})

test('existing manual or legacy titles are never overwritten', async () => {
  const session = initSession({ sessionName: 'Keep this', sessionNameSource: 'manual' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })
  const claim = await claimSessionTitleGeneration(session.sessionId)
  assert.equal(claim.claimed, false)
})

test('failure is persisted without blocking the conversation', async () => {
  const session = initSession()
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })
  const claim = await claimSessionTitleGeneration(session.sessionId)
  const failed = await failSessionTitleGeneration(
    session.sessionId,
    claim.session.sessionTitleGenerationId,
  )
  assert.equal(failed.updated, true)
  assert.equal(failed.session.sessionTitleGenerationStatus, 'failed')
  assert.equal(failed.session.sessionTitleGenerationId, null)
})
