import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  claimSessionTitleGeneration,
  completeSessionTitleGeneration,
  createSession,
  deleteSession,
  failSessionTitleGeneration,
  getSession,
  getSessions,
  getSessionTitleGenerationStaleDelay,
  isSessionTitleGenerationStale,
  MAX_SESSION_TITLE_GENERATION_ATTEMPTS,
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

test('newer generated title state survives a stale managed writer', async () => {
  const stored = initSession({
    sessionName: 'Generated title',
    sessionNameSource: 'generated',
    sessionTitleGenerationStatus: 'succeeded',
    sessionTitleGenerationAttempts: 1,
  })
  stored.conversationRecords = [{ question: 'First', answer: 'First answer' }]
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [stored] })

  const stalePending = {
    ...stored,
    sessionName: null,
    sessionNameSource: null,
    sessionTitleGenerationStatus: 'pending',
    sessionTitleGenerationStartedAt: '2026-01-01T00:00:00.000Z',
    sessionTitleGenerationId: 'stale-generation',
    conversationRecords: [
      ...stored.conversationRecords,
      { question: 'Second', answer: 'Second answer' },
    ],
  }

  const sessions = await updateSession(stalePending)
  assert.equal(sessions[0].sessionName, 'Generated title')
  assert.equal(sessions[0].sessionNameSource, 'generated')
  assert.equal(sessions[0].sessionTitleGenerationStatus, 'succeeded')
  assert.equal(sessions[0].sessionTitleGenerationId, null)
  assert.deepEqual(sessions[0].conversationRecords, stalePending.conversationRecords)
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

test('fresh-profile initialization is serialized across callers', async () => {
  const [first, second, third] = await Promise.all([getSessions(), getSessions(), getSessions()])
  assert.equal(first.length, 1)
  assert.equal(second[0].sessionId, first[0].sessionId)
  assert.equal(third[0].sessionId, first[0].sessionId)
})

test('archived conversation copies become untitled and eligible for generation', async () => {
  const originalTimestamp = '2020-01-02T03:04:05.000Z'
  const archived = initSession({ sessionName: new Date().toLocaleString() })
  const originalLifecycleId = archived.sessionLifecycleId
  archived.createdAt = originalTimestamp
  archived.updatedAt = originalTimestamp
  archived.conversationRecords = [{ question: 'Question', answer: 'Answer' }]
  const beforeArchive = Date.now()

  const { session } = await createSession(archived)
  assert.equal(session.sessionName, null)
  assert.equal(session.sessionNameSource, null)
  assert.equal(session.sessionTitleGenerationStatus, 'idle')
  assert.equal(session.sessionTitleGenerationAttempts, 0)
  assert.notEqual(session.sessionLifecycleId, originalLifecycleId)
  assert.notEqual(session.createdAt, originalTimestamp)
  assert.notEqual(session.updatedAt, originalTimestamp)
  assert.ok(Date.parse(session.createdAt) >= beforeArchive)
  assert.ok(Date.parse(session.updatedAt) >= beforeArchive)
})

test('clearing a conversation resets its semantic title for the replacement lifecycle', async () => {
  const stored = initSession({
    sessionName: 'Old semantic title',
    sessionNameSource: 'generated',
    sessionTitleGenerationStatus: 'succeeded',
    sessionTitleGenerationAttempts: 1,
  })
  stored.conversationRecords = [{ question: 'Old topic', answer: 'Old answer' }]
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [stored] })

  const replacement = initSession({
    ...stored,
    question: 'New topic',
    conversationRecords: [{ question: 'New topic', answer: 'New answer' }],
  })
  replacement.sessionId = stored.sessionId
  replacement.createdAt = stored.createdAt
  replacement.updatedAt = stored.updatedAt
  assert.notEqual(replacement.sessionLifecycleId, stored.sessionLifecycleId)

  const sessions = await updateSession(replacement)
  assert.equal(sessions[0].sessionName, null)
  assert.equal(sessions[0].sessionNameSource, null)
  assert.equal(sessions[0].sessionTitleGenerationStatus, 'idle')
  assert.equal(sessions[0].sessionTitleGenerationAttempts, 0)
  assert.notEqual(sessions[0].sessionLifecycleId, stored.sessionLifecycleId)
  assert.equal(sessions[0].createdAt, replacement.createdAt)
  assert.deepEqual(sessions[0].conversationRecords, replacement.conversationRecords)
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
  assert.equal(first.updated, true)
  assert.ok(first.session.sessionTitleGenerationId)
  assert.equal(first.session.sessionTitleGenerationAttempts, 1)
  assert.equal(second.claimed, false)
  assert.equal(second.updated, false)
})

