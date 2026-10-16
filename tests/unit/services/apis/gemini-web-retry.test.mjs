import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createRetrySession,
  finalizeInterruptedSession,
} from '../../../../src/components/ConversationCard/session.mjs'
import { generateAnswersWithGeminiWebApi } from '../../../../src/services/apis/gemini-web.mjs'
import GeminiWebClient from '../../../../src/services/clients/gemini-web/index.mjs'
import { protocolError } from '../../../../src/services/clients/gemini-web/protocol.mjs'
import { createFakePort } from '../../helpers/port.mjs'

const priorRecord = { question: 'Q1', answer: 'A1' }
const retryRecord = { question: 'Q2', answer: 'old answer' }

function geminiSession(overrides = {}) {
  return {
    question: 'Q2',
    conversationRecords: [priorRecord, retryRecord],
    apiMode: { groupName: 'bardWebModelKeys' },
    modelName: 'bardWebFree',
    isRetry: false,
    ...overrides,
  }
}

test('completed Gemini retries use the saved pre-turn continuation', () => {
  const previousConversation = {
    c: 'c-before',
    r: 'r-before',
    rc: 'rc-before',
    accountPath: '/u/1',
  }
  const currentConversation = {
    c: 'c-after',
    r: 'r-after',
    rc: 'rc-after',
    accountPath: '/u/1',
  }
  const retrySession = createRetrySession(
    geminiSession({
      geminiWeb_previousConversation: previousConversation,
      geminiWeb_conversation: currentConversation,
      geminiWeb_lastRecordIndex: 1,
    }),
    [priorRecord],
    retryRecord,
  )

  assert.equal(retrySession.geminiWeb_retryConversation, previousConversation)
  assert.equal(retrySession.geminiWeb_conversation, currentConversation)
  assert.equal(retrySession.isRetry, false)
})

test('legacy Gemini retries without a pre-turn continuation are marked unsafe', () => {
  const retrySession = createRetrySession(
    geminiSession({
      geminiWeb_conversation: {
        c: 'c-after',
        r: 'r-after',
        rc: 'rc-after',
        accountPath: '',
      },
    }),
    [priorRecord],
    retryRecord,
  )

  assert.equal(Object.hasOwn(retrySession, 'geminiWeb_retryConversation'), true)
  assert.equal(retrySession.geminiWeb_retryConversation, null)
})

test('switching a non-Gemini answer to Gemini starts a clean continuation', () => {
  const retrySession = createRetrySession(geminiSession(), [priorRecord], retryRecord)

  assert.deepEqual(retrySession.geminiWeb_retryConversation, {})
})

test('switching back to Gemini keeps valid Gemini context from an older answer', () => {
  const currentConversation = {
    c: 'c-after',
    r: 'r-after',
    rc: 'rc-after',
    accountPath: '',
  }
  const retrySession = createRetrySession(
    geminiSession({
      geminiWeb_previousConversation: {
        c: 'c-before',
        r: 'r-before',
        rc: 'rc-before',
        accountPath: '',
      },
      geminiWeb_conversation: currentConversation,
      geminiWeb_lastRecordIndex: 0,
    }),
    [priorRecord],
    retryRecord,
  )

  assert.equal(retrySession.geminiWeb_retryConversation, currentConversation)
})

test('switching back to Gemini refuses unsafe context from an older answer', () => {
  const retrySession = createRetrySession(
    geminiSession({
      geminiWeb_conversation: {
        c: 'c-unsafe',
        r: 'r-unsafe',
        rc: 'rc-unsafe',
        accountPath: '',
      },
      geminiWeb_lastRecordIndex: 0,
      geminiWeb_conversationUnsafe: true,
    }),
    [priorRecord],
    retryRecord,
  )

  assert.equal(retrySession.geminiWeb_retryConversation, null)
})

test('ambiguous intermediate retry snapshots without a record index fail closed', () => {
  const retrySession = createRetrySession(
    geminiSession({
      geminiWeb_previousConversation: {
        c: 'c-before',
        r: 'r-before',
        rc: 'rc-before',
        accountPath: '',
      },
      geminiWeb_conversation: {
        c: 'c-after',
        r: 'r-after',
        rc: 'rc-after',
        accountPath: '',
      },
    }),
    [priorRecord],
    retryRecord,
  )

  assert.equal(retrySession.geminiWeb_retryConversation, null)
})

test('failed completed retries restore the local answer and clear the retry override', () => {
  const currentConversation = {
    c: 'c-after',
    r: 'r-after',
    rc: 'rc-after',
    accountPath: '',
  }
  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_conversation: currentConversation,
    geminiWeb_previousConversation: { c: 'c-before', accountPath: '' },
    geminiWeb_retryConversation: { c: 'c-before', accountPath: '' },
    geminiWeb_lastRecordIndex: 1,
  })

  const restored = finalizeInterruptedSession(session, '', retryRecord)

  assert.deepEqual(restored.conversationRecords, [priorRecord, retryRecord])
  assert.equal(restored.geminiWeb_conversation, currentConversation)
  assert.equal(restored.geminiWeb_lastRecordIndex, 1)
  assert.equal(Object.hasOwn(restored, 'geminiWeb_retryConversation'), false)
})

