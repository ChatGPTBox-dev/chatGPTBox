import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createRetrySession,
  finalizeCompletedSession,
  finalizeInterruptedSession,
  shouldReplaceLastRetryRecord,
} from '../../../../src/components/ConversationCard/session.mjs'
import { generateAnswersWithGeminiWebApi } from '../../../../src/services/apis/gemini-web.mjs'
import { createGeminiContinuationGuard } from '../../../../src/services/apis/gemini-web-continuation.mjs'
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

test('replacing the latest Gemini answer with another provider invalidates Gemini continuation', () => {
  const session = geminiSession({
    modelName: 'claude2WebFree',
    apiMode: { groupName: 'claudeWebModelKeys' },
    geminiWeb_lastRecordIndex: 1,
    geminiWeb_conversation: { c: 'c-after', r: 'r-after', rc: 'rc-after' },
  })
  const retrySession = createRetrySession(session, [priorRecord], retryRecord)

  assert.notEqual(retrySession.geminiWeb_conversationUnsafe, true)
  assert.equal(Object.hasOwn(retrySession, 'geminiWeb_retryConversation'), false)
  const failed = finalizeInterruptedSession(retrySession, 'partial replacement', {
    ...retryRecord,
    recordIndex: 1,
  })
  assert.deepEqual(failed.conversationRecords, [priorRecord, retryRecord])
  assert.notEqual(failed.geminiWeb_conversationUnsafe, true)
  const completed = finalizeCompletedSession(
    {
      ...retrySession,
      conversationRecords: [priorRecord, { question: 'Q2', answer: 'replacement' }],
    },
    { ...retryRecord, recordIndex: 1 },
  )
  assert.equal(completed.geminiWeb_conversationUnsafe, true)
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

  const restored = finalizeInterruptedSession(session, '', { ...retryRecord, recordIndex: 1 })

  assert.deepEqual(restored.conversationRecords, [priorRecord, retryRecord])
  assert.equal(restored.geminiWeb_conversation, currentConversation)
  assert.equal(restored.geminiWeb_lastRecordIndex, 1)
  assert.equal(Object.hasOwn(restored, 'geminiWeb_retryConversation'), false)
})

test('successful completed retries branch from the pre-turn continuation', async (t) => {
  const previousConversation = {
    c: 'c-same',
    r: 'r-before',
    rc: 'rc-before',
    turnIndex: 1,
    accountPath: '/u/1',
  }
  const currentConversation = {
    c: 'c-same',
    r: 'r-after',
    rc: 'rc-after',
    turnIndex: 2,
    accountPath: '/u/1',
  }
  const replacementConversation = {
    c: 'c-same',
    r: 'r-replacement',
    rc: 'rc-replacement',
    turnIndex: 2,
    accountPath: '/u/1',
  }
  t.mock.method(
    GeminiWebClient.prototype,
    'ask',
    async (_question, conversation, _signal, options) => {
      options.onPromptSubmitted()
      assert.equal(conversation, previousConversation)
      return { answer: 'replacement answer', conversationObj: replacementConversation }
    },
  )

  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_previousConversation: previousConversation,
    geminiWeb_conversation: currentConversation,
    geminiWeb_retryConversation: previousConversation,
    geminiWeb_lastRecordIndex: 1,
  })
  const port = createFakePort()

  const entries = {}
  const guard = createGeminiContinuationGuard(
    {
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
    async (value) => value,
  )
  await generateAnswersWithGeminiWebApi(port, 'Q2', session, {}, () => true, port, guard)

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

  const restored = finalizeInterruptedSession(session, '', { ...retryRecord, recordIndex: 1 })
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
  const revision = JSON.stringify([
    currentConversation.c,
    currentConversation.r,
    currentConversation.rc,
    currentConversation.turnIndex,
  ])
  connectionPort._geminiUnsafeRevisions = new Set([revision])

  await assert.rejects(
    generateAnswersWithGeminiWebApi(requestPort, 'Q2', session, {}, () => true, connectionPort),
    /previous Gemini request may have changed the remote conversation/,
  )

  assert.equal(askCount, 0)
  assert.equal(connectionPort._geminiUnsafeRevisions.has(revision), true)
  assert.equal(session.geminiWeb_conversationUnsafe, true)
  assert.deepEqual(requestPort.postedMessages, [{ geminiWebConversationUnsafe: true }])
  assert.deepEqual(requestPort.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('unsafe retry from an earlier remote snapshot fails closed before the request', async (t) => {
  let askCount = 0
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    askCount += 1
    throw new Error('unexpected request')
  })
  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_conversationUnsafe: true,
    geminiWeb_conversation: { c: 'c-after', r: 'r-after', rc: 'rc-after' },
    geminiWeb_retryConversation: { c: 'c-before', r: 'r-before', rc: 'rc-before' },
  })
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'Q2', session),
    /previous Gemini request may have changed the remote conversation/,
  )
  assert.equal(askCount, 0)
})

