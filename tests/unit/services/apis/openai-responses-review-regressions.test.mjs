import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { getUserConfig } from '../../../../src/config/index.mjs'
import { initSession } from '../../../../src/services/init-session.mjs'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import { generateAnswersWithOpenAIResponses } from '../../../../src/services/apis/openai-responses-core.mjs'
import { resolveOpenAICompatibleRequest } from '../../../../src/services/apis/provider-registry.mjs'
import { buildSelectedModeProviderSecretOverrideUpdate } from '../../../../src/popup/sections/provider-secret-utils.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const chatUrl = 'https://chat.example/v1/chat/completions'
const responsesUrl = 'https://responses.example/custom/respond'

beforeEach((t) => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
})

async function fixture({ providerProtocol, sessionProtocol, globalProtocol = 'chat' } = {}) {
  const apiMode = {
    groupName: 'customApiModelKeys',
    itemName: 'customModel',
    isCustom: true,
    providerId: 'review-proxy',
    customName: 'gpt-4o',
    active: true,
    ...(sessionProtocol ? { apiProtocol: sessionProtocol } : {}),
  }
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage({
    openaiApiProtocol: globalProtocol,
    apiMode,
    customApiModes: [apiMode],
    customOpenAIProviders: [
      {
        id: 'review-proxy',
        name: 'Review proxy',
        sourceProviderId: 'openai',
        chatCompletionsUrl: chatUrl,
        responsesUrl,
        ...(providerProtocol ? { apiProtocol: providerProtocol } : {}),
      },
    ],
    providerSecrets: { 'review-proxy': 'test-key' },
  })
  const config = await getUserConfig()
  const session = initSession({ modelName: 'customModel', apiMode: config.apiMode })
  return { config, session, port: createFakePort() }
}

for (const [name, settings, expectedUrl] of [
  ['global Responses respects explicit endpoint', { globalProtocol: 'responses' }, responsesUrl],
  [
    'session Chat overrides provider Responses',
    { sessionProtocol: 'chat', providerProtocol: 'responses' },
    chatUrl,
  ],
  [
    'session Chat overrides global Responses',
    { sessionProtocol: ' ChAt ', globalProtocol: 'responses' },
    chatUrl,
  ],
  [
    'session Chat overrides both Responses settings',
    { sessionProtocol: 'chat', providerProtocol: 'responses', globalProtocol: 'responses' },
    chatUrl,
  ],
  ['session Responses overrides provider Chat', { sessionProtocol: ' ReSpOnSeS ' }, responsesUrl],
]) {
  test(name, async (t) => {
    const { config, session, port } = await fixture(settings)
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
      return createMockSseResponse([
        expectedUrl === chatUrl
          ? 'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n'
          : 'data: {"type":"response.completed","response":{"output_text":"Answer"}}\n\n',
      ])
    })

    await generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)

    assert.deepEqual(
      calls.map(({ url }) => url),
      [expectedUrl],
    )
    assert.equal(calls[0].headers.Authorization, 'Bearer test-key')
    assert.equal(Object.hasOwn(calls[0].body, 'messages'), expectedUrl === chatUrl)
    assert.equal(Object.hasOwn(calls[0].body, 'input'), expectedUrl === responsesUrl)
    if (settings.sessionProtocol) {
      assert.equal(
        resolveOpenAICompatibleRequest(config, session).apiProtocol,
        settings.sessionProtocol.trim().toLowerCase(),
      )
    }
    assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'Answer' }])
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const [name, chunks, error] of [
  [
    'EOF after partial text',
    ['data: {"type":"response.output_text.delta","delta":"Partial"}\n\n'],
    /ended before completion/i,
  ],
  ['EOF after creation', ['data: {"type":"response.created"}\n\n'], /ended before completion/i],
  ['HTML body', ['<html>upstream unavailable</html>'], /ended before completion/i],
  [
    'JSON error object',
    ['{"error":{"message":"Insufficient quota","code":"insufficient_quota"}}'],
    /Insufficient quota/,
  ],
  ['JSON error string', ['{"error":"Upstream failed"}'], /Upstream failed/],
  ['JSON error code', ['{"error":{"code":"server_error"}}'], /Responses API request failed/],
  ...['queued', 'in_progress', 'cancelled'].map((status) => [
    `JSON ${status} status`,
    [JSON.stringify({ object: 'response', status, error: null, output: [] })],
    new RegExp(status),
  ]),
]) {
  test(`${name} preserves the original retry answer and does not finish`, async (t) => {
    const port = createFakePort()
    const records = [{ question: 'Q', answer: 'Original answer' }]
    const session = { conversationRecords: structuredClone(records), isRetry: true }
    t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(chunks))

    await assert.rejects(
      generateAnswersWithOpenAIResponses({
        port,
        question: 'Q',
        session,
        requestUrl: responsesUrl,
        model: 'gpt-4o',
        config: {},
      }),
      error,
    )

    assert.deepEqual(session.conversationRecords, records)
    assert.equal(
      port.postedMessages.some((message) => message.done || message.session),
      false,
    )
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const ending of ['', 'data: {"error":{"message":"Unknown URL /v1/responses"}}\n\n']) {
  test(`mid-stream failure does not trigger Chat fallback: ${JSON.stringify(
    ending,
  )}`, async (t) => {
    const { config, session, port } = await fixture({ providerProtocol: 'responses' })
    const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
      createMockSseResponse([
        'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
        ending,
      ]),
    )

    await assert.rejects(
      generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config),
      /ended before completion|Unknown URL/i,
    )

    assert.equal(fetchMock.mock.callCount(), 1)
    assert.deepEqual(session.conversationRecords, [])
    assert.equal(
      port.postedMessages.some((message) => message.done),
      false,
    )
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const ending of [
  'data: {"type":"response.completed"}\n\n',
  'data: {"type":"response.incomplete"}\n\n',
  'data: [DONE]\n\n',
]) {
  test(`terminal event still saves partial output once: ${ending.trim()}`, async (t) => {
    const port = createFakePort()
    const session = { conversationRecords: [] }
    t.mock.method(globalThis, 'fetch', async () =>
      createMockSseResponse([
        'data: {"type":"response.output_text.delta","delta":"Answer"}\n\n',
        ending,
      ]),
    )
    await generateAnswersWithOpenAIResponses({
      port,
      question: 'Q',
      session,
      requestUrl: responsesUrl,
      model: 'gpt-4o',
      config: {},
    })
    assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'Answer' }])
    assert.equal(port.postedMessages.filter((message) => message.done).length, 1)
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const status of ['completed', 'incomplete']) {
  test(`split JSON ${status} response still saves via the synthetic DONE marker`, async (t) => {
    const port = createFakePort()
    const session = { conversationRecords: [] }
    const json = JSON.stringify({ status, error: null, output_text: 'Answer' })
    t.mock.method(globalThis, 'fetch', async () =>
      createMockSseResponse([json.slice(0, 15), json.slice(15)]),
    )
    await generateAnswersWithOpenAIResponses({
      port,
      question: 'Q',
      session,
      requestUrl: responsesUrl,
      model: 'gpt-4o',
      config: {},
    })
    assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'Answer' }])
    assert.equal(port.postedMessages.filter((message) => message.done).length, 1)
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

