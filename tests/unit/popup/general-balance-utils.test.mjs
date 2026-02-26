import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkBilling,
  formatFiniteBalance,
  getBalanceCacheKey,
  isOpenAIHostedBillingBaseUrl,
  normalizeBillingApiBaseUrl,
  resolveOpenAIBalanceContext,
  shouldOpenOpenAIUsageFallbackPage,
  shouldOpenOpenAIUsagePage,
} from '../../../src/popup/sections/general-balance-utils.mjs'

test('formatFiniteBalance formats finite numbers', () => {
  assert.equal(formatFiniteBalance(12.345), '12.35')
  assert.equal(formatFiniteBalance(0), '0.00')
  assert.equal(formatFiniteBalance('7.1'), '7.10')
})

test('formatFiniteBalance returns null for non-finite values', () => {
  assert.equal(formatFiniteBalance(undefined), null)
  assert.equal(formatFiniteBalance(null), null)
  assert.equal(formatFiniteBalance(''), null)
  assert.equal(formatFiniteBalance(NaN), null)
  assert.equal(formatFiniteBalance(Number.POSITIVE_INFINITY), null)
})

test('checkBilling returns null tuple when usage response is not ok', async () => {
  let fetchCount = 0
  const fetchImpl = async () => {
    fetchCount += 1
    if (fetchCount === 1) {
      return {
        ok: true,
        json: async () => ({ hard_limit_usd: 20 }),
      }
    }

    return {
      ok: false,
      json: async () => ({ error: { message: 'rate limited' } }),
    }
  }

  const billing = await checkBilling('sk-test', 'https://api.openai.com', fetchImpl)

  assert.deepEqual(billing, [null, null, null])
})

test('checkBilling returns null tuple when subscription amount is invalid', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ hard_limit_usd: null }),
  })

  const billing = await checkBilling('sk-test', 'https://api.openai.com', fetchImpl)

  assert.deepEqual(billing, [null, null, null])
})

test('checkBilling returns null tuple when usage amount is invalid', async () => {
  let fetchCount = 0
  const fetchImpl = async () => {
    fetchCount += 1
    if (fetchCount === 1) {
      return {
        ok: true,
        json: async () => ({ hard_limit_usd: 20 }),
      }
    }

    return {
      ok: true,
      json: async () => ({}),
    }
  }

  const billing = await checkBilling('sk-test', 'https://api.openai.com', fetchImpl)

  assert.deepEqual(billing, [null, null, null])
})

test('checkBilling returns computed amounts on happy path', async () => {
  let fetchCount = 0
  const fetchImpl = async () => {
    fetchCount += 1
    if (fetchCount === 1) {
      return {
        ok: true,
        json: async () => ({ hard_limit_usd: 20 }),
      }
    }

    return {
      ok: true,
      json: async () => ({ total_usage: 1234 }),
    }
  }

  const billing = await checkBilling('sk-test', 'https://api.openai.com', fetchImpl)

  assert.deepEqual(billing, [20, 12.34, 7.66])
})

test('normalizeBillingApiBaseUrl strips a trailing v1 suffix once', () => {
  assert.equal(normalizeBillingApiBaseUrl('https://api.openai.com'), 'https://api.openai.com')
  assert.equal(
    normalizeBillingApiBaseUrl('https://proxy.example.com/v1'),
    'https://proxy.example.com',
  )
  assert.equal(
    normalizeBillingApiBaseUrl('https://proxy.example.com/v1/'),
    'https://proxy.example.com',
  )
  assert.equal(
    normalizeBillingApiBaseUrl('https://proxy.example.com/V1'),
    'https://proxy.example.com',
  )
})

test('shouldOpenOpenAIUsagePage returns true for OpenAI provider or OpenAI source provider', () => {
  assert.equal(shouldOpenOpenAIUsagePage('openai'), true)
  assert.equal(shouldOpenOpenAIUsagePage('materialized-openai-mode', 'openai'), true)
  assert.equal(shouldOpenOpenAIUsagePage('deepseek'), false)
  assert.equal(shouldOpenOpenAIUsagePage('materialized-deepseek-mode', 'deepseek'), false)
  assert.equal(shouldOpenOpenAIUsagePage('legacy-custom-default'), false)
  assert.equal(shouldOpenOpenAIUsagePage('', ''), false)
})

test('isOpenAIHostedBillingBaseUrl only accepts OpenAI hosts', () => {
  assert.equal(isOpenAIHostedBillingBaseUrl('https://api.openai.com'), true)
  assert.equal(isOpenAIHostedBillingBaseUrl('https://platform.openai.com'), true)
  assert.equal(isOpenAIHostedBillingBaseUrl('https://foo.openai.com/v1'), true)
  assert.equal(isOpenAIHostedBillingBaseUrl('https://proxy.example.com'), false)
  assert.equal(isOpenAIHostedBillingBaseUrl(''), false)
  assert.equal(isOpenAIHostedBillingBaseUrl('not-a-url'), false)
})

test('shouldOpenOpenAIUsageFallbackPage preserves supported OpenAI fallback paths', () => {
  assert.equal(shouldOpenOpenAIUsageFallbackPage('openai', '', 'https://api.openai.com'), true)
  assert.equal(shouldOpenOpenAIUsageFallbackPage('openai', '', 'https://gateway.example.com'), true)
  assert.equal(
    shouldOpenOpenAIUsageFallbackPage(
      'materialized-openai-mode',
      'openai',
      'https://api.openai.com',
    ),
    true,
  )
  assert.equal(
    shouldOpenOpenAIUsageFallbackPage(
      'materialized-openai-mode',
      'openai',
      'https://gateway.example.com',
    ),
    false,
  )
  assert.equal(
    shouldOpenOpenAIUsageFallbackPage(
      'materialized-openai-mode',
      'openai',
      'https://gateway.example.com',
      true,
    ),
    true,
  )
  assert.equal(shouldOpenOpenAIUsageFallbackPage('deepseek', '', 'https://api.openai.com'), false)
})

