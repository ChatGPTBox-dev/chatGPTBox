import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { getUserConfig, setUserConfig } from '../../../src/config/index.mjs'
import {
  buildEditedProvider,
  buildProviderDraft,
  parseChatCompletionsEndpointUrl,
  validateProviderEndpointDraft,
  validateResponsesEndpointDraft,
  validateProviderResponsesEndpointDraft,
} from '../../../src/popup/sections/api-modes-provider-utils.mjs'
import { generateAnswersWithOpenAICompatibleApi } from '../../../src/services/apis/openai-api.mjs'
import { resolveOpenAICompatibleRequest } from '../../../src/services/apis/provider-registry.mjs'
import { createFakePort } from '../helpers/port.mjs'
import { createMockSseResponse } from '../helpers/sse-response.mjs'

const oldResponsesUrl = 'https://old-responses.example/custom/respond?version=1'
const newResponsesUrl = 'https://new-responses.example/custom/respond/?next=a?b/'
const newChatUrl = 'https://new-chat.example/v2/chat/completions?version=2'
const providerSecrets = { 'editable-provider': 'test-provider-key', unrelated: 'test-other-key' }

function createProvider(overrides = {}) {
  return {
    id: 'editable-provider',
    name: 'Editable Provider',
    baseUrl: 'https://base.example',
    chatCompletionsPath: '/custom/chat',
    completionsPath: '/custom/completions',
    chatCompletionsUrl: 'https://old-chat.example/custom/chat?version=1',
    completionsUrl: 'https://completion.example/custom/complete?version=1',
    apiProtocol: 'responses',
    responsesUrl: oldResponsesUrl,
    legacyProviderIds: ['previous-provider'],
    sourceProviderId: 'openai',
    enabled: true,
    allowLegacyResponseField: false,
    ...overrides,
  }
}

function createSession() {
  return {
    modelName: 'customModel',
    conversationRecords: [],
    apiMode: {
      groupName: 'customApiModelKeys',
      itemName: 'customModel',
      isCustom: true,
      providerId: 'editable-provider',
      customName: 'gpt-5',
      customUrl: 'https://stale-session.example/v1/chat/completions',
      active: true,
    },
  }
}

function editProvider(provider, changes = {}) {
  const draft = { ...buildProviderDraft(provider), ...changes }
  const { valid, parsedEndpoint } = validateProviderEndpointDraft(draft.apiUrl, draft)
  assert.equal(valid, true)
  assert.equal(validateProviderResponsesEndpointDraft(draft, provider).valid, true)
  return buildEditedProvider(provider, provider.id, draft.name, parsedEndpoint, draft.apiUrl, draft)
}

