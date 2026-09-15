import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergeClaudeResponseMetadata,
  mergeOpenAIResponseMetadata,
  mergeResponseMetadata,
  summarizeConversationUsage,
} from '../../../src/utils/usage-metadata.mjs'

test('OpenAI metadata keeps request and reported models separate', () => {
  let metadata = { selectedModel: 'openrouter/auto' }
  metadata = mergeOpenAIResponseMetadata(
    metadata,
    {
      model: 'anthropic/claude-sonnet-5',
      usage: {
        prompt_tokens: 90,
        completion_tokens: 10,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 15 },
      },
    },
    'openrouter/auto',
  )

  assert.deepEqual(metadata, {
    selectedModel: 'openrouter/auto',
    reportedModel: 'anthropic/claude-sonnet-5',
    usage: {
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 15,
    },
  })
})

test('OpenAI metadata distinguishes zero cached tokens from an unavailable field', () => {
  const zeroCache = mergeOpenAIResponseMetadata(
    { selectedModel: 'gpt-test' },
    {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
    'gpt-test',
  )
  const unavailableCache = mergeOpenAIResponseMetadata(
    { selectedModel: 'gpt-test' },
    { usage: { prompt_tokens: 10, completion_tokens: 2 } },
    'gpt-test',
  )

  assert.equal(zeroCache.usage.cacheReadInputTokens, 0)
  assert.equal(Object.hasOwn(unavailableCache.usage, 'cacheReadInputTokens'), false)
})

test('Claude metadata counts cache reads and writes as input tokens', () => {
  let metadata = mergeClaudeResponseMetadata(
    { selectedModel: 'claude-sonnet-5' },
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
      usage: { input_tokens: 0, output_tokens: 6 },
    },
    'claude-sonnet-5',
  )

  assert.deepEqual(metadata, {
    selectedModel: 'claude-sonnet-5',
    reportedModel: 'claude-sonnet-5-20260801',
    usage: {
      inputTokens: 60,
      outputTokens: 6,
      totalTokens: 66,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 30,
    },
  })
})

test('metadata merge does not replace a stable selected model with display text', () => {
  assert.deepEqual(
    mergeResponseMetadata(
      { selectedModel: 'gpt-5.6' },
      { reportedModel: 'gpt-5.6-20260801' },
    ),
    {
      selectedModel: 'gpt-5.6',
      reportedModel: 'gpt-5.6-20260801',
    },
  )
})

test('conversation summary preserves per-field coverage and model history', () => {
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
    { question: 'legacy', answer: 'record' },
  ])

  assert.equal(summary.totalTurns, 3)
  assert.equal(summary.reportedTurns, 2)
  assert.equal(summary.inputTokens, 150)
  assert.equal(summary.outputTokens, 30)
  assert.equal(summary.cacheReadInputTokens, 40)
  assert.deepEqual(summary.models, [
    { name: 'model-a', turns: 1 },
    { name: 'model-b', turns: 1 },
  ])
})