test('getBalanceCacheKey changes when provider, api key, or base url changes', () => {
  assert.notEqual(
    getBalanceCacheKey('openai', 'sk-a', 'https://api.openai.com'),
    getBalanceCacheKey('openai', 'sk-b', 'https://api.openai.com'),
  )
  assert.notEqual(
    getBalanceCacheKey('openai', 'sk-a', 'https://api.openai.com'),
    getBalanceCacheKey('proxy', 'sk-a', 'https://api.openai.com'),
  )
  assert.notEqual(
    getBalanceCacheKey('openai', 'sk-a', 'https://api.openai.com'),
    getBalanceCacheKey('openai', 'sk-a', 'https://proxy.example.com'),
  )
  assert.equal(
    getBalanceCacheKey(' openai ', ' sk-a ', ' https://api.openai.com/ '),
    getBalanceCacheKey('openai', 'sk-a', 'https://api.openai.com'),
  )
  assert.equal(getBalanceCacheKey('openai', 'sk-a'), getBalanceCacheKey('openai', 'sk-a', ''))
})

test('resolveOpenAIBalanceContext prefers standard chat explicit endpoint url', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'materialized-openai-mode',
      endpointType: 'chat',
      provider: {
        id: 'materialized-openai-mode',
        sourceProviderId: 'openai',
        chatCompletionsUrl: 'https://proxy.example.com/v1/chat/completions',
        baseUrl: 'https://ignored.example.com/v1',
      },
    },
    '',
    'https://fallback.example.com/v1',
  )

  assert.equal(resolved.providerId, 'materialized-openai-mode')
  assert.equal(resolved.sourceProviderId, 'openai')
  assert.equal(resolved.apiBaseUrl, 'https://proxy.example.com')
})

test('resolveOpenAIBalanceContext prefers standard completion explicit endpoint url', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'materialized-openai-mode',
      endpointType: 'completion',
      provider: {
        id: 'materialized-openai-mode',
        sourceProviderId: 'openai',
        completionsUrl: 'https://proxy.example.com/v1/completions',
        baseUrl: 'https://ignored.example.com/v1',
      },
    },
    '',
    'https://fallback.example.com/v1',
  )

  assert.equal(resolved.apiBaseUrl, 'https://proxy.example.com')
})

test('resolveOpenAIBalanceContext falls back to provider baseUrl for non-standard endpoint url', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'materialized-openai-mode',
      endpointType: 'chat',
      provider: {
        id: 'materialized-openai-mode',
        sourceProviderId: 'openai',
        chatCompletionsUrl: 'https://proxy.example.com/v1/messages',
        baseUrl: 'https://provider.example.com/v1',
      },
    },
    '',
    'https://fallback.example.com/v1',
  )

  assert.equal(resolved.apiBaseUrl, 'https://provider.example.com')
})

test('resolveOpenAIBalanceContext prefers recovered requestUrl when it is standard compat endpoint', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'legacy-custom-default',
      endpointType: 'chat',
      requestUrl: 'https://saved-openai.example.com/v1/chat/completions',
      provider: {
        id: 'legacy-custom-default',
        baseUrl: 'https://api.openai.com/v1',
      },
    },
    'openai',
    'https://fallback.example.com/v1',
  )

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.apiBaseUrl, 'https://saved-openai.example.com')
})

test('resolveOpenAIBalanceContext falls back to selected mode source lineage for legacy custom default', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'legacy-custom-default',
      endpointType: 'chat',
      provider: {
        id: 'legacy-custom-default',
        baseUrl: 'https://api.openai.com/v1',
      },
    },
    'legacy-custom-default',
    'https://fallback.example.com/v1',
    'openai',
  )

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.sourceProviderId, 'openai')
  assert.equal(resolved.apiBaseUrl, 'https://api.openai.com')
})

test('resolveOpenAIBalanceContext keeps resolved provider lineage ahead of selected mode fallback', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'materialized-openai-mode',
      endpointType: 'chat',
      provider: {
        id: 'materialized-openai-mode',
        sourceProviderId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      },
    },
    '',
    'https://fallback.example.com/v1',
    'azureOpenAi',
  )

  assert.equal(resolved.providerId, 'materialized-openai-mode')
  assert.equal(resolved.sourceProviderId, 'openai')
})

test('resolveOpenAIBalanceContext ignores non-standard recovered requestUrl for billing base', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'legacy-custom-default',
      endpointType: 'chat',
      requestUrl: 'https://saved-openai.example.com/v1/messages',
      provider: {
        id: 'legacy-custom-default',
        baseUrl: 'https://api.openai.com/v1',
      },
    },
    'openai',
    'https://fallback.example.com/v1',
  )

  assert.equal(resolved.apiBaseUrl, 'https://api.openai.com')
})

test('resolveOpenAIBalanceContext uses secret target id for recovered legacy custom default', () => {
  const resolved = resolveOpenAIBalanceContext(
    {
      providerId: 'legacy-custom-default',
      endpointType: 'chat',
      provider: {
        id: 'legacy-custom-default',
        baseUrl: 'https://api.openai.com/v1',
      },
    },
    'openai',
    'https://fallback.example.com/v1',
  )

  assert.equal(resolved.providerId, 'openai')
  assert.equal(resolved.sourceProviderId, '')
  assert.equal(resolved.apiBaseUrl, 'https://api.openai.com')
})
