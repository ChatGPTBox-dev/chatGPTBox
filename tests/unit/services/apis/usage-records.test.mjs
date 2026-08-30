import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushRecord } from '../../../../src/services/apis/shared.mjs'

test('pushRecord stores response metadata and falls back to the session model', () => {
  const session = {
    aiName: 'OpenAI (GPT-5.6)',
    isRetry: false,
    conversationRecords: [],
  }

  pushRecord(session, 'Q', 'A', {
    reportedModel: 'gpt-5.6-2026-08-01',
    usage: { inputTokens: 10, outputTokens: 2 },
  })

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Q',
      answer: 'A',
      meta: {
        selectedModel: 'OpenAI (GPT-5.6)',
        reportedModel: 'gpt-5.6-2026-08-01',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
    },
  ])
})

test('pushRecord replaces stale answer metadata when retrying', () => {
  const session = {
    isRetry: true,
    conversationRecords: [
      {
        question: 'Q',
        answer: 'Old',
        meta: {
          selectedModel: 'old-model',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      },
    ],
  }

  pushRecord(session, 'Q', 'New', {
    selectedModel: 'new-model',
    usage: { inputTokens: 20, outputTokens: 4 },
  })

  assert.deepEqual(session.conversationRecords, [
    {
      question: 'Q',
      answer: 'New',
      meta: {
        selectedModel: 'new-model',
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      },
    },
  ])
})

test('pushRecord removes stale metadata when a retry has no model or usage metadata', () => {
  const session = {
    isRetry: true,
    conversationRecords: [
      {
        question: 'Q',
        answer: 'Old',
        meta: { selectedModel: 'old-model' },
      },
    ],
  }

  pushRecord(session, 'Q', 'New')

  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'New' }])
})