async function saveAndReload(provider) {
  await setUserConfig({ customOpenAIProviders: [provider], providerSecrets })
  const config = await getUserConfig()
  assert.deepEqual(config.providerSecrets, providerSecrets)
  assert.deepEqual(globalThis.__TEST_BROWSER_SHIM__.getStorage().providerSecrets, providerSecrets)
  return config
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

for (const responsesUrl of [
  'not a URL',
  '/relative/responses',
  'javascript:alert(1)',
  'https://user:password@example.com/responses',
  'https://example.com/responses#fragment',
]) {
  test(`Chat edits preserve an unchanged inactive legacy Responses endpoint: ${responsesUrl}`, async () => {
    const provider = createProvider({ apiProtocol: 'chat', responsesUrl })
    const draft = { ...buildProviderDraft(provider), name: 'Renamed', apiUrl: newChatUrl }
    assert.equal(validateResponsesEndpointDraft(responsesUrl).valid, false)
    assert.deepEqual(validateProviderResponsesEndpointDraft(draft, provider), {
      valid: true,
      responsesUrl,
    })
    const updated = editProvider(provider, draft)
    const config = await saveAndReload(updated)
    const saved = config.customOpenAIProviders.find(({ id }) => id === provider.id)
    assert.equal(saved.name, 'Renamed')
    assert.equal(saved.responsesUrl, responsesUrl)
    assert.equal(saved.chatCompletionsUrl, newChatUrl)
    assert.equal(resolveOpenAICompatibleRequest(config, createSession()).requestUrl, newChatUrl)
    assert.equal(provider.name, 'Editable Provider')
    assert.equal(provider.responsesUrl, responsesUrl)
  })
}

test('provider Responses validation rejects new invalid values and unsafe protocol switches', () => {
  const provider = createProvider({ apiProtocol: 'chat', responsesUrl: 'legacy invalid URL' })
  for (const apiProtocol of ['responses', 'default', undefined]) {
    assert.equal(
      validateProviderResponsesEndpointDraft(
        { ...buildProviderDraft(provider), apiProtocol },
        provider,
      ).valid,
      false,
    )
  }
  for (const existingProvider of [
    undefined,
    {},
    createProvider({ responsesUrl: newResponsesUrl }),
  ]) {
    assert.equal(
      validateProviderResponsesEndpointDraft(buildProviderDraft(provider), existingProvider).valid,
      false,
    )
  }
  assert.equal(
    validateProviderResponsesEndpointDraft(
      { ...buildProviderDraft(provider), responsesUrl: 'new invalid URL' },
      provider,
    ).valid,
    false,
  )
  for (const responsesUrl of ['', newResponsesUrl]) {
    assert.deepEqual(
      validateProviderResponsesEndpointDraft(
        { ...buildProviderDraft(provider), responsesUrl },
        provider,
      ),
      { valid: true, responsesUrl },
    )
  }
})

test('Chat legacy exemption does not relax Chat URL validation or silently erase dormant data', () => {
  const provider = createProvider({ apiProtocol: 'responses', responsesUrl: 'legacy invalid URL' })
  const draft = { ...buildProviderDraft(provider), apiProtocol: ' CHAT ' }
  assert.equal(validateProviderResponsesEndpointDraft(draft, provider).valid, true)
  assert.equal(validateProviderEndpointDraft('', draft).valid, false)
  assert.equal(validateProviderEndpointDraft('not a chat URL', draft).valid, false)
  assert.equal(editProvider(provider, draft).responsesUrl, provider.responsesUrl)
  assert.equal(
    Object.hasOwn(editProvider(provider, { ...draft, responsesUrl: '' }), 'responsesUrl'),
    false,
  )
})

test('buildProviderDraft supplies blank fields and inherits the protocol for a new provider', () => {
  assert.deepEqual(buildProviderDraft(), {
    name: '',
    apiUrl: '',
    apiProtocol: 'default',
    responsesUrl: '',
  })
})

test('buildProviderDraft resolves Chat separately and trims only the explicit Responses URL', () => {
  const provider = createProvider({ responsesUrl: ` \t${newResponsesUrl}\n ` })
  assert.deepEqual(buildProviderDraft(provider), {
    name: 'Editable Provider',
    apiUrl: 'https://old-chat.example/custom/chat?version=1',
    apiProtocol: 'responses',
    responsesUrl: newResponsesUrl,
  })
})

for (const [apiProtocol, expected] of [
  [undefined, 'default'],
  ['', 'default'],
  ['default', 'default'],
  ['chat', 'chat'],
  [' CHAT ', 'chat'],
  ['responses', 'responses'],
  [' RESPONSES ', 'responses'],
  ['unsupported', 'default'],
]) {
  test(`buildProviderDraft normalizes protocol ${JSON.stringify(
    apiProtocol,
  )} without materializing a derived URL`, () => {
    assert.deepEqual(
      buildProviderDraft({
        name: 'Base Provider',
        baseUrl: 'https://base.example/v1',
        apiProtocol,
      }),
      {
        name: 'Base Provider',
        apiUrl: 'https://base.example/v1/chat/completions',
        apiProtocol: expected,
        responsesUrl: '',
      },
    )
  })
}

test('buildProviderDraft resolves custom Chat paths and treats whitespace Responses as derived', () => {
  assert.deepEqual(
    buildProviderDraft({
      name: 'Custom Paths',
      baseUrl: 'https://base.example',
      chatCompletionsPath: '/custom/chat?version=1',
      apiProtocol: 'responses',
      responsesUrl: ' \t\n ',
    }),
    {
      name: 'Custom Paths',
      apiUrl: 'https://base.example/custom/chat?version=1',
      apiProtocol: 'responses',
      responsesUrl: '',
    },
  )
})

test('validateResponsesEndpointDraft accepts blank input for runtime derivation', () => {
  for (const value of [undefined, '', ' \t\n ']) {
    assert.deepEqual(validateResponsesEndpointDraft(value), { valid: true, responsesUrl: '' })
  }
})

test('validateProviderEndpointDraft accepts blank Chat only with an explicit valid Responses endpoint', () => {
  for (const value of ['', ' \t\n ']) {
    const result = validateProviderEndpointDraft(value, {
      apiProtocol: 'responses',
      responsesUrl: ` ${newResponsesUrl} `,
    })
    assert.equal(result.valid, true)
    assert.equal(result.parsedEndpoint.chatCompletionsUrl, '')
    assert.equal(result.parsedEndpoint.completionsUrl, '')
  }
})

for (const apiProtocol of [undefined, 'default', 'chat', 'unsupported']) {
  test(`blank Chat is invalid with protocol ${JSON.stringify(
    apiProtocol,
  )} even with Responses configured`, () => {
    assert.equal(
      validateProviderEndpointDraft('', { apiProtocol, responsesUrl: newResponsesUrl }).valid,
      false,
    )
  })
}

test('blank Chat remains invalid without a protocol draft or a valid nonempty Responses URL', () => {
  assert.equal(validateProviderEndpointDraft('').valid, false)
  for (const responsesUrl of [
    undefined,
    '',
    ' \t\n ',
    'not a URL',
    'ftp://responses.example/respond',
    'https://user:password@responses.example/respond',
    'https://responses.example/respond#fragment',
  ]) {
    assert.equal(
      validateProviderEndpointDraft('', { apiProtocol: 'responses', responsesUrl }).valid,
      false,
      String(responsesUrl),
    )
  }
})

test('an explicit Responses endpoint never makes an invalid nonempty Chat URL valid', () => {
  for (const apiUrl of [
    'not a URL',
    '/v1/chat/completions',
    'https://chat.example/v1',
    'ftp://chat.example/v1/chat/completions',
    'https://user:password@chat.example/v1/chat/completions',
    'https://chat.example/v1/chat/completions#fragment',
  ]) {
    assert.equal(
      validateProviderEndpointDraft(apiUrl, {
        apiProtocol: 'responses',
        responsesUrl: newResponsesUrl,
      }).valid,
      false,
      apiUrl,
    )
  }
  assert.equal(validateProviderEndpointDraft(newChatUrl).valid, true)
})

test('editing a Responses-only provider preserves its empty Chat fields and identity after storage', async () => {
  const provider = createProvider({ baseUrl: '', chatCompletionsUrl: '', completionsUrl: '' })
  assert.equal(buildProviderDraft(provider).apiUrl, '')
  const updated = editProvider(provider, { responsesUrl: ` ${newResponsesUrl} ` })
  assert.deepEqual(updated, { ...provider, responsesUrl: newResponsesUrl })
  const config = await saveAndReload(updated)
  const saved = config.customOpenAIProviders.find(({ id }) => id === provider.id)
  for (const key of Object.keys(updated)) {
    assert.deepEqual(saved[key], updated[key], key)
  }
  const request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.apiProtocol, 'responses')
  assert.equal(request.requestUrl, newResponsesUrl)
  assert.equal(request.apiKey, providerSecrets[provider.id])
})

