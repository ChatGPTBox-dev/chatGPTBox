import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getCompletedAnswerMetadata,
  getLastConversationRecord,
} from '../../../src/components/ConversationCard/session.mjs'

test('getLastConversationRecord avoids Array.prototype.at', () => {
  const records = [{ question: 'Q1' }, { question: 'Q2' }]

  assert.equal(getLastConversationRecord(records), records[1])
  assert.equal(getLastConversationRecord([]), null)
  assert.equal(getLastConversationRecord(null), null)
})

test('completed response metadata is persisted onto the returned session record', () => {
  const record = { question: 'Q', answer: 'A' }
  const message = {
    session: {
      modelName: 'customModel',
      conversationRecords: [record],
    },
    meta: {
      selectedModel: 'actual-request-model',
      reportedModel: 'routed-model',
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  }

  const metadata = getCompletedAnswerMetadata({
    message,
    restoredRetryAnswer: null,
    retryRecord: null,
  })

  assert.deepEqual(metadata, {
    selectedModel: 'actual-request-model',
    reportedModel: 'routed-model',
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
  })
  assert.equal(record.meta, metadata)
})

test('plain completed sessions use the stable model key, not aiName', () => {
  const record = { question: 'Q', answer: 'A' }
  const message = {
    session: {
      modelName: 'bingFreeSydney',
      aiName: 'Translated display name',
      conversationRecords: [record],
    },
  }

  assert.deepEqual(
    getCompletedAnswerMetadata({
      message,
      restoredRetryAnswer: null,
      retryRecord: null,
    }),
    { selectedModel: 'bingFreeSydney' },
  )
  assert.deepEqual(record.meta, { selectedModel: 'bingFreeSydney' })
})

test('stop acknowledgement metadata is returned without changing record lifecycle', () => {
  const metadata = getCompletedAnswerMetadata({
    message: {
      done: true,
      meta: {
        selectedModel: 'claude-sonnet-5',
        reportedModel: 'claude-sonnet-5-20260801',
      },
    },
    restoredRetryAnswer: null,
    retryRecord: null,
  })

  assert.deepEqual(metadata, {
    selectedModel: 'claude-sonnet-5',
    reportedModel: 'claude-sonnet-5-20260801',
  })
})

test('retry restoration returns the original metadata unchanged', () => {
  const meta = { selectedModel: 'old-model' }

  assert.equal(
    getCompletedAnswerMetadata({
      message: { done: true },
      restoredRetryAnswer: 'Old answer',
      retryRecord: { question: 'Q', answer: 'Old answer', meta },
    }),
    meta,
  )
})

test('duplicate terminal messages without metadata do not request replacement', () => {
  assert.equal(
    getCompletedAnswerMetadata({
      message: { done: true },
      restoredRetryAnswer: null,
      retryRecord: null,
    }),
    undefined,
  )
})
