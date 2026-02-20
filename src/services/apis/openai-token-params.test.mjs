import test from 'node:test'
import assert from 'node:assert/strict'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'

test('uses max_completion_tokens for gpt-5.x chat models', () => {
  assert.deepEqual(getChatCompletionsTokenParams('openai', 'gpt-5.2-chat-latest', 1024), {
    max_completion_tokens: 1024,
  })
})

test('uses max_completion_tokens for provider-prefixed gpt-5.x models', () => {
  assert.deepEqual(getChatCompletionsTokenParams('openai', 'openai/gpt-5.2', 2048), {
    max_completion_tokens: 2048,
  })
})

test('uses max_completion_tokens for gpt-5 baseline model name', () => {
  assert.deepEqual(getChatCompletionsTokenParams('openai', 'gpt-5', 1536), {
    max_completion_tokens: 1536,
  })
})

test('uses max_tokens for non gpt-5 chat models', () => {
  assert.deepEqual(getChatCompletionsTokenParams('openai', 'gpt-4o', 512), {
    max_tokens: 512,
  })
})

test('uses max_tokens for lookalike model names', () => {
  assert.deepEqual(getChatCompletionsTokenParams('openai', 'my-gpt-5-clone', 640), {
    max_tokens: 640,
  })
})

test('uses max_tokens for empty model values', () => {
  assert.deepEqual(getChatCompletionsTokenParams('openai', '', 256), {
    max_tokens: 256,
  })
})

test('uses max_tokens for non OpenAI providers even with gpt-5 models', () => {
  assert.deepEqual(getChatCompletionsTokenParams('some-proxy-provider', 'openai/gpt-5.2', 257), {
    max_tokens: 257,
  })
})

test('uses max_completion_tokens for mixed-case OpenAI provider and model', () => {
  assert.deepEqual(getChatCompletionsTokenParams('OpenAI', 'GPT-5.1', 258), {
    max_completion_tokens: 258,
  })
})

test('uses max_tokens when provider is undefined', () => {
  assert.deepEqual(getChatCompletionsTokenParams(undefined, 'gpt-5.1', 259), {
    max_tokens: 259,
  })
})