test('stale or malformed pending claims become terminal without resending data', async () => {
  const malformed = initSession({
    sessionTitleGenerationStatus: 'pending',
    sessionTitleGenerationStartedAt: null,
    sessionTitleGenerationId: 'old',
    sessionTitleGenerationAttempts: 1,
  })
  assert.equal(isSessionTitleGenerationStale(malformed), true)
  assert.equal(getSessionTitleGenerationStaleDelay(malformed), 0)

  malformed.sessionTitleGenerationStartedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString()
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [malformed] })
  const claim = await claimSessionTitleGeneration(malformed.sessionId)
  assert.equal(claim.claimed, false)
  assert.equal(claim.updated, true)
  assert.equal(claim.session.sessionTitleGenerationStatus, 'failed')
  assert.equal(claim.session.sessionTitleGenerationAttempts, 1)
  assert.equal(claim.session.sessionTitleGenerationStartedAt, null)
  assert.equal(claim.session.sessionTitleGenerationId, null)
})

test('stale pending cleanup respects the single-attempt limit', async () => {
  const exhausted = initSession({
    sessionTitleGenerationStatus: 'pending',
    sessionTitleGenerationStartedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    sessionTitleGenerationId: 'abandoned',
    sessionTitleGenerationAttempts: MAX_SESSION_TITLE_GENERATION_ATTEMPTS,
  })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [exhausted] })

  const claim = await claimSessionTitleGeneration(exhausted.sessionId)
  assert.equal(claim.claimed, false)
  assert.equal(claim.updated, true)
  assert.equal(claim.session.sessionTitleGenerationStatus, 'failed')
  assert.equal(
    claim.session.sessionTitleGenerationAttempts,
    MAX_SESSION_TITLE_GENERATION_ATTEMPTS,
  )
  assert.equal(claim.session.sessionTitleGenerationStartedAt, null)
  assert.equal(claim.session.sessionTitleGenerationId, null)
})

test('fresh pending claims expose their remaining stale delay', () => {
  const now = Date.now()
  const session = initSession({
    sessionTitleGenerationStatus: 'pending',
    sessionTitleGenerationStartedAt: new Date(now - 30_000).toISOString(),
  })
  assert.equal(getSessionTitleGenerationStaleDelay(session, now), 90_000)
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

test('existing manual and legacy titles are never overwritten', async () => {
  const manual = initSession({ sessionName: 'Keep this', sessionNameSource: 'manual' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [manual] })
  const manualClaim = await claimSessionTitleGeneration(manual.sessionId)
  assert.equal(manualClaim.claimed, false)
  assert.equal(manualClaim.updated, false)

  const legacy = initSession({ sessionName: '8/29/2026, 10:30:00 AM' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [legacy] })
  const legacyClaim = await claimSessionTitleGeneration(legacy.sessionId)
  assert.equal(legacyClaim.claimed, false)
  assert.equal(legacyClaim.updated, false)
})

test('an experimental heuristic title may be replaced by the model', async () => {
  const session = initSession({
    sessionName: 'Prompt prefix…',
    sessionNameSource: 'heuristic',
  })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })
  const claim = await claimSessionTitleGeneration(session.sessionId)
  const completed = await completeSessionTitleGeneration(
    session.sessionId,
    'Actual task title',
    claim.session.sessionTitleGenerationId,
  )
  assert.equal(completed.updated, true)
  assert.equal(completed.session.sessionName, 'Actual task title')
})

test('a failed title request is terminal and is never resent', async () => {
  const session = initSession()
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [session] })

  const firstClaim = await claimSessionTitleGeneration(session.sessionId)
  const failure = await failSessionTitleGeneration(
    session.sessionId,
    firstClaim.session.sessionTitleGenerationId,
  )

  assert.equal(failure.session.sessionTitleGenerationAttempts, 1)
  const secondClaim = await claimSessionTitleGeneration(session.sessionId)
  assert.equal(secondClaim.claimed, false)
  assert.equal(secondClaim.updated, false)
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