test('clearing Chat while keeping explicit Responses removes the previous Chat endpoint fields', async () => {
  const provider = createProvider()
  const updated = editProvider(provider, { apiUrl: ' \t ', responsesUrl: newResponsesUrl })
  assert.deepEqual(updated, {
    ...provider,
    baseUrl: '',
    chatCompletionsUrl: '',
    completionsUrl: '',
    responsesUrl: newResponsesUrl,
  })
  const config = await saveAndReload(updated)
  assert.equal(buildProviderDraft(config.customOpenAIProviders[0]).apiUrl, '')
  const request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.apiProtocol, 'responses')
  assert.equal(request.requestUrl, newResponsesUrl)
})

test('a Responses-only provider cannot switch to Chat or default while Chat remains blank', () => {
  const draft = buildProviderDraft(
    createProvider({ baseUrl: '', chatCompletionsUrl: '', completionsUrl: '' }),
  )
  assert.equal(validateProviderEndpointDraft(draft.apiUrl, draft).valid, true)
  for (const apiProtocol of ['chat', 'default']) {
    assert.equal(
      validateProviderEndpointDraft(draft.apiUrl, { ...draft, apiProtocol }).valid,
      false,
    )
    assert.equal(validateProviderEndpointDraft(newChatUrl, { ...draft, apiProtocol }).valid, true)
  }
})