test('explicit protocol normalization distinguishes inheritance from Chat', async () => {
  const { normalizeExplicitApiProtocol } = await import(
    '../../../../src/services/apis/provider-registry.mjs'
  )
  for (const value of [undefined, null, '', 'default', 'other']) {
    assert.equal(normalizeExplicitApiProtocol(value), undefined)
  }
  assert.equal(normalizeExplicitApiProtocol(' ChAt '), 'chat')
  assert.equal(normalizeExplicitApiProtocol(' ReSpOnSeS '), 'responses')
})

for (const [providerProtocol, sessionProtocol, expectedUrl] of [
  ['chat', undefined, chatUrl],
  ['chat', 'responses', responsesUrl],
  [undefined, undefined, responsesUrl],
  ['default', undefined, responsesUrl],
]) {
  test(`stored provider protocol ${providerProtocol} with session ${sessionProtocol} respects priority`, async (t) => {
    const { config, session, port } = await fixture({
      providerProtocol,
      sessionProtocol,
      globalProtocol: 'responses',
    })
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return createMockSseResponse([
        expectedUrl === chatUrl
          ? 'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n'
          : 'data: {"type":"response.completed","response":{"output_text":"Answer"}}\n\n',
      ])
    })
    await generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)
    assert.deepEqual(
      calls.map(({ url }) => url),
      [expectedUrl],
    )
    assert.equal(Object.hasOwn(calls[0].body, 'messages'), expectedUrl === chatUrl)
    const storedProvider = globalThis.__TEST_BROWSER_SHIM__.getStorage().customOpenAIProviders[0]
    assert.equal(storedProvider.apiProtocol, providerProtocol === 'chat' ? 'chat' : undefined)
    assert.equal(
      resolveOpenAICompatibleRequest(config, session).provider.apiProtocol,
      storedProvider.apiProtocol,
    )
    assert.deepEqual((await getUserConfig()).customOpenAIProviders, config.customOpenAIProviders)
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const apiProtocol of [undefined, 'chat', 'responses']) {
  test(`secret override materialization preserves provider protocol ${apiProtocol}`, async () => {
    const { config } = await fixture({ globalProtocol: 'responses' })
    const source = { ...config.customOpenAIProviders[0], ...(apiProtocol ? { apiProtocol } : {}) }
    const { configUpdate } = buildSelectedModeProviderSecretOverrideUpdate(
      config,
      source.id,
      'override-key',
      source,
      [source],
    )
    const materialized = configUpdate.customOpenAIProviders.at(-1)
    assert.equal(materialized.apiProtocol, apiProtocol)
    assert.equal(Object.hasOwn(materialized, 'apiProtocol'), Boolean(apiProtocol))
    assert.equal(materialized.responsesUrl, responsesUrl)
    globalThis.__TEST_BROWSER_SHIM__.setStorage(configUpdate)
    const reloaded = await getUserConfig()
    const request = resolveOpenAICompatibleRequest(
      reloaded,
      initSession({ apiMode: reloaded.apiMode }),
    )
    assert.equal(request.provider.apiProtocol, apiProtocol)
    assert.equal(request.apiKey, 'override-key')
  })
}