test('persisted pending continuation prevents reuse after a page reload', async (t) => {
  let askCount = 0
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    askCount += 1
  })
  const session = geminiSession({
    geminiWeb_conversationPending: true,
    geminiWeb_conversation: { c: 'c-old', r: 'r-old', rc: 'rc-old', accountPath: '' },
  })
  await assert.rejects(
    generateAnswersWithGeminiWebApi(createFakePort(), 'Q3', session),
    /previous Gemini request may have changed the remote conversation/,
  )
  assert.equal(askCount, 0)
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

test('retrying a failed completed answer retains the same pre-turn continuation', () => {
  const previousConversation = { c: 'c-old', r: 'r-before', rc: 'rc-before', turnIndex: 1 }
  const currentConversation = { c: 'c-old', r: 'r-after', rc: 'rc-after', turnIndex: 2 }
  const session = geminiSession({
    geminiWeb_previousConversation: previousConversation,
    geminiWeb_conversation: currentConversation,
    geminiWeb_lastRecordIndex: 1,
  })
  const firstRetry = createRetrySession(session, [priorRecord], retryRecord)
  const restored = finalizeInterruptedSession(firstRetry, '', { ...retryRecord, recordIndex: 1 })
  assert.equal(shouldReplaceLastRetryRecord(restored.conversationRecords, -1), false)
  assert.equal(shouldReplaceLastRetryRecord(restored.conversationRecords, 1), true)

  const records = [...restored.conversationRecords]
  const replacement = records.pop()
  const secondRetry = createRetrySession(restored, records, replacement)
  assert.equal(secondRetry.question, 'Q2')
  assert.equal(secondRetry.geminiWeb_retryConversation, previousConversation)
  assert.deepEqual(secondRetry.conversationRecords, [priorRecord])
})

test('interrupted cross-provider retries restore identical records by their position', () => {
  const record = { question: 'Same question', answer: 'Same answer' }
  const session = geminiSession({
    modelName: 'claude2WebFree',
    apiMode: { groupName: 'claudeWebModelKeys' },
    conversationRecords: [record],
    geminiWeb_lastRecordIndex: 1,
  })
  const backup = { ...record, recordIndex: 1 }
  const restored = finalizeInterruptedSession(session, 'partial', backup)
  assert.deepEqual(restored.conversationRecords, [record, record])
  assert.deepEqual(finalizeInterruptedSession(restored, '', backup).conversationRecords, [
    record,
    record,
  ])
})

test('retry of a stopped identical question does not replace the earlier answer', () => {
  const record = { question: 'Q2', answer: 'Earlier answer' }
  const records = [record]
  assert.equal(shouldReplaceLastRetryRecord(records, -1), false)
  const retry = createRetrySession(geminiSession(), records, null)
  assert.equal(retry.isRetry, false)
  assert.deepEqual(finalizeInterruptedSession(retry, 'New answer').conversationRecords, [
    record,
    { question: 'Q2', answer: 'New answer' },
  ])
})

