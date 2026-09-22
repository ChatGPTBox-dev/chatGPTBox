import assert from 'node:assert/strict'
import { test } from 'node:test'
import GeminiWebClient from '../../../../src/services/clients/gemini-web/index.mjs'

const bootstrap = '{"SNlM0e":"test-at"}'
const metadata = ['c_test', 'r_test']
const candidate = ['rc_test', ['answer']]
candidate[8] = [2]
const responsePayload = JSON.stringify([
  ['wrb.fr', null, JSON.stringify([null, metadata, null, null, [candidate]])],
])
const reply = `)]}'\n\n${responsePayload.length + 2}\n${responsePayload}\n`

function mockFetch(t, redirect) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    const response = new Response(init.method === 'POST' ? reply : bootstrap)
    if (redirect && init.method !== 'POST') {
      Object.defineProperty(response, 'url', { value: redirect })
    }
    return response
  })
  return requests
}

function hideProperty(t, object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { configurable: true, value: undefined })
  t.after(() => {
    if (descriptor) Object.defineProperty(object, key, descriptor)
    else delete object[key]
  })
}

for (const state of [
  { c: 'c_old' },
  { r: 'r_old' },
  { rc: 'rc_old' },
  { metadata: ['c_old', 'r_old', 'rc_old'] },
]) {
  test('rejects unscoped continuation before any request', async (t) => {
    const requests = mockFetch(t)
    await assert.rejects(new GeminiWebClient().ask('Q', state), /account route/)
    assert.equal(requests.length, 0)
  })
}

test('pins an explicitly saved default account route', async (t) => {
  const requests = mockFetch(t, 'https://gemini.google.com/u/1/app')
  await assert.rejects(
    new GeminiWebClient().ask('Q', {
      c: 'c_old',
      r: 'r_old',
      rc: 'rc_old',
      accountPath: '',
    }),
    /account route changed/,
  )
  assert.equal(requests.length, 1)
})

for (const state of [
  { c: 'c_old', accountPath: '' },
  { c: 'c_old', r: 'r_old', accountPath: '' },
  { metadata: ['c_old', 'r_old', ''], accountPath: '' },
  { metadata: 'BAD', accountPath: '' },
]) {
  test('rejects incomplete or malformed scoped continuation before any request', async (t) => {
    const requests = mockFetch(t)
    await assert.rejects(new GeminiWebClient().ask('Q', state), /Invalid conversation state/)
    assert.equal(requests.length, 0)
  })
}

test('allows an account-route-only first-turn snapshot', async (t) => {
  const requests = mockFetch(t)
  const result = await new GeminiWebClient().ask('Q', { accountPath: '/u/1' })

  assert.equal(result.answer, 'answer')
  assert.equal(requests.length, 2)
})

test('continues an explicitly scoped Google multi-login route', async (t) => {
  const requests = mockFetch(t)
  const result = await new GeminiWebClient().ask('Q', {
    c: 'c_old',
    r: 'r_old',
    rc: 'rc_old',
    accountPath: '/u/1',
  })
  assert.equal(result.answer, 'answer')
  assert.equal(result.conversationObj.accountPath, '/u/1')
  assert.match(requests[0].url, /gemini\.google\.com\/u\/1\/app$/)
  assert.match(requests[1].url, /gemini\.google\.com\/u\/1\/_\/BardChatUi\//)
})

test('drops obsolete Gaia identity state without querying Google accounts', async (t) => {
  const requests = mockFetch(t)
  const result = await new GeminiWebClient().ask('Q', {
    c: 'c_old',
    r: 'r_old',
    rc: 'rc_old',
    accountPath: '',
    accountId: 'obsolete-gaia-id',
  })
  assert.equal(result.answer, 'answer')
  assert.equal(Object.hasOwn(result.conversationObj, 'accountId'), false)
  assert.equal(requests.length, 2)
  assert.equal(
    requests.every(({ url }) => url.startsWith('https://gemini.google.com/')),
    true,
  )
})

test('uses browser credentials without manually setting cookies', async (t) => {
  const requests = mockFetch(t)
  const result = await new GeminiWebClient().ask('Q')
  assert.equal(result.answer, 'answer')
  assert.equal(requests.length, 2)
  for (const { url, init } of requests) {
    assert.equal(url.startsWith('https://gemini.google.com/'), true)
    assert.equal(init.credentials, 'include')
    assert.equal(new Headers(init.headers).has('Cookie'), false)
  }
})

test('does not retry a failed prompt request', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init })
    if (init.method !== 'POST') return new Response(bootstrap)
    return new Response('private-body', { status: 429 })
  })

  await assert.rejects(new GeminiWebClient().ask('Q'), /HTTP 429/)
  assert.equal(requests.length, 2)
})

