import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createConversationPortMessage,
  createRetrySession,
  finalizeInterruptedSession,
  getCompletedAnswerContent,
  getInterruptedCompletionState,
  isSupersededGenerationMessage,
  isSupersededRequestMessage,
} from '../../../src/components/ConversationCard/session.mjs'

const PLACEHOLDER = '<p class="gpt-loading">Waiting for response...</p>'

test('finalizeInterruptedSession appends a partial answer without mutating the source session', () => {
  const session = {
    question: 'Q1',
    isRetry: false,
    conversationRecords: [],
  }

  const updatedSession = finalizeInterruptedSession(session, 'Partial answer')

  assert.notEqual(updatedSession, session)
  assert.deepEqual(session.conversationRecords, [])
  assert.deepEqual(updatedSession.conversationRecords, [
    { question: 'Q1', answer: 'Partial answer' },
  ])
})

test('finalizeInterruptedSession replaces a retry answer and clears retry state', () => {
  const session = {
    question: 'Q1',
    isRetry: true,
    conversationRecords: [{ question: 'Q1', answer: 'Old answer' }],
  }

  const updatedSession = finalizeInterruptedSession(session, 'Partial retry answer')

  assert.equal(session.isRetry, true)
  assert.deepEqual(session.conversationRecords, [{ question: 'Q1', answer: 'Old answer' }])
  assert.equal(updatedSession.isRetry, false)
  assert.deepEqual(updatedSession.conversationRecords, [
    { question: 'Q1', answer: 'Partial retry answer' },
  ])
})

test('finalizeInterruptedSession appends after existing records when not retrying', () => {
  const session = {
    question: 'Q2',
    isRetry: false,
    conversationRecords: [{ question: 'Q1', answer: 'A1' }],
  }

  const updatedSession = finalizeInterruptedSession(session, 'Partial answer')

  assert.deepEqual(session.conversationRecords, [{ question: 'Q1', answer: 'A1' }])
  assert.deepEqual(updatedSession.conversationRecords, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'Partial answer' },
  ])
})

test('finalizeInterruptedSession restores a retry answer when interrupted before tokens arrive', () => {
  const session = {
    question: 'Q1',
    isRetry: true,
    conversationRecords: [],
  }
  const retryRecord = { question: 'Q1', answer: 'Old answer' }

  const updatedSession = finalizeInterruptedSession(session, '', retryRecord)

  assert.equal(session.isRetry, true)
  assert.deepEqual(session.conversationRecords, [])
  assert.equal(updatedSession.isRetry, false)
  assert.deepEqual(updatedSession.conversationRecords, [{ question: 'Q1', answer: 'Old answer' }])
})

test('finalizeInterruptedSession restores a retry record even before retry state commits', () => {
  const retryRecord = { question: 'Q1', answer: 'Old answer' }
  const session = {
    question: 'Q1',
    isRetry: false,
    conversationRecords: [],
  }

  const updatedSession = finalizeInterruptedSession(session, '', retryRecord)

  assert.equal(updatedSession.isRetry, false)
  assert.deepEqual(updatedSession.conversationRecords, [retryRecord])
})

test('finalizeInterruptedSession clears retry state when no record was stashed', () => {
  const session = {
    question: 'Q1',
    isRetry: true,
    conversationRecords: [],
  }

  const updatedSession = finalizeInterruptedSession(session, '')

  assert.equal(updatedSession.isRetry, false)
  assert.deepEqual(updatedSession.conversationRecords, [])
})

test('finalizeInterruptedSession does not duplicate an already restored retry record', () => {
  const retryRecord = { question: 'Q1', answer: 'Old answer' }
  const session = {
    question: 'Q1',
    isRetry: false,
    conversationRecords: [retryRecord],
  }

  const updatedSession = finalizeInterruptedSession(session, '', retryRecord)

  assert.deepEqual(updatedSession.conversationRecords, [retryRecord])
})