test('successful completed retries branch from the pre-turn continuation', async (t) => {
  const previousConversation = {
    c: 'c-before',
    r: 'r-before',
    rc: 'rc-before',
    accountPath: '/u/1',
  }
  const currentConversation = {
    c: 'c-after',
    r: 'r-after',
    rc: 'rc-after',
    accountPath: '/u/1',
  }
  const replacementConversation = {
    c: 'c-replacement',
    r: 'r-replacement',
    rc: 'rc-replacement',
    accountPath: '/u/1',
  }
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...[, conversation]) => {
    assert.equal(conversation, previousConversation)
    return { answer: 'replacement answer', conversationObj: replacementConversation }
  })

  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_previousConversation: previousConversation,
    geminiWeb_conversation: currentConversation,
    geminiWeb_retryConversation: previousConversation,
    geminiWeb_lastRecordIndex: 1,
  })
  const port = createFakePort()

  await generateAnswersWithGeminiWebApi(port, 'Q2', session)

  assert.deepEqual(session.conversationRecords, [
    priorRecord,
    { question: 'Q2', answer: 'replacement answer' },
  ])
  assert.deepEqual(session.geminiWeb_previousConversation, previousConversation)
  assert.equal(session.geminiWeb_conversation, replacementConversation)
  assert.equal(session.geminiWeb_lastRecordIndex, 1)
  assert.equal(Object.hasOwn(session, 'geminiWeb_retryConversation'), false)
})

test('first-turn state snapshots pin the resolved Google account route for retry', async (t) => {
  const replacementConversation = {
    c: 'c-new',
    r: 'r-new',
    rc: 'rc-new',
    accountPath: '/u/2',
  }
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...[, conversation]) => {
    assert.deepEqual(conversation, {})
    return { answer: 'A1', conversationObj: replacementConversation }
  })

  const session = geminiSession({
    question: 'Q1',
    conversationRecords: [],
    geminiWeb_conversation: null,
  })
  const port = createFakePort()

  await generateAnswersWithGeminiWebApi(port, 'Q1', session)

  assert.deepEqual(session.geminiWeb_previousConversation, { accountPath: '/u/2' })
  assert.equal(session.geminiWeb_conversation, replacementConversation)
  assert.equal(session.geminiWeb_lastRecordIndex, 0)
})

test('empty pre-turn Retry retains unsafe continuation until replacement', async (t) => {
  let askCount = 0
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...[, conversation]) => {
    askCount += 1
    assert.deepEqual(conversation, { accountPath: '/u/1' })
    throw protocolError('Sign in to Gemini in this browser profile before trying again.')
  })

  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_previousConversation: { accountPath: '/u/1' },
    geminiWeb_retryConversation: { accountPath: '/u/1' },
    geminiWeb_conversation: {
      c: 'c-after',
      r: 'r-after',
      rc: 'rc-after',
      accountPath: '/u/1',
    },
    geminiWeb_lastRecordIndex: 1,
    geminiWeb_conversationUnsafe: true,
  })
  const port = createFakePort()

  await assert.rejects(generateAnswersWithGeminiWebApi(port, 'Q2', session), /Sign in to Gemini/)
  assert.equal(askCount, 1)
  assert.equal(session.geminiWeb_conversationUnsafe, true)
  assert.equal(session.geminiWeb_conversation.c, 'c-after')

  const restored = finalizeInterruptedSession(session, '', retryRecord)
  assert.equal(restored.geminiWeb_conversationUnsafe, true)
  assert.equal(Object.hasOwn(restored, 'geminiWeb_retryConversation'), false)

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'Q3', restored),
    /previous Gemini request may have changed the remote conversation/,
  )
  assert.equal(askCount, 1)
})

test('connection unsafe state blocks reuse of stored continuation', async (t) => {
  let askCount = 0
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    askCount += 1
    throw new Error('unexpected request')
  })

  const currentConversation = {
    c: 'c-unsafe',
    r: 'r-unsafe',
    rc: 'rc-unsafe',
    accountPath: '',
  }
  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_conversation: currentConversation,
    geminiWeb_retryConversation: { ...currentConversation },
  })
  const requestPort = createFakePort()
  const connectionPort = createFakePort()
  connectionPort._geminiConversationUnsafe = true

  await assert.rejects(
    generateAnswersWithGeminiWebApi(
      requestPort,
      'Q2',
      session,
      {},
      () => true,
      connectionPort,
    ),
    /previous Gemini request may have changed the remote conversation/,
  )

  assert.equal(askCount, 0)
  assert.equal(connectionPort._geminiConversationUnsafe, true)
  assert.equal(session.geminiWeb_conversationUnsafe, true)
  assert.deepEqual(requestPort.postedMessages, [{ geminiWebConversationUnsafe: true }])
  assert.deepEqual(requestPort.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('unsafe legacy completed retries fail closed before sending a Gemini request', async (t) => {
  let askCount = 0
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    askCount += 1
    throw new Error('unexpected request')
  })

  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_conversation: {
      c: 'c-after',
      r: 'r-after',
      rc: 'rc-after',
      accountPath: '',
    },
    geminiWeb_retryConversation: null,
  })
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'Q2', session),
    /Invalid conversation state/,
  )
  assert.equal(askCount, 0)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})