test('whole-turn timeout aborts an in-flight request with its timeout diagnostic', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  t.mock.method(globalThis, 'fetch', async (...[, init]) => {
    signal = init.signal
    return new Promise((...[, reject]) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  const pending = new GeminiWebClient().ask('Q')
  const rejected = assert.rejects(pending, /timed out/)
  t.mock.timers.tick(240000)
  await rejected
  assert.equal(signal.aborted, true)
})

test('works without AbortSignal.throwIfAborted', async (t) => {
  hideProperty(t, AbortSignal.prototype, 'throwIfAborted')
  const requests = mockFetch(t)
  assert.equal((await new GeminiWebClient().ask('Q')).answer, 'answer')
  assert.equal(requests.length, 2)
})

test('rejects a pre-aborted signal without newer AbortSignal helpers', async (t) => {
  hideProperty(t, AbortSignal.prototype, 'throwIfAborted')
  hideProperty(t, AbortSignal.prototype, 'reason')
  const requests = mockFetch(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(new GeminiWebClient().ask('Q', {}, controller.signal), {
    name: 'AbortError',
  })
  assert.equal(requests.length, 0)
})

test('creates a valid UUID without crypto.randomUUID', async (t) => {
  hideProperty(t, crypto, 'randomUUID')
  const requests = mockFetch(t)
  await new GeminiWebClient().ask('Q')
  const requestId = JSON.parse(requests[1].init.headers['x-goog-ext-525005358-jspb'])[0]
  assert.match(requestId, /^[\dA-F]{8}-[\dA-F]{4}-4[\dA-F]{3}-[89AB][\dA-F]{3}-[\dA-F]{12}$/)
})

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

function modelDiscoveryResponse(models, modes = []) {
  const status = Array(25).fill(null)
  status[14] = 1000
  status[15] = models
  status[16] = [8]
  status[24] = [null, modes]
  return framed([['wrb.fr', 'otAQ7b', JSON.stringify(status)]])
}

function mockModelFetch(t, discovery) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, init })
    if (init.method !== 'POST') return new Response(bootstrap)
    if (requestUrl.includes('/batchexecute?')) return new Response(discovery)
    return new Response(reply)
  })
  return requests
}

test('discovers the selected model and sends temporary extended-thinking fields', async (t) => {
  const discovery = modelDiscoveryResponse([
    modelEntry('flash-id', 'Flash', 'Gemini Flash', 1),
    modelEntry('pro-id', 'Pro', 'Gemini Pro', 3),
    modelEntry('lite-id', 'Flash-Lite', 'Gemini Flash-Lite', 6),
  ])
  const requests = mockModelFetch(t, discovery)

  const result = await new GeminiWebClient().ask('Q', {}, undefined, {
    model: 'pro',
    temporary: true,
    extendedThinking: true,
  })
  assert.equal(result.answer, 'answer')
  assert.equal(requests.length, 3)

  const discoveryRequest = requests[1]
  assert.equal(new URL(discoveryRequest.url).searchParams.get('rpcids'), 'otAQ7b')
  assert.equal(new URL(discoveryRequest.url).searchParams.get('source-path'), '/app')

  const generation = requests[2].init
  const modelHeader = JSON.parse(generation.headers['x-goog-ext-525001261-jspb'])
  assert.equal(modelHeader[4], 'pro-id')
  assert.equal(modelHeader[11], 2)
  assert.equal(modelHeader[14], 3)
  assert.equal(modelHeader.at(-2), 2)
  assert.match(modelHeader.at(-1), /^[\dA-F-]{36}$/)

  const inner = JSON.parse(JSON.parse(generation.body.get('f.req'))[1])
  assert.equal(inner[45], 1)
  assert.equal(inner[79], 3)
  assert.equal(inner[80], 2)
})

