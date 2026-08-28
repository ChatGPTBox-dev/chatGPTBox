import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createRecordMetadata,
  mergeClaudeResponseMetadata,
  mergeOpenAIResponseMetadata,
  summarizeConversationUsage,
} from '../../../src/utils/usage-metadata.mjs'

test('OpenAI metadata merges the reported model and final usage block', () => {
  let metadata = mergeOpenAIResponseMetadata(
    null,
    {
      model: 'gpt-5.6-2026-08-01',
      choices: [{ delta: { content: 'Hello' } }],
    },
    'gpt-5.6',
  )

  metadata = mergeOpenAIResponseMetadata(
    metadata,
    {
      choices: [],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: {
          cached_tokens: 80,
          cache_write_tokens: 20,
        },
      },
    },
    'gpt-5.6',
  )

  assert.deepEqual(metadata, {
    selectedModel: 'gpt-5.6',
    reportedModel: 'gpt-5.6-2026-08-01',
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 20,
    },
  })
})

test('OpenAI metadata distinguishes zero cached tokens from an unavailable field', () => {
  const zeroCacheMetadata = mergeOpenAIResponseMetadata(
    null,
    {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
    'gpt-test',
  )
  const unavailableCacheMetadata = mergeOpenAIResponseMetadata(
    null,
    {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
      },
    },
    'gpt-test',
  )

  assert.equal(zeroCacheMetadata.usage.cacheReadInputTokens, 0)
  assert.equal(Object.hasOwn(unavailableCacheMetadata.usage, 'cacheReadInputTokens'), false)
})

test('Claude metadata treats cache reads and writes as parts of the full input', () => {
  let metadata = mergeClaudeResponseMetadata(
    null,
    {
      type: 'message_start',
      message: {
        model: 'claude-sonnet-5-20260801',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
          output_tokens: 1,
        },
      },
    },
    'claude-sonnet-5',
  )

  metadata = mergeClaudeResponseMetadata(
    metadata,
    {
      type: 'message_delta',
      usage: {
        input_tokens: 0,
        output_tokens: 5,
      },
    },
    'claude-sonnet-5',
  )

  assert.deepEqual(metadata, {
    selectedModel: 'claude-sonnet-5',
    reportedModel: 'claude-sonnet-5-20260801',
    usage: {
      inputTokens: 60,
      outputTokens: 5,
      totalTokens: 65,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 30,
    },
  })
})

test('record metadata falls back to the session model label', () => {
  assert.deepEqual(createRecordMetadata({ aiName: 'OpenAI (GPT-5.6)' }, null), {
    selectedModel: 'OpenAI (GPT-5.6)',
  })
  assert.equal(createRecordMetadata({}, null), null)
})

test('conversation summary totals only complete reported usage and preserves model history', () => {
  const summary = summarizeConversationUsage([
    {
      question: 'one',
      answer: 'a',
      meta: {
        selectedModel: 'router/auto',
        reportedModel: 'model-a',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 40,
        },
      },
    },
    {
      question: 'two',
      answer: 'b',
      meta: {
        selectedModel: 'model-b',
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 15,
        },
      },
    },
    {
      question: 'three',
      answer: 'c',
      meta: {
        selectedModel: 'model-b',
        usage: { outputTokens: 4 },
      },
    },
    { question: 'legacy', answer: 'record' },
  ])

  assert.deepEqual(summary, {
    totalTurns: 4,
    reportedTurns: 3,
    inputReportedTurns: 2,
    outputReportedTurns: 3,
    totalReportedTurns: 2,
    cacheReadReportedTurns: 2,
    cacheWriteReportedTurns: 1,
    inputTokens: 150,
    outputTokens: 34,
    totalTokens: 180,
    cacheReadInputTokens: 40,
    cacheWriteInputTokens: 15,
    models: [
      { name: 'model-a', turns: 1 },
      { name: 'model-b', turns: 2 },
    ],
  })
})
