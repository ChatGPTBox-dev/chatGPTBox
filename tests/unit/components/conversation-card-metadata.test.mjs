import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getCompletedAnswerMetadata,
  getLastConversationRecord,
} from '../../../src/components/ConversationCard/session.mjs'

test('getLastConversationRecord uses length-based indexing', () => {
  const records = [{ question: 'Q1' }, { question: 'Q2' }]

  assert.equal(getLastConversationRecord(records), records[1])
  assert.equal(getLastConversationRecord([]), null)
  assert.equal(getLastConversationRecord(null), null)
})

test('getCompletedAnswerMetadata reads retained response metadata', () => {
  const meta = { selectedModel: 'model-a', usage: { inputTokens: 12 } }

  assert.equal(
    getCompletedAnswerMetadata({
      message: { session: { conversationRecords: [{ meta }] } },
      restoredRetryAnswer: null,
      partialAnswer: 'Answer',
      retryRecord: null,
      requestedModel: 'model-a',
      fallbackModel: 'Model A',
    }),
    meta,
  )
})

test('getCompletedAnswerMetadata preserves metadata on duplicate done messages', () => {
  assert.equal(
    getCompletedAnswerMetadata({
      message: { done: true },
      restoredRetryAnswer: null,
      partialAnswer: '',
      retryRecord: null,
      requestedModel: '',
      fallbackModel: 'Model A',
    }),
    undefined,
  )
})

test('getCompletedAnswerMetadata records a model for retained partial answers', () => {
  assert.deepEqual(
    getCompletedAnswerMetadata({
      message: { done: true },
      restoredRetryAnswer: null,
      partialAnswer: 'Partial',
      retryRecord: null,
      requestedModel: 'model-a',
      fallbackModel: 'Model A',
    }),
    { selectedModel: 'model-a' },
  )
})

test('getCompletedAnswerMetadata restores retry metadata', () => {
  const meta = { selectedModel: 'old-model' }

  assert.equal(
    getCompletedAnswerMetadata({
      message: { done: true },
      restoredRetryAnswer: 'Old answer',
      partialAnswer: '',
      retryRecord: { meta },
      requestedModel: 'new-model',
      fallbackModel: 'New Model',
    }),
    meta,
  )
})
