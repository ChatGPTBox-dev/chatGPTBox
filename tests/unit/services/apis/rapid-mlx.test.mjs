import assert from 'node:assert/strict'
import test from 'node:test'
import { isUsingRapidMlxApiModel } from '../../../../src/config/index.mjs'
import { resolveOpenAICompatibleRequest } from '../../../../src/services/apis/provider-registry.mjs'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  modelNameToDesc,
} from '../../../../src/utils/model-name-convert.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const apiMode = {
  groupName: 'rapidMlxApiModelKeys',
  itemName: 'rapidMlxModel',
  customName: 'served/model-id',
  isCustom: false,
  active: true,
}

for (const endpoint of [undefined, '', '  ', 'http://127.0.0.1:8000/v1/']) {
  test(`Rapid-MLX resolves the default versioned endpoint (${JSON.stringify(endpoint)})`, () => {
    const request = resolveOpenAICompatibleRequest({ rapidMlxEndpoint: endpoint }, { apiMode })
    assert.equal(request.providerId, 'rapid-mlx')
    assert.equal(request.requestUrl, 'http://127.0.0.1:8000/v1/chat/completions')
    assert.equal(request.apiKey, '')
  })
}

test('Rapid-MLX uses the manually configured model and provider label', () => {
  assert.equal(apiModeToModelName(apiMode), 'rapidMlxApiModelKeys-served/model-id')
  assert.equal(modelNameToDesc(apiModeToModelName(apiMode)), 'Rapid-MLX (API) (served/model-id)')
})

for (const key of ['', 'optional-secret']) {
  test(`Rapid-MLX streams chat with ${
    key ? 'an optional key' : 'no authorization header'
  }`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    const config = {
      rapidMlxEndpoint: 'http://127.0.0.1:8012/v1/',
      providerSecrets: { 'rapid-mlx': key },
      maxConversationContextLength: 3,
      maxResponseTokenLength: 128,
      temperatureOverrideEnabled: false,
      temperature: 1,
    }
    const session = { apiMode, modelName: apiModeToModelName(apiMode), conversationRecords: [] }
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, init })
      return createMockSseResponse([
        'data: {"choices":[{"delta":{"content":"Local"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" reply"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    })
    const port = createFakePort()
    await generateAnswersWithOpenAICompatibleApi(port, 'Hello', session, config)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'http://127.0.0.1:8012/v1/chat/completions')
    assert.equal(requests[0].init.headers.Authorization, key ? `Bearer ${key}` : undefined)
    const body = JSON.parse(requests[0].init.body)
    assert.equal(body.model, 'served/model-id')
    assert.equal(body.stream, true)
    assert.deepEqual(session.conversationRecords.at(-1), {
      question: 'Hello',
      answer: 'Local reply',
    })
  })
}

test('Rapid-MLX routes API modes and model-name-only sessions', () => {
  const modelName = apiModeToModelName(apiMode)
  assert.equal(isUsingRapidMlxApiModel({ apiMode }), true)
  assert.equal(isUsingRapidMlxApiModel({ modelName }), true)
  assert.equal(isUsingRapidMlxApiModel({ modelName: 'ollamaModel-llama4' }), false)
  assert.equal(resolveOpenAICompatibleRequest({}, { modelName }).providerId, 'rapid-mlx')
})

for (const customName of ['', '   ']) {
  test(`Rapid-MLX keeps a blank model row available for editing (${JSON.stringify(
    customName,
  )})`, () => {
    const blankMode = { ...apiMode, customName }
    const modes = getApiModesFromConfig({ customApiModes: [blankMode] }, false)
    assert.equal(modes.length, 1)
    assert.equal(modes[0].customName, customName)
    assert.equal(modes[0].groupName, 'rapidMlxApiModelKeys')
  })
}