test('supports extended thinking with Flash', async (t) => {
  const discovery = modelDiscoveryResponse([
    modelEntry('flash-id', 'Flash', 'Gemini Flash', 1),
    modelEntry('pro-id', 'Pro', 'Gemini Pro', 3),
  ])
  const requests = mockModelFetch(t, discovery)

  await new GeminiWebClient().ask('Q', {}, undefined, {
    model: 'flash',
    extendedThinking: true,
  })

  const generation = requests[2].init
  const modelHeader = JSON.parse(generation.headers['x-goog-ext-525001261-jspb'])
  assert.equal(modelHeader[4], 'flash-id')
  assert.equal(modelHeader.at(-2), 2)
  const inner = JSON.parse(JSON.parse(generation.body.get('f.req'))[1])
  assert.equal(inner[79], 1)
  assert.equal(inner[80], 2)
})

test('supports extended thinking with Flash-Lite', async (t) => {
  const discovery = modelDiscoveryResponse([
    modelEntry('lite-id', 'Flash-Lite', 'Gemini Flash-Lite', 6),
    modelEntry('flash-id', 'Flash', 'Gemini Flash', 1),
  ])
  const requests = mockModelFetch(t, discovery)

  await new GeminiWebClient().ask('Q', {}, undefined, {
    model: 'flash-lite',
    extendedThinking: true,
  })

  const generation = requests[2].init
  const modelHeader = JSON.parse(generation.headers['x-goog-ext-525001261-jspb'])
  assert.equal(modelHeader[4], 'lite-id')
  assert.equal(modelHeader.at(-2), 2)
  const inner = JSON.parse(JSON.parse(generation.body.get('f.req'))[1])
  assert.equal(inner[79], 6)
  assert.equal(inner[80], 2)
})

test('discovers the Workspace Thinking mode as a standalone model', async (t) => {
  const discovery = modelDiscoveryResponse(
    [modelEntry('flash-id', 'Flash', 'Gemini Flash', 1)],
    [modeEntry(5, '3.6 Thinking')],
  )
  const requests = mockModelFetch(t, discovery)

  await new GeminiWebClient().ask('Q', {}, undefined, {
    model: 'thinking',
    extendedThinking: true,
  })

  const generation = requests[2].init
  const modelHeader = JSON.parse(generation.headers['x-goog-ext-525001261-jspb'])
  assert.equal(modelHeader[4], 'e051ce1aa80aa576')
  assert.equal(modelHeader[11], 2)
  assert.equal(modelHeader[14], 5)
  assert.equal(modelHeader[15], null)
  assert.match(modelHeader[16], /^[\dA-F-]{36}$/)

  const inner = JSON.parse(JSON.parse(generation.body.get('f.req'))[1])
  assert.equal(inner[79], 5)
  assert.equal(inner[80], null)
})

test('rejects standalone Thinking when the account mode picker marks it unavailable', async (t) => {
  const discovery = modelDiscoveryResponse([], [modeEntry(5, '3.6 Thinking', false)])
  const requests = mockModelFetch(t, discovery)

  await assert.rejects(
    new GeminiWebClient().ask('Q', {}, undefined, { model: 'thinking' }),
    /selected model is not available/,
  )
  assert.equal(requests.length, 2)
})

test('does not enable extended thinking with automatic model routing', async (t) => {
  const requests = mockFetch(t)
  await new GeminiWebClient().ask('Q', {}, undefined, {
    model: 'auto',
    extendedThinking: true,
  })

  assert.equal(requests.length, 2)
  const generation = requests[1].init
  assert.equal(generation.headers['x-goog-ext-525001261-jspb'], undefined)
  const inner = JSON.parse(JSON.parse(generation.body.get('f.req'))[1])
  assert.equal(inner[80], 1)
})

test('rejects a model that is unavailable to the signed-in account', async (t) => {
  const discovery = modelDiscoveryResponse([modelEntry('flash-id', 'Flash', 'Gemini Flash', 1)])
  const requests = mockModelFetch(t, discovery)

  await assert.rejects(
    new GeminiWebClient().ask('Q', {}, undefined, { model: 'pro' }),
    /selected model is not available/,
  )
  assert.equal(requests.length, 2)
})
