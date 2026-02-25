import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProviderId,
  parseChatCompletionsEndpointUrl,
  resolveProviderChatEndpointUrl,
} from '../../../src/popup/sections/api-modes-provider-utils.mjs'

test('createProviderId avoids reserved and existing ids', () => {
  const existingProviders = [{ id: 'foo' }, { id: 'foo-2' }]
  const reservedProviderIds = ['openai', 'deepseek']

  assert.equal(createProviderId('OpenAI', existingProviders, reservedProviderIds), 'openai-2')
  assert.equal(createProviderId('Foo', existingProviders, reservedProviderIds), 'foo-3')
})

test('parseChatCompletionsEndpointUrl accepts full chat endpoint url', () => {
  const parsed = parseChatCompletionsEndpointUrl('https://api.example.com/v1/chat/completions/')

  assert.equal(parsed.valid, true)
  assert.equal(parsed.chatCompletionsUrl, 'https://api.example.com/v1/chat/completions')
  assert.equal(parsed.completionsUrl, 'https://api.example.com/v1/completions')
})

test('parseChatCompletionsEndpointUrl rejects non-chat endpoint url', () => {
  const parsed = parseChatCompletionsEndpointUrl('https://api.example.com/v1')
  assert.equal(parsed.valid, false)
})

test('parseChatCompletionsEndpointUrl keeps query string when deriving completions endpoint', () => {
  const parsed = parseChatCompletionsEndpointUrl(
    'https://api.example.com/v1/chat/completions?api-version=1',
  )
  assert.equal(parsed.valid, true)
  assert.equal(
    parsed.chatCompletionsUrl,
    'https://api.example.com/v1/chat/completions?api-version=1',
  )
  assert.equal(parsed.completionsUrl, 'https://api.example.com/v1/completions?api-version=1')
})

test('resolveProviderChatEndpointUrl prefers explicit chatCompletionsUrl', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    chatCompletionsUrl: 'https://proxy.example.com/chat/completions',
  })

  assert.equal(endpoint, 'https://proxy.example.com/chat/completions')
})

test('resolveProviderChatEndpointUrl builds endpoint from baseUrl and path', () => {
  const endpoint = resolveProviderChatEndpointUrl({
    baseUrl: 'https://api.example.com/v1/',
    chatCompletionsPath: 'chat/completions',
    chatCompletionsUrl: '',
  })

  assert.equal(endpoint, 'https://api.example.com/v1/chat/completions')
})
