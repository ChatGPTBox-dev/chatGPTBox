import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatFiniteBalance,
  normalizeBillingApiBaseUrl,
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

test('shouldOpenOpenAIUsagePage only returns true for OpenAI provider', () => {
  assert.equal(shouldOpenOpenAIUsagePage('openai'), true)
  assert.equal(shouldOpenOpenAIUsagePage('deepseek'), false)
  assert.equal(shouldOpenOpenAIUsagePage('legacy-custom-default'), false)
  assert.equal(shouldOpenOpenAIUsagePage(''), false)
})