test('creating a Responses-only provider persists its explicit URL without requiring Chat', async () => {
  const draft = {
    ...buildProviderDraft(),
    name: 'Responses Only',
    apiProtocol: 'responses',
    responsesUrl: ` ${newResponsesUrl} `,
  }
  const { valid, parsedEndpoint } = validateProviderEndpointDraft(draft.apiUrl, draft)
  assert.equal(valid, true)
  const defaults = {
    baseUrl: '',
    chatCompletionsPath: '/v1/chat/completions',
    completionsPath: '/v1/completions',
    enabled: true,
    allowLegacyResponseField: true,
  }
  const provider = buildEditedProvider(
    defaults,
    'editable-provider',
    draft.name,
    parsedEndpoint,
    draft.apiUrl,
    draft,
  )
  assert.deepEqual(provider, {
    ...defaults,
    id: 'editable-provider',
    name: 'Responses Only',
    apiProtocol: 'responses',
    responsesUrl: newResponsesUrl,
  })
  const config = await saveAndReload(provider)
  assert.equal(buildProviderDraft(config.customOpenAIProviders[0]).apiUrl, '')
  const request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.apiProtocol, 'responses')
  assert.equal(request.requestUrl, newResponsesUrl)
})

for (const url of [
  'http://host',
  'https://responses.example/',
  'https://responses.example/v1/',
  'https://responses.example/v2?x=1',
  'https://responses.example/v1/responses',
  'https://responses.example/api/chat',
  'http://localhost:8080/custom/respond',
  'https://responses.example/custom/respond/',
  'https://responses.example/custom/respond/?version=2&next=%2Fchat%2Fcompletions',
  'https://responses.example/custom/respond?next=a?b/',
  'https://RESPONSES.example:443/custom/%72espond/?next=%23anchor/',
  newResponsesUrl,
]) {
  test(`validateResponsesEndpointDraft preserves the exact trimmed URL: ${url}`, () => {
    assert.deepEqual(validateResponsesEndpointDraft(` \t${url}\n `), {
      valid: true,
      responsesUrl: url,
    })
  })
}

for (const value of [
  'not a URL',
  '/v1/responses',
  '//responses.example/v1/responses',
  'https://',
  'https://bad host.example/v1/responses',
  'ftp://responses.example/v1/responses',
  'file:///v1/responses',
  'javascript:alert(1)',
  'data:text/plain,responses',
  'https://user@responses.example/v1/responses',
  'https://:password@responses.example/v1/responses',
  'https://user:password@responses.example/v1/responses',
  'https://responses.example/v1/responses#fragment',
  'https://responses.example/v1/responses?version=1#fragment',
]) {
  test(`validateResponsesEndpointDraft rejects ${value}`, () => {
    assert.deepEqual(validateResponsesEndpointDraft(` ${value} `), {
      valid: false,
      responsesUrl: '',
    })
  })
}

for (const responsesUrl of ['https://proxy.example/', 'https://proxy.example/v1?version=2']) {
  test(`Responses-only provider edits persist the explicit proxy endpoint ${responsesUrl}`, async () => {
    const provider = editProvider(createProvider(), { apiUrl: '', responsesUrl })
    const config = await saveAndReload(provider)
    const savedProvider = config.customOpenAIProviders[0]
    assert.equal(buildProviderDraft(savedProvider).responsesUrl, responsesUrl)
    assert.equal(buildProviderDraft(savedProvider).apiUrl, '')
    assert.equal(resolveOpenAICompatibleRequest(config, createSession()).requestUrl, responsesUrl)
  })
}

test('Responses-only edits preserve Chat, base, completions, identity, and secrets after storage', async () => {
  const provider = createProvider()
  const original = structuredClone(provider)
  const updated = editProvider(provider, { responsesUrl: ` ${newResponsesUrl} ` })
  assert.deepEqual(updated, { ...original, responsesUrl: newResponsesUrl })
  assert.deepEqual(provider, original)

  const config = await saveAndReload(updated)
  const saved = config.customOpenAIProviders.find(({ id }) => id === provider.id)
  for (const key of Object.keys(original)) {
    assert.deepEqual(saved[key], updated[key], key)
  }
  const request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.requestUrl, newResponsesUrl)
  assert.equal(request.chatCompletionsUrl, provider.chatCompletionsUrl)
  assert.equal(request.apiKey, providerSecrets[provider.id])
})