for (const apiProtocol of ['chat', 'responses']) {
  test(`/api/chat URL is guarded only for ${apiProtocol} request bodies`, async (t) => {
    const { config, session, port } = await fixture({ providerProtocol: apiProtocol })
    const endpoint = 'https://proxy.example/api/chat'
    config.customOpenAIProviders[0] = {
      ...config.customOpenAIProviders[0],
      apiProtocol,
      chatCompletionsUrl: endpoint,
      responsesUrl: endpoint,
    }
    const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
      assert.equal(Object.hasOwn(JSON.parse(init.body), 'input'), true)
      return createMockSseResponse([
        'data: {"type":"response.completed","response":{"output_text":"Answer"}}\n\n',
      ])
    })
    const request = generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)
    if (apiProtocol === 'chat') {
      await assert.rejects(request, /Unsupported native Ollama chat endpoint/)
      assert.equal(fetchMock.mock.callCount(), 0)
    } else {
      await request
      assert.equal(fetchMock.mock.callCount(), 1)
      assert.equal(fetchMock.mock.calls[0].arguments[0], endpoint)
    }
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const path of ['/custom/respond', '/v1/responses']) {
  test(`Responses-only ${path} preserves the original error without a configured Chat endpoint`, async (t) => {
    const { config, session, port } = await fixture({ providerProtocol: 'responses' })
    const endpoint = `https://proxy.example${path}`
    config.customOpenAIProviders[0] = {
      id: 'review-proxy',
      apiProtocol: 'responses',
      responsesUrl: endpoint,
    }
    const calls = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'Original route unavailable' } }), {
          status: 404,
        })
      }
      return createMockSseResponse([
        'data: {"choices":[{"delta":{"content":"Fallback"},"finish_reason":"stop"}]}\n\n',
      ])
    })
    const request = generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config)
    await assert.rejects(
      request,
      (error) => error.status === 404 && /Original route unavailable/.test(error.message),
    )
    assert.deepEqual(
      calls.map(({ url }) => url),
      [endpoint],
    )
    assert.deepEqual(session.conversationRecords, [])
    assert.equal(
      port.postedMessages.some((message) => message.done),
      false,
    )
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const transport of ['SSE', 'JSON', 'split JSON']) {
  for (const reason of ['max_output_tokens', 'content_filter', undefined]) {
    test(`empty incomplete ${transport} response with reason ${reason} preserves retry history without fallback`, async (t) => {
      const { config, session, port } = await fixture({ providerProtocol: 'responses' })
      const records = [{ question: 'Q', answer: 'Original answer' }]
      session.conversationRecords = structuredClone(records)
      session.isRetry = true
      const response = {
        object: 'response',
        status: 'incomplete',
        error: null,
        output: [{ type: 'reasoning', summary: [] }],
        ...(reason ? { incomplete_details: { reason } } : {}),
      }
      const json = JSON.stringify(response)
      const chunks =
        transport === 'SSE'
          ? [
              `data: ${JSON.stringify({ type: 'response.incomplete', response })}\n\n`,
              'data: [DONE]\n\n',
            ]
          : transport === 'split JSON'
          ? [json.slice(0, 25), json.slice(25)]
          : [json]
      const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
        createMockSseResponse(chunks),
      )

      await assert.rejects(generateAnswersWithOpenAICompatibleApi(port, 'Q', session, config), {
        message: `Responses API response incomplete: ${reason || 'no output text'}`,
      })

      assert.equal(fetchMock.mock.callCount(), 1)
      assert.deepEqual(session.conversationRecords, records)
      assert.equal(session.isRetry, true)
      assert.equal(
        port.postedMessages.some((message) => message.done || message.session),
        false,
      )
      assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
    })
  }
}
