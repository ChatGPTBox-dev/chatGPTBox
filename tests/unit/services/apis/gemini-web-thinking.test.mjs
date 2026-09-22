import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getGeminiModelSelection,
  requestGeminiText,
} from '../../../../src/services/apis/gemini-web-transport.mjs'

const params = {
  at: 'test-at',
  accountPath: '',
  language: 'en',
}

function framed(records) {
  const payload = JSON.stringify(records)
  return `)]}'\n\n${payload.length + 2}\n${payload}\n`
}

function modelEntry(id, category, displayName, modelNumber) {
  const entry = Array(18).fill(null)
  entry[0] = id
  entry[1] = category
  entry[11] = displayName
  entry[17] = modelNumber
  return entry
}

function modeEntry(modeNumber, displayName, available = true) {
  const info = Array(8).fill(null)
  info[1] = modeNumber
  info[4] = displayName
  info[7] = available
  return [info]
}

function discovery({ models = [], modes = [], tiers = [8], capabilities = [] } = {}) {
  const status = Array(25).fill(null)
  status[14] = 1000
  status[15] = models
  status[16] = tiers
  status[17] = capabilities
  status[24] = [null, modes]
  return framed([['wrb.fr', 'otAQ7b', JSON.stringify(status)]])
}

function mockDiscovery(t, responseText) {
  t.mock.method(globalThis, 'fetch', async () => new Response(responseText))
}

test('prefers an account-discovered model-number 5 for standalone Thinking', async (t) => {
  mockDiscovery(
    t,
    discovery({
      models: [modelEntry('dynamic-thinking-id', 'Thinking', 'Gemini Thinking', 5)],
    }),
  )

  const selection = await getGeminiModelSelection('thinking', params, false)
  const header = JSON.parse(selection.headers['x-goog-ext-525001261-jspb'])
  assert.equal(selection.modelNumber, 5)
  assert.equal(selection.standaloneThinking, true)
  assert.equal(header[4], 'dynamic-thinking-id')
  assert.equal(header[11], 2)
  assert.equal(header[14], 5)
})

test('mode-picker Thinking supports capacity-field 13 and numeric availability', async (t) => {
  mockDiscovery(
    t,
    discovery({
      modes: [modeEntry(5, 'Thinking', 1)],
      tiers: [22],
    }),
  )

  const selection = await getGeminiModelSelection('thinking', params, false)
  const header = JSON.parse(selection.headers['x-goog-ext-525001261-jspb'])
  assert.equal(selection.modelNumber, 5)
  assert.equal(header[4], 'e051ce1aa80aa576')
  assert.equal(header[12], 2)
  assert.equal(header[15], 5)
})

test('mode-picker Thinking still fails closed for an unmapped capacity', async (t) => {
  mockDiscovery(
    t,
    discovery({
      modes: [modeEntry(5, 'Thinking')],
      tiers: [16],
    }),
  )

  await assert.rejects(
    getGeminiModelSelection('thinking', params, false),
    /selected model is not available/,
  )
})

test('a superseded request stops after model discovery before the prompt POST', async (t) => {
  let fetchCount = 0
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1
    return new Response(
      discovery({
        models: [modelEntry('flash-id', 'Flash', 'Gemini Flash', 1)],
      }),
    )
  })
  let freshnessChecks = 0

  await assert.rejects(
    requestGeminiText(
      'Q',
      {},
      params,
      {
        model: 'flash',
        isRequestCurrent: () => {
          freshnessChecks += 1
          return freshnessChecks === 1
        },
      },
      undefined,
    ),
    { name: 'AbortError' },
  )

  assert.equal(fetchCount, 1)
})