for (const includeProtocolDraft of [false, true]) {
  test(`Chat-only edits preserve explicit Responses with protocol draft ${includeProtocolDraft}`, async () => {
    const provider = createProvider()
    const original = structuredClone(provider)
    const updated = buildEditedProvider(
      provider,
      provider.id,
      provider.name,
      parseChatCompletionsEndpointUrl(newChatUrl),
      newChatUrl,
      includeProtocolDraft ? buildProviderDraft(provider) : undefined,
    )
    assert.deepEqual(updated, {
      ...original,
      baseUrl: '',
      chatCompletionsUrl: newChatUrl,
      completionsUrl: 'https://new-chat.example/v2/completions?version=2',
    })
    assert.deepEqual(provider, original)
    const request = resolveOpenAICompatibleRequest(await saveAndReload(updated), createSession())
    assert.equal(request.requestUrl, oldResponsesUrl)
    assert.equal(request.chatCompletionsUrl, newChatUrl)
  })
}

test('clearing Responses removes the property and derives from the newly edited Chat URL', async () => {
  const updated = editProvider(createProvider(), { apiUrl: newChatUrl, responsesUrl: ' \t\n ' })
  assert.equal(Object.hasOwn(updated, 'responsesUrl'), false)
  const config = await saveAndReload(updated)
  assert.equal(Object.hasOwn(config.customOpenAIProviders[0], 'responsesUrl'), false)
  assert.equal(
    Object.hasOwn(
      globalThis.__TEST_BROWSER_SHIM__.getStorage().customOpenAIProviders[0],
      'responsesUrl',
    ),
    false,
  )
  assert.equal(buildProviderDraft(config.customOpenAIProviders[0]).responsesUrl, '')
  const request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.apiProtocol, 'responses')
  assert.equal(request.requestUrl, 'https://new-chat.example/v2/responses?version=2')
  assert.equal(request.chatCompletionsUrl, newChatUrl)
})

test('protocol toggles retain the explicit Responses URL and all other provider fields', async () => {
  const provider = createProvider()
  const chatProvider = editProvider(provider, { apiProtocol: 'chat' })
  const expectedChatProvider = { ...provider, apiProtocol: 'chat' }
  assert.deepEqual(chatProvider, expectedChatProvider)
  let config = await saveAndReload(chatProvider)
  assert.equal(config.customOpenAIProviders[0].apiProtocol, 'chat')
  let request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.apiProtocol, 'chat')
  assert.equal(request.requestUrl, provider.chatCompletionsUrl)
  assert.equal(buildProviderDraft(config.customOpenAIProviders[0]).responsesUrl, oldResponsesUrl)

  const responsesProvider = editProvider(chatProvider, { apiProtocol: 'responses' })
  assert.deepEqual(responsesProvider, provider)
  config = await saveAndReload(responsesProvider)
  request = resolveOpenAICompatibleRequest(config, createSession())
  assert.equal(request.apiProtocol, 'responses')
  assert.equal(request.requestUrl, oldResponsesUrl)
})

for (const [apiProtocol, globalProtocol, expectedProtocol] of [
  ['default', 'responses', 'responses'],
  ['default', 'chat', 'chat'],
  ['chat', 'responses', 'chat'],
  ['responses', 'chat', 'responses'],
]) {
  test(`provider ${apiProtocol} with global ${globalProtocol} sends ${expectedProtocol} requests after storage`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    const provider = createProvider()
    const updated = editProvider(provider, { apiProtocol })
    const expected = { ...provider, apiProtocol }
    if (apiProtocol === 'default') delete expected.apiProtocol
    assert.deepEqual(updated, expected)
    await setUserConfig({ openaiApiProtocol: globalProtocol })
    const config = await saveAndReload(updated)
    const saved = config.customOpenAIProviders[0]
    assert.equal(Object.hasOwn(saved, 'apiProtocol'), apiProtocol !== 'default')
    assert.equal(buildProviderDraft(saved).apiProtocol, apiProtocol)
    assert.equal(
      Object.hasOwn(
        globalThis.__TEST_BROWSER_SHIM__.getStorage().customOpenAIProviders[0],
        'apiProtocol',
      ),
      apiProtocol !== 'default',
    )
    const requestedUrls = []
    const bodies = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requestedUrls.push(url)
      bodies.push(JSON.parse(init.body))
      return createMockSseResponse(
        expectedProtocol === 'responses'
          ? [
              'data: {"type":"response.output_text.delta","delta":"Answer"}\n\n',
              'data: {"type":"response.completed"}\n\n',
            ]
          : ['data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n'],
      )
    })
    const session = createSession()
    await generateAnswersWithOpenAICompatibleApi(createFakePort(), 'Question', session, config)
    assert.deepEqual(requestedUrls, [
      expectedProtocol === 'responses' ? oldResponsesUrl : provider.chatCompletionsUrl,
    ])
    assert.equal(Object.hasOwn(bodies[0], 'input'), expectedProtocol === 'responses')
    assert.equal(Object.hasOwn(bodies[0], 'messages'), expectedProtocol === 'chat')
    assert.deepEqual(session.conversationRecords, [{ question: 'Question', answer: 'Answer' }])
  })
}

