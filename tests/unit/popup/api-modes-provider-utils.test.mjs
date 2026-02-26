import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyPendingProviderChanges,
  buildEditedProvider,
  createProviderId,
  parseChatCompletionsEndpointUrl,
  resolveEditingProviderIdForGroupChange,
  resolveSelectableProviderId,
  resolveProviderChatEndpointUrl,
  shouldPersistPendingProviderChanges,
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

test('parseChatCompletionsEndpointUrl rejects non-http(s) schemes', () => {
  const ftpParsed = parseChatCompletionsEndpointUrl('ftp://api.example.com/v1/chat/completions')
  const fileParsed = parseChatCompletionsEndpointUrl('file:///v1/chat/completions')
  assert.equal(ftpParsed.valid, false)
  assert.equal(fileParsed.valid, false)
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

test('buildEditedProvider preserves existing provider endpoint shape when api url is unchanged', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl(
    'https://api.example.com/v1/chat/completions',
  )

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://api.example.com/v1/chat/completions',
  )

  assert.deepEqual(updatedProvider, {
    id: 'myproxy',
    name: 'My Proxy Updated',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
  })
})

test('buildEditedProvider rewrites endpoint fields when api url changes', () => {
  const existingProvider = {
    id: 'myproxy',
    name: 'My Proxy',
    baseUrl: 'https://api.example.com/v1',
    chatCompletionsPath: '/chat/completions',
    completionsPath: '/custom-completions',
    completionsUrl: 'https://api.example.com/v1/custom-completions',
  }
  const parsedEndpoint = parseChatCompletionsEndpointUrl(
    'https://proxy.example.com/v2/chat/completions',
  )

  const updatedProvider = buildEditedProvider(
    existingProvider,
    'myproxy',
    'My Proxy Updated',
    parsedEndpoint,
    'https://proxy.example.com/v2/chat/completions',
  )

  assert.equal(updatedProvider.id, 'myproxy')
  assert.equal(updatedProvider.name, 'My Proxy Updated')
  assert.equal(updatedProvider.baseUrl, '')
  assert.equal(updatedProvider.chatCompletionsUrl, 'https://proxy.example.com/v2/chat/completions')
  assert.equal(updatedProvider.completionsUrl, 'https://proxy.example.com/v2/completions')
})

test('resolveSelectableProviderId falls back when provider is missing or invalid', () => {
  const fallbackId = 'legacy-custom-default'
  const providers = [{ id: 'myproxy' }, { id: 'another-provider' }]

  assert.equal(resolveSelectableProviderId(' myproxy ', providers, fallbackId), 'myproxy')
  assert.equal(resolveSelectableProviderId('unknown-provider', providers, fallbackId), fallbackId)
  assert.equal(resolveSelectableProviderId('   ', providers, fallbackId), fallbackId)
})

test('applyPendingProviderChanges overlays edited providers and preserves order', () => {
  const providers = [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B' },
  ]

  const result = applyPendingProviderChanges(providers, {
    'provider-b': { id: 'provider-b', name: 'Provider B Updated' },
  })

  assert.deepEqual(result, [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B Updated' },
  ])
})

test('applyPendingProviderChanges appends a pending new provider', () => {
  const providers = [{ id: 'provider-a', name: 'Provider A' }]

  const result = applyPendingProviderChanges(
    providers,
    {},
    { id: 'provider-b', name: 'Provider B' },
  )

  assert.deepEqual(result, [
    { id: 'provider-a', name: 'Provider A' },
    { id: 'provider-b', name: 'Provider B' },
  ])
})

test('applyPendingProviderChanges prefers pending new provider when id already exists', () => {
  const providers = [{ id: 'provider-a', name: 'Provider A' }]

  const result = applyPendingProviderChanges(
    providers,
    {},
    { id: 'provider-a', name: 'Provider A Draft' },
  )

  assert.deepEqual(result, [{ id: 'provider-a', name: 'Provider A Draft' }])
})

test('shouldPersistPendingProviderChanges only persists provider changes for custom api modes', () => {
  assert.equal(shouldPersistPendingProviderChanges({ groupName: 'customApiModelKeys' }, true), true)
  assert.equal(shouldPersistPendingProviderChanges({ groupName: 'gptApiModelKeys' }, true), false)
  assert.equal(
    shouldPersistPendingProviderChanges({ groupName: 'customApiModelKeys' }, false),
    false,
  )
})

test('resolveEditingProviderIdForGroupChange preserves custom provider draft across type switches', () => {
  assert.equal(
    resolveEditingProviderIdForGroupChange('gptApiModelKeys', 'myproxy', 'legacy-custom-default'),
    'myproxy',
  )
  assert.equal(
    resolveEditingProviderIdForGroupChange(
      'customApiModelKeys',
      'myproxy',
      'legacy-custom-default',
    ),
    'myproxy',
  )
  assert.equal(
    resolveEditingProviderIdForGroupChange('customApiModelKeys', '', 'legacy-custom-default'),
    'legacy-custom-default',
  )
})
