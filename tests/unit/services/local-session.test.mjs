import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  createSession,
  deleteSession,
  getSession,
  getSessions,
  resetSessions,
  updateSession,
} from '../../../src/services/local-session.mjs'
import { initSession } from '../../../src/services/init-session.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('createSession without argument creates a new default session', async () => {
  const { session, currentSessions } = await createSession()

  assert.match(session.sessionId, UUID_RE)
  // getSessions auto-initializes a reset session when storage is empty,
  // so the result contains the new session plus the reset default
  assert.ok(currentSessions.length >= 1)
  assert.equal(currentSessions[0].sessionId, session.sessionId)
})

test('createSession with a session object inserts it', async () => {
  const custom = initSession({ sessionName: 'Custom Chat' })
  const { session, currentSessions } = await createSession(custom)

  assert.equal(session.sessionName, 'Custom Chat')
  assert.ok(currentSessions.length >= 1)
  assert.equal(currentSessions[0].sessionId, custom.sessionId)
})

test('createSession upserts existing session by sessionId', async () => {
  // Pre-seed storage so getSession finds the original
  const original = initSession({ sessionName: 'Original' })
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [original] })

  const updated = { ...original, sessionName: 'Updated' }
  const { session, currentSessions } = await createSession(updated)

  assert.equal(session.sessionName, 'Updated')
  assert.equal(currentSessions.length, 1)
  assert.equal(currentSessions[0].sessionName, 'Updated')
})

test('deleteSession removes a session by id', async () => {
  const s1 = initSession({ sessionName: 'First' })
  const s2 = initSession({ sessionName: 'Second' })
  // Pre-seed storage directly to avoid auto-initialization side effects
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [s1, s2] })

  const remaining = await deleteSession(s1.sessionId)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].sessionId, s2.sessionId)
})

test('deleteSession resets when last session is removed', async () => {
  const s = initSession({ sessionName: 'Only' })
  // Directly seed storage with exactly one session to avoid auto-init side-effect
  globalThis.__TEST_BROWSER_SHIM__.setStorage({ sessions: [s] })

  const result = await deleteSession(s.sessionId)
  // should trigger resetSessions() fallback and return a fresh default session
  assert.equal(result.length, 1)
  assert.notEqual(result[0].sessionId, s.sessionId)
})

test('resetSessions replaces all sessions with one default', async () => {
  const s1 = initSession({ sessionName: 'A' })
  const s2 = initSession({ sessionName: 'B' })
  await createSession(s1)
  await createSession(s2)

  const result = await resetSessions()
  assert.equal(result.length, 1)
  assert.match(result[0].sessionId, UUID_RE)
})

test('getSessions initializes when storage is empty', async () => {
  const sessions = await getSessions()

  assert.equal(sessions.length, 1)
  assert.match(sessions[0].sessionId, UUID_RE)
})

test('getSessions returns existing sessions from storage', async () => {
  const s = initSession({ sessionName: 'Persisted' })
  await createSession(s)

  const sessions = await getSessions()
  assert.ok(sessions.some((sess) => sess.sessionId === s.sessionId))
})

test('getSession finds session by id', async () => {
  const s = initSession({ sessionName: 'Find Me' })
  await createSession(s)

  const { session } = await getSession(s.sessionId)
  assert.equal(session.sessionId, s.sessionId)
  assert.equal(session.sessionName, 'Find Me')
})

test('getSession returns undefined for non-existent id', async () => {
  await createSession()
  const { session } = await getSession('non-existent-id')
  assert.equal(session, undefined)
})

test('updateSession sets updatedAt and persists changes', async () => {
  const s = initSession({ sessionName: 'Before' })
  await createSession(s)

  const modified = { ...s, sessionName: 'After' }
  const result = await updateSession(modified)

  const found = result.find((sess) => sess.sessionId === s.sessionId)
  assert.equal(found.sessionName, 'After')
  assert.ok(found.updatedAt >= s.updatedAt)
})

test('storage persistence: data survives across calls', async () => {
  const s = initSession({ sessionName: 'Persistent' })
  await createSession(s)

  // Retrieve via a separate getSessions call
  const sessions = await getSessions()
  const found = sessions.find((sess) => sess.sessionId === s.sessionId)
  assert.equal(found.sessionName, 'Persistent')

  // Verify raw storage
  const raw = globalThis.__TEST_BROWSER_SHIM__.getStorage()
  assert.ok(Array.isArray(raw.sessions))
  assert.ok(raw.sessions.some((sess) => sess.sessionId === s.sessionId))
})