for (const endpoints of [{}, { chatCompletionsUrl: '', completionsUrl: '' }]) {
  test(`rename preserves every endpoint for ${
    endpoints.chatCompletionsUrl === '' ? 'base' : 'explicit'
  } providers`, () => {
    const provider = createProvider(endpoints)
    assert.deepEqual(editProvider(provider, { name: 'Renamed Provider' }), {
      ...provider,
      name: 'Renamed Provider',
    })
  })
}

test('renaming a provider without an explicit protocol keeps protocol inheritance', () => {
  const provider = createProvider()
  delete provider.apiProtocol
  const updated = editProvider(provider, { name: 'Renamed Provider' })
  assert.deepEqual(updated, { ...provider, name: 'Renamed Provider' })
  assert.equal(Object.hasOwn(updated, 'apiProtocol'), false)
})

for (const [apiProtocol, responsesUrl, expectedUrl] of [
  ['default', '', newChatUrl],
  ['chat', '', newChatUrl],
  ['responses', '', 'https://new-chat.example/v2/responses?version=2'],
  ['responses', newResponsesUrl, newResponsesUrl],
]) {
  test(`new ${apiProtocol} providers survive storage with ${
    responsesUrl ? 'explicit' : 'default'
  } Responses URLs`, async () => {
    const defaults = {
      baseUrl: '',
      chatCompletionsPath: '/v1/chat/completions',
      completionsPath: '/v1/completions',
      enabled: true,
      allowLegacyResponseField: true,
    }
    const provider = buildEditedProvider(
      defaults,
      'editable-provider',
      'New Provider',
      parseChatCompletionsEndpointUrl(newChatUrl),
      newChatUrl,
      { ...buildProviderDraft(), apiProtocol, responsesUrl },
    )
    assert.deepEqual(provider, {
      ...defaults,
      id: 'editable-provider',
      name: 'New Provider',
      chatCompletionsUrl: newChatUrl,
      completionsUrl: 'https://new-chat.example/v2/completions?version=2',
      ...(apiProtocol !== 'default' ? { apiProtocol } : {}),
      ...(responsesUrl ? { responsesUrl } : {}),
    })
    const request = resolveOpenAICompatibleRequest(await saveAndReload(provider), createSession())
    assert.equal(request.apiProtocol, apiProtocol === 'default' ? 'chat' : apiProtocol)
    assert.equal(request.requestUrl, expectedUrl)
  })
}

for (const fallback of [false, true]) {
  test(`saved endpoint edits send only to new URLs${
    fallback ? ' with configured Chat fallback on 404' : ''
  }`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    t.mock.method(console, 'warn', () => {})
    const provider = editProvider(createProvider(), {
      apiUrl: newChatUrl,
      responsesUrl: newResponsesUrl,
    })
    const config = await saveAndReload(provider)
    const session = createSession()
    const requestedUrls = []
    t.mock.method(globalThis, 'fetch', async (url) => {
      requestedUrls.push(url)
      if (requestedUrls.length === 1) {
        assert.equal(url, newResponsesUrl)
        if (fallback) {
          return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 })
        }
        return createMockSseResponse([
          'data: {"type":"response.output_text.delta","delta":"New answer"}\n\n',
          'data: {"type":"response.completed"}\n\n',
        ])
      }
      assert.equal(url, newChatUrl)
      return createMockSseResponse([
        'data: {"choices":[{"delta":{"content":"New answer"},"finish_reason":"stop"}]}\n\n',
      ])
    })
    await generateAnswersWithOpenAICompatibleApi(createFakePort(), 'Question', session, config)
    assert.deepEqual(requestedUrls, fallback ? [newResponsesUrl, newChatUrl] : [newResponsesUrl])
    assert.deepEqual(session.conversationRecords, [{ question: 'Question', answer: 'New answer' }])
  })
}