test('successful same-conversation retry advances the persisted continuation revision', async (t) => {
  const turn = (revision, turnIndex) => ({
    c: 'c_same',
    r: 'r_' + revision,
    rc: 'rc_' + revision,
    accountPath: '',
    turnIndex,
  })
  const previous = turn('before', 1)
  const current = turn('current', 2)
  const replacement = turn('replacement', 2)
  const entries = {}
  const storage = {
    async get(key) {
      return { [key]: entries[key] }
    },
    async set(values) {
      Object.assign(entries, values)
    },
    async remove(key) {
      delete entries[key]
    },
  }
  const createGuard = () => createGeminiContinuationGuard(storage, async (value) => value)
  const initialGuard = createGuard()
  const initial = await initialGuard.begin(previous, previous)
  await initial.complete(current)
  await initial.release({ safe: false })

  t.mock.method(
    GeminiWebClient.prototype,
    'ask',
    async (_question, conversation, _signal, options) => {
      assert.deepEqual(conversation, previous)
      options.onPromptSubmitted()
      return { answer: 'Replacement', conversationObj: replacement }
    },
  )
  const session = geminiSession({
    conversationRecords: [priorRecord],
    geminiWeb_previousConversation: previous,
    geminiWeb_conversation: current,
    geminiWeb_retryConversation: previous,
    geminiWeb_lastRecordIndex: 1,
  })
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q2', session, {}, () => true, port, createGuard())
  assert.deepEqual(session.geminiWeb_conversation, replacement)
  assert.deepEqual(session.conversationRecords, [
    priorRecord,
    { question: 'Q2', answer: 'Replacement' },
  ])
  const reopened = createGuard()
  await assert.rejects(reopened.begin(current, current), /previous Gemini request/)
  const next = await reopened.begin(replacement, replacement)
  await next.release({ safe: true })
})

test('a selected non-Gemini API mode takes precedence over an old Gemini model name', () => {
  const session = geminiSession({
    apiMode: { groupName: 'claudeWebModelKeys' },
    geminiWeb_lastRecordIndex: 1,
    geminiWeb_conversation: { c: 'c_same', r: 'r_old', rc: 'rc_old' },
  })
  const backup = { ...retryRecord, recordIndex: 1 }
  const pending = createRetrySession(session, [priorRecord], backup)
  assert.equal(Object.hasOwn(pending, 'geminiWeb_retryConversation'), false)
  const completed = finalizeCompletedSession(
    {
      ...pending,
      conversationRecords: [priorRecord, { question: 'Q2', answer: 'Replacement' }],
    },
    backup,
  )
  assert.equal(completed.geminiWeb_conversationUnsafe, true)
})

test('legacy Gemini model names remain usable when no API mode is selected', () => {
  const previous = { c: 'c_same', r: 'r_old', rc: 'rc_old' }
  const session = geminiSession({
    apiMode: null,
    geminiWeb_lastRecordIndex: 1,
    geminiWeb_previousConversation: previous,
  })
  const pending = createRetrySession(session, [priorRecord], { ...retryRecord, recordIndex: 1 })
  assert.deepEqual(pending.geminiWeb_retryConversation, previous)
})

test('an unsafe old revision does not block a newer revision on the same port', async (t) => {
  const current = { c: 'c', r: 'r2', rc: 'rc2', turnIndex: 2 }
  const next = { c: 'c', r: 'r3', rc: 'rc3', turnIndex: 3 }
  const connectionPort = createFakePort()
  connectionPort._geminiUnsafeRevisions = new Set([JSON.stringify(['c', 'r1', 'rc1', 1])])
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => ({
    answer: 'New',
    conversationObj: next,
  }))
  const session = geminiSession({ geminiWeb_conversation: current })
  await generateAnswersWithGeminiWebApi(
    createFakePort(),
    'Q',
    session,
    {},
    () => true,
    connectionPort,
  )
  assert.deepEqual(session.geminiWeb_conversation, next)
  assert.notEqual(session.geminiWeb_conversationUnsafe, true)
})
