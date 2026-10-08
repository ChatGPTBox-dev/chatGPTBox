import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initSession } from '../../../src/services/init-session.mjs'

test('new sessions are untitled and have idle title-generation metadata', () => {
  const session = initSession()
  assert.equal(session.sessionName, null)
  assert.equal(session.sessionNameSource, null)
  assert.equal(session.sessionTitleGenerationStatus, 'idle')
  assert.equal(session.sessionTitleGenerationStartedAt, null)
  assert.equal(session.sessionTitleGenerationId, null)
  assert.equal(session.sessionTitleGenerationAttempts, 0)
})

test('title metadata can be restored from persisted sessions', () => {
  const session = initSession({
    sessionName: 'Manual title',
    sessionNameSource: 'manual',
    sessionTitleGenerationStatus: 'succeeded',
    sessionTitleGenerationAttempts: 1,
  })
  assert.equal(session.sessionName, 'Manual title')
  assert.equal(session.sessionNameSource, 'manual')
  assert.equal(session.sessionTitleGenerationStatus, 'succeeded')
  assert.equal(session.sessionTitleGenerationAttempts, 1)
})
