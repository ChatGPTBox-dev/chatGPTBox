import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canApplyTemperatureOverride,
  getTemperatureParams,
} from '../../../../src/services/apis/temperature-params.mjs'

test('temperature params require an explicit finite override', () => {
  assert.deepEqual(getTemperatureParams({}, 'gpt-4.1'), {})
  assert.deepEqual(
    getTemperatureParams({ temperatureOverrideEnabled: false, temperature: 0.7 }, 'gpt-4.1'),
    {},
  )
  assert.deepEqual(
    getTemperatureParams({ temperatureOverrideEnabled: true, temperature: Number.NaN }, 'gpt-4.1'),
    {},
  )
  assert.deepEqual(
    getTemperatureParams({ temperatureOverrideEnabled: true, temperature: 0 }, 'gpt-4.1'),
    { temperature: 0 },
  )
  assert.deepEqual(
    getTemperatureParams({ temperatureOverrideEnabled: true, temperature: 0.7 }, 'gpt-4.1'),
    { temperature: 0.7 },
  )
})

test('temperature overrides omit known Anthropic models across provider ID formats', () => {
  for (const model of [
    'claude-opus-4-7',
    'claude-opus-4-8',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-opus-4-8',
    'anthropic/claude-opus-4.8:free',
    'claude-opus-4-8-20260801',
    'claude-sonnet-5',
    'claude-opus-5',
  ]) {
    assert.equal(canApplyTemperatureOverride(model), false, model)
    assert.deepEqual(
      getTemperatureParams({ temperatureOverrideEnabled: true, temperature: 0.7 }, model),
      {},
      model,
    )
  }
  assert.equal(canApplyTemperatureOverride('claude-opus-4-6'), true)
})

test('temperature overrides omit Gemini models with deprecated sampling parameters', () => {
  for (const model of [
    'gemini-3.5-flash-lite',
    'google/gemini-3.5-flash-lite',
    'google/gemini-3-5-flash-lite',
    'google/gemini-3.5-flash-lite:free',
    'gemini-3-5-flash-lite-preview',
    'gemini-3.6-flash',
    'google/gemini-3.6-flash',
    'google/gemini-3-6-flash',
    'gemini-3.7-flash',
    'gemini-4-flash',
    'gemini-4:free',
  ]) {
    assert.equal(canApplyTemperatureOverride(model), false, model)
    assert.deepEqual(
      getTemperatureParams({ temperatureOverrideEnabled: true, temperature: 0.7 }, model),
      {},
      model,
    )
  }
})

test('Gemini version checks do not classify arbitrary numeric model names', () => {
  for (const model of ['gemini-4o', 'gemini-35b', 'gemini-3-6flash']) {
    assert.equal(canApplyTemperatureOverride(model), true, model)
    assert.deepEqual(
      getTemperatureParams({ temperatureOverrideEnabled: true, temperature: 0.7 }, model),
      { temperature: 0.7 },
      model,
    )
  }
})

test('temperature overrides remain available for earlier Gemini models', () => {
  for (const model of [
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash',
    'google/gemini-3.5-flash',
    'google/gemini-3-5-flash',
  ]) {
    assert.equal(canApplyTemperatureOverride(model), true, model)
    assert.deepEqual(
      getTemperatureParams({ temperatureOverrideEnabled: true, temperature: 0.7 }, model),
      { temperature: 0.7 },
      model,
    )
  }
})