test('isSupersededGenerationMessage ignores only stopped generations', () => {
  assert.equal(isSupersededGenerationMessage({ done: true }, 3), false)
  assert.equal(isSupersededGenerationMessage({ done: true, stoppedGenerationId: 4 }, 3), false)
  assert.equal(isSupersededGenerationMessage({ done: true, stoppedGenerationId: 3 }, 3), true)
  assert.equal(isSupersededGenerationMessage({ session: {}, stoppedGenerationId: 2 }, 3), true)
})

test('isSupersededRequestMessage ignores responses from older requests', () => {
  assert.equal(isSupersededRequestMessage({ done: true, requestGenerationId: 2 }, 3), true)
  assert.equal(isSupersededRequestMessage({ done: true, requestGenerationId: 3 }, 3), false)
  assert.equal(isSupersededRequestMessage({ done: true }, 3), false)
})

test('createConversationPortMessage preserves retry stop acknowledgement identity', () => {
  assert.deepEqual(createConversationPortMessage({ stop: true, stopGenerationId: 3 }), {
    session: undefined,
    stop: true,
    stopGenerationId: 3,
  })
})

test('createConversationPortMessage keeps the existing payload for normal messages', () => {
  const session = { question: 'Q1' }

  assert.deepEqual(createConversationPortMessage({ session, requestGenerationId: 4 }), {
    session,
    stop: undefined,
    requestGenerationId: 4,
  })
})

test('createRetrySession appends after a removed retry target', () => {
  const conversationRecords = [{ question: 'Q1', answer: 'A1' }]

  const retrySession = createRetrySession(
    { question: 'Q1', isRetry: true, conversationRecords: [] },
    conversationRecords,
    { question: 'Q1', answer: 'Old answer' },
  )

  assert.equal(retrySession.isRetry, false)
  assert.equal(retrySession.conversationRecords, conversationRecords)
})

test('createRetrySession keeps provider retry mode when no target was removed', () => {
  const retrySession = createRetrySession(
    { question: 'Q1', isRetry: false, conversationRecords: [] },
    [],
    null,
  )

  assert.equal(retrySession.isRetry, true)
})

test('getInterruptedCompletionState restores retry context for a sessionless stop', () => {
  const retryRecord = { question: 'Q1', answer: 'Old answer' }

  assert.deepEqual(getInterruptedCompletionState({ done: true }, '', retryRecord), {
    shouldFinalize: true,
    restoredRetryAnswer: 'Old answer',
  })
})

test('getInterruptedCompletionState finalizes on proxy disconnect with a session', () => {
  const retryRecord = { question: 'Q1', answer: 'Old answer' }

  assert.deepEqual(
    getInterruptedCompletionState(
      { done: true, proxyDisconnected: true, session: {} },
      '',
      retryRecord,
    ),
    {
      shouldFinalize: true,
      restoredRetryAnswer: 'Old answer',
    },
  )
})

test('getCompletedAnswerContent finishes with the answer the stream produced', () => {
  assert.equal(
    getCompletedAnswerContent(null, 'The answer.', PLACEHOLDER, PLACEHOLDER),
    'The answer.',
  )
})

test('getCompletedAnswerContent restores a retry answer that outranks the stream', () => {
  assert.equal(
    getCompletedAnswerContent('Restored answer', 'Partial', 'Partial', PLACEHOLDER),
    'Restored answer',
  )
})

test('getCompletedAnswerContent clears the placeholder a reasoning-only turn left behind', () => {
  assert.equal(getCompletedAnswerContent(null, '', PLACEHOLDER, PLACEHOLDER), '')
})

test('getCompletedAnswerContent keeps an answer a duplicate completion would blank', () => {
  // ChatGPT Web and Waylaidwanderer send a second, contentless completion at the end of the
  // stream; by then the buffered answer has already been consumed.
  assert.equal(getCompletedAnswerContent(null, '', 'The answer.', PLACEHOLDER), 'The answer.')
})

test('getCompletedAnswerContent leaves an already cleared answer alone', () => {
  assert.equal(getCompletedAnswerContent(null, '', '', PLACEHOLDER), '')
})
