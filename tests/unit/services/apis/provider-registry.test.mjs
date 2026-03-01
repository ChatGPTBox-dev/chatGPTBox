import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveEndpointTypeForSession,
  resolveOpenAICompatibleRequest,
} from '../../../../src/services/apis/provider-registry.mjs'

test('resolveEndpointTypeForSession prefers apiMode when present', () => {
  const session = {
    apiMode: {
      groupName: 'chatgptApiModelKeys',
      itemName: 'gpt-4o-mini',
    },
    modelName: 'gptApiInstruct',
  }

  assert.equal(resolveEndpointTypeForSession(session), 'chat')
})

test('resolveEndpointTypeForSession returns completion for gptApiModelKeys apiMode', () => {
  const session = {
    apiMode: {
      groupName: 'gptApiModelKeys',
      itemName: 'text-davinci-003',
    },
    modelName: 'chatgptApi4oMini',
  }

  assert.equal(resolveEndpointTypeForSession(session), 'completion')
})

test('resolveEndpointTypeForSession falls back to legacy modelName when apiMode is missing', () => {
  const session = {
    modelName: 'gptApiInstruct-text-davinci-003',
  }

  assert.equal(resolveEndpointTypeForSession(session), 'completion')
})

test('resolveOpenAICompatibleRequest resolves custom provider from normalized session provider id', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'myproxy',
        name: 'My Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      myproxy: 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: ' MyProxy ',
      customName: 'proxy-model',
      customUrl: '',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'myproxy')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})

test('resolveOpenAICompatibleRequest resolves custom provider by legacy customUrl when session provider id is stale', () => {
  const config = {
    customOpenAIProviders: [
      {
        id: 'openai-2',
        name: 'Legacy OpenAI Proxy',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        enabled: true,
      },
    ],
    providerSecrets: {
      'openai-2': 'proxy-key',
    },
  }
  const session = {
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'OpenAI',
      customName: 'proxy-model',
      customUrl: 'https://proxy.example.com/v1/chat/completions/',
    },
  }

  const resolved = resolveOpenAICompatibleRequest(config, session)

  assert.equal(resolved.providerId, 'openai-2')
  assert.equal(resolved.requestUrl, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(resolved.apiKey, 'proxy-key')
})
