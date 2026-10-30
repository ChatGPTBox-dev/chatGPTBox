import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithGeminiWebApi } from '../../../../src/services/apis/gemini-web.mjs'
import GeminiWebClient from '../../../../src/services/clients/gemini-web/index.mjs'
import { protocolError } from '../../../../src/services/clients/gemini-web/protocol.mjs'
import { createFakePort } from '../../helpers/port.mjs'

function assertClean(port) {
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
}

function wire(records) {
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

function modelDiscoveryResponse(models) {
  const status = Array(25).fill(null)
  status[14] = 1000
  status[15] = models
  status[16] = [8]
  return wire([['wrb.fr', 'otAQ7b', JSON.stringify(status)]])
}

function bootstrapFetch(t, responseText) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.method !== 'POST') return new Response('{"SNlM0e":"test-at"}')
    if (String(url).includes('/batchexecute?')) {
      return new Response(
        modelDiscoveryResponse([modelEntry('flash-id', 'Flash', 'Gemini Flash', 1)]),
      )
    }
    return new Response(responseText)
  })
}

test('generateAnswersWithGeminiWebApi ignores a superseded response', async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => {
    resolveResponse = resolve
  })
  t.mock.method(GeminiWebClient.prototype, 'ask', () => response)

  const session = { conversationRecords: [] }
  const port = createFakePort()
  let isLatest = true
  const generation = generateAnswersWithGeminiWebApi(port, 'CurrentQ', session, {}, () => isLatest)

  isLatest = false
  resolveResponse({ answer: 'Stale answer', conversationObj: { id: 'stale' } })
  await generation

  assert.deepEqual(session, { conversationRecords: [] })
  assert.deepEqual(port.postedMessages, [])
  assertClean(port)
})

test('default path ignores a superseded port generation', async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => {
    resolveResponse = resolve
  })
  t.mock.method(GeminiWebClient.prototype, 'ask', () => response)

  const session = { conversationRecords: [] }
  const port = createFakePort()
  port._sessionRequestGeneration = 1
  const generation = generateAnswersWithGeminiWebApi(port, 'CurrentQ', session)

  port._sessionRequestGeneration = 2
  resolveResponse({ answer: 'Stale answer', conversationObj: { id: 'stale' } })
  await generation

  assert.deepEqual(session, { conversationRecords: [] })
  assert.deepEqual(port.postedMessages, [])
  assertClean(port)
})

test('stale Gemini completion leaves continuation unsafe', async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => {
    resolveResponse = resolve
  })
  t.mock.method(GeminiWebClient.prototype, 'ask', (...args) => {
    args[3].onPromptSubmitted()
    return response
  })

  const session = {
    conversationRecords: [{ question: 'Q1', answer: 'A1' }],
    geminiWeb_conversation: {
      c: 'c-old',
      r: 'r-old',
      rc: 'rc-old',
      accountPath: '',
      turnIndex: 1,
      modelState: {
        model: 'flash',
        extendedThinking: false,
        routing: {
          id: 'flash-id',
          modelNumber: 1,
          capacity: 2,
          capacityField: 12,
          standaloneThinking: false,
        },
      },
    },
    apiMode: {
      geminiWebModel: 'flash',
      geminiWebExtendedThinking: false,
    },
  }
  const requestPort = createFakePort()
  const connectionPort = createFakePort()
  let isLatest = true
  const pending = generateAnswersWithGeminiWebApi(
    requestPort,
    'Q2',
    session,
    {},
    () => isLatest,
    connectionPort,
  )

  isLatest = false
  resolveResponse({
    answer: 'stale answer',
    conversationObj: {
      c: 'c-new',
      r: 'r-new',
      rc: 'rc-new',
      accountPath: '',
      turnIndex: 2,
    },
  })
  await pending

  assert.equal(connectionPort._geminiConversationUnsafe, true)
  assert.equal(session.geminiWeb_conversationUnsafe, true)
  assert.equal(session.geminiWeb_conversation.c, 'c-old')
  assert.deepEqual(session.conversationRecords, [{ question: 'Q1', answer: 'A1' }])
})

test('superseded session hook aborts an in-flight Gemini request and cleans up', async (t) => {
  let requestStarted
  const started = new Promise((resolve) => {
    requestStarted = resolve
  })
  t.mock.method(GeminiWebClient.prototype, 'ask', (...args) => {
    const signal = args[2]
    requestStarted()
    return new Promise((...[, reject]) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  const session = { conversationRecords: [] }
  const port = createFakePort()
  const pending = generateAnswersWithGeminiWebApi(port, 'Q', session)

  await started
  assert.equal(typeof port._abortSupersededSessionRequest, 'function')
  port._abortSupersededSessionRequest()

  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(Object.hasOwn(port, '_abortSupersededSessionRequest'), false)
  assertClean(port)
})

test('a superseded submitted turn makes its saved Gemini continuation unsafe', async (t) => {
  let requestStarted
  const started = new Promise((resolve) => {
    requestStarted = resolve
  })
  t.mock.method(GeminiWebClient.prototype, 'ask', (...args) => {
    const signal = args[2]
    args[3].onPromptSubmitted()
    requestStarted()
    return new Promise((...[, reject]) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  const session = {
    conversationRecords: [{ question: 'Q1', answer: 'A1' }],
    geminiWeb_conversation: {
      c: 'c-old',
      r: 'r-old',
      rc: 'rc-old',
      accountPath: '',
      turnIndex: 1,
      modelState: {
        model: 'flash',
        extendedThinking: false,
        routing: {
          id: 'flash-id',
          modelNumber: 1,
          capacity: 2,
          capacityField: 12,
          standaloneThinking: false,
        },
      },
    },
    apiMode: {
      geminiWebModel: 'flash',
      geminiWebExtendedThinking: false,
    },
  }
  const connectionPort = createFakePort()
  const firstRequestPort = createFakePort()
  const pending = generateAnswersWithGeminiWebApi(
    firstRequestPort,
    'Q2',
    session,
    {},
    () => true,
    connectionPort,
  )

  await started
  assert.deepEqual(firstRequestPort.postedMessages, [{ geminiWebContinuationSubmitted: true }])
  connectionPort._abortSupersededSessionRequest()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(connectionPort._geminiConversationUnsafe, true)

  let askCount = 0
  t.mock.restoreAll()
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    askCount += 1
    throw new Error('unexpected request')
  })

  const secondRequestPort = createFakePort()
  await assert.rejects(
    generateAnswersWithGeminiWebApi(
      secondRequestPort,
      'Q3',
      session,
      {},
      () => true,
      connectionPort,
    ),
    /previous Gemini request may have changed the remote conversation/,
  )
  assert.equal(askCount, 0)
  assert.equal(connectionPort._geminiConversationUnsafe, true)
  assert.equal(session.geminiWeb_conversationUnsafe, true)
  assert.deepEqual(secondRequestPort.postedMessages, [{ geminiWebConversationUnsafe: true }])
  assertClean(firstRequestPort)
  assertClean(secondRequestPort)
})

test('successful turns strip obsolete Gemini account identity from retry snapshots', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...[, conversation]) => {
    assert.equal(conversation.accountId, 'obsolete-gaia-id')
    return {
      answer: 'ok',
      conversationObj: {
        c: 'c-new',
        r: 'r-new',
        rc: 'rc-new',
        accountPath: '',
      },
    }
  })

  const session = {
    conversationRecords: [],
    geminiWeb_conversation: {
      c: 'c-old',
      r: 'r-old',
      rc: 'rc-old',
      accountPath: '',
      accountId: 'obsolete-gaia-id',
    },
  }
  const port = createFakePort()

  await generateAnswersWithGeminiWebApi(port, 'Q', session)

  assert.equal(Object.hasOwn(session.geminiWeb_previousConversation, 'accountId'), false)
  assert.equal(Object.hasOwn(session.geminiWeb_conversation, 'accountId'), false)
  assertClean(port)
})

test('successful legacy session state migrates to the Gemini field', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...[, conversation]) => {
    assert.equal(conversation.c, 'c_old')
    return { answer: 'ok', conversationObj: { c: 'c_new' } }
  })

  const session = {
    conversationRecords: [],
    bard_conversationObj: { c: 'c_old', accountPath: '' },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)

  assert.equal(session.bard_conversationObj, undefined)
  assert.deepEqual(session.geminiWeb_conversation, { c: 'c_new' })
  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'ok' }])
  assertClean(port)
})

test('explicit model mismatch fails before committing the returned turn', async (t) => {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => ({
    answer: 'served by Flash',
    conversationObj: {
      c: 'c-new',
      r: 'r-new',
      rc: 'rc-new',
      accountPath: '',
      turnIndex: 2,
    },
    diagnostics: {
      servedModelId: 'flash-id',
      servedModelLabel: '3.6 Flash',
      servedModelNumber: 1,
      servedModelVariant: 1,
      providerStatusCodes: [],
    },
  }))

  const session = {
    conversationRecords: [{ question: 'Q1', answer: 'A1' }],
    geminiWeb_conversation: {
      c: 'c-old',
      r: 'r-old',
      rc: 'rc-old',
      accountPath: '',
      turnIndex: 1,
      modelState: {
        model: 'pro',
        extendedThinking: false,
        routing: {
          id: 'pro-id',
          modelNumber: 3,
          capacity: 2,
          capacityField: 12,
          standaloneThinking: false,
        },
      },
    },
    apiMode: {
      geminiWebModel: 'pro',
      geminiWebExtendedThinking: false,
    },
  }
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'Q2', session),
    /selected model is not available/,
  )
  assert.deepEqual(session.conversationRecords, [{ question: 'Q1', answer: 'A1' }])
  assert.equal(Object.hasOwn(session, 'geminiWeb_previousConversation'), false)
  assert.equal(session.geminiWeb_conversation.c, 'c-old')
  assert.equal(session.geminiWeb_conversation.turnIndex, 1)
  assert.equal(session.geminiWeb_conversationUnsafe, true)
  assert.deepEqual(port.postedMessages, [{ geminiWebConversationUnsafe: true }])
  assertClean(port)
})

test('served model identity is checked when numeric diagnostics are unavailable', async (t) => {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => ({
    answer: 'wrong model',
    conversationObj: {
      c: 'c-new',
      r: 'r-new',
      rc: 'rc-new',
      modelState: { routing: { id: 'pro-id' } },
    },
    diagnostics: { servedModelId: 'flash-id', servedModelLabel: 'Renamed model' },
  }))

  const session = {
    apiMode: { geminiWebModel: 'pro', geminiWebExtendedThinking: false },
    conversationRecords: [],
  }
  await assert.rejects(
    generateAnswersWithGeminiWebApi(createFakePort(), 'Q1', session),
    /selected model is not available/,
  )
  assert.deepEqual(session.conversationRecords, [])
})

test('served model ID mismatch overrides a matching label without numeric data', async (t) => {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => ({
    answer: 'unexpected Pro',
    conversationObj: {
      c: 'c-new',
      r: 'r-new',
      rc: 'rc-new',
      modelState: { routing: { id: 'pro-id' } },
    },
    diagnostics: { servedModelId: 'flash-id', servedModelLabel: '3.6 Pro' },
  }))

  const session = {
    apiMode: { geminiWebModel: 'pro', geminiWebExtendedThinking: false },
    conversationRecords: [],
  }
  await assert.rejects(
    generateAnswersWithGeminiWebApi(createFakePort(), 'Q1', session),
    /selected model is not available/,
  )
  assert.deepEqual(session.conversationRecords, [])
})

test('served model number wins over cosmetic label changes', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => ({
    answer: 'served by renamed Flash',
    conversationObj: {
      c: 'c-new',
      r: 'r-new',
      rc: 'rc-new',
      accountPath: '',
      turnIndex: 1,
    },
    diagnostics: {
      servedModelId: 'flash-id',
      servedModelLabel: 'Gemini Fast',
      servedModelNumber: 1,
      servedModelVariant: 1,
      providerStatusCodes: [],
    },
  }))

  const session = {
    conversationRecords: [],
    apiMode: {
      geminiWebModel: 'flash',
      geminiWebExtendedThinking: false,
    },
  }
  const port = createFakePort()

  await generateAnswersWithGeminiWebApi(port, 'Q1', session)

  assert.deepEqual(session.conversationRecords, [
    { question: 'Q1', answer: 'served by renamed Flash' },
  ])
  assert.equal(session.geminiWeb_conversationUnsafe, undefined)
  assertClean(port)
})

test('uses model and thinking options from the selected API mode preset', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    const { isRequestCurrent, onPromptSubmitted, ...options } = args[3]
    assert.equal(typeof isRequestCurrent, 'function')
    assert.equal(isRequestCurrent(), true)
    assert.equal(typeof onPromptSubmitted, 'function')
    assert.deepEqual(options, {
      model: 'flash',
      temporary: true,
      extendedThinking: true,
    })
    return { answer: 'ok', conversationObj: { c: 'c_new' } }
  })

  const session = {
    conversationRecords: [],
    apiMode: {
      geminiWebModel: 'flash',
      geminiWebExtendedThinking: true,
    },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session, {
    disableWebModeHistory: true,
    geminiWebModel: 'pro',
    geminiWebExtendedThinking: false,
  })
  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'ok' }])
  assertClean(port)
})

test('uses standalone Thinking without the extended-thinking toggle', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'thinking')
    assert.equal(args[3].extendedThinking, false)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: {
      geminiWebModel: 'thinking',
      geminiWebExtendedThinking: true,
    },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)
  assertClean(port)
})

test('uses the legacy API mode custom label as a compatibility fallback', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'pro')
    assert.equal(args[3].extendedThinking, true)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: { customName: 'Pro + Extended thinking' },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)
  assertClean(port)
})

test('uses a standalone Thinking label as a compatibility fallback', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'thinking')
    assert.equal(args[3].extendedThinking, false)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: { customName: 'Thinking' },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)
  assertClean(port)
})

test('uses the compact thinking marker as a compatibility fallback', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'flash')
    assert.equal(args[3].extendedThinking, true)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: { customName: 'Flash 🧠' },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)
  assertClean(port)
})

test('explicit disabled thinking wins over a compact label hint', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'flash')
    assert.equal(args[3].extendedThinking, false)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: {
      customName: 'Flash 🧠',
      geminiWebModel: 'flash',
      geminiWebExtendedThinking: false,
    },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)
  assertClean(port)
})

test('keeps the hidden global model setting only as a compatibility fallback', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'flash')
    assert.equal(args[3].extendedThinking, true)
    return { answer: 'ok', conversationObj: {} }
  })

  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(
    port,
    'Q',
    { conversationRecords: [] },
    {
      geminiWebModel: 'flash',
      geminiWebExtendedThinking: true,
    },
  )
  assertClean(port)
})

test('explicit disabled thinking wins over the hidden global fallback', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].model, 'flash')
    assert.equal(args[3].extendedThinking, false)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: {
      customName: 'My Gemini',
      geminiWebExtendedThinking: false,
    },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session, {
    geminiWebModel: 'flash',
    geminiWebExtendedThinking: true,
  })
  assertClean(port)
})

test('does not pass extended thinking with automatic model routing', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    assert.equal(args[3].extendedThinking, false)
    return { answer: 'ok', conversationObj: {} }
  })

  const session = {
    conversationRecords: [],
    apiMode: {
      geminiWebModel: 'auto',
      geminiWebExtendedThinking: true,
    },
  }
  const port = createFakePort()
  await generateAnswersWithGeminiWebApi(port, 'Q', session)
  assertClean(port)
})

test('protocol failures preserve state and report only safe pre-submit resolution', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    throw protocolError('Invalid text candidate.')
  })

  const session = {
    conversationRecords: [{ question: 'old', answer: 'old answer' }],
    geminiWeb_conversation: { c: 'c_old', accountPath: '' },
  }
  const before = structuredClone(session)
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'Q', session),
    /Invalid text candidate/,
  )
  assert.deepEqual(session, before)
  assert.deepEqual(port.postedMessages, [{ geminiWebContinuationSafe: true }])
  assertClean(port)
})

for (const action of ['stop', 'disconnect']) {
  test(`${action} aborts the in-flight Gemini request without changing state`, async (t) => {
    let started
    const requestStarted = new Promise((resolve) => {
      started = resolve
    })
    t.mock.method(GeminiWebClient.prototype, 'ask', (...args) => {
      const signal = args[2]
      started()
      return new Promise((...[, reject]) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })

    const session = {
      conversationRecords: [{ question: 'old', answer: 'old answer' }],
      geminiWeb_conversation: { c: 'c_old', accountPath: '' },
    }
    const before = structuredClone(session)
    const port = createFakePort()
    const pending = generateAnswersWithGeminiWebApi(port, 'Q', session)

    await requestStarted
    if (action === 'stop') port.emitMessage({ stop: true, stopGenerationId: 7 })
    else port.emitDisconnect()

    await assert.rejects(pending, { name: 'AbortError' })
    assert.deepEqual(session, before)
    assert.deepEqual(
      port.postedMessages,
      action === 'stop' ? [{ done: true, stoppedGenerationId: 7 }] : [],
    )
    assertClean(port)
  })
}

test('malformed candidate content cannot update history or conversation state', async (t) => {
  const candidate = ['rc_new', 'BAD']
  candidate[8] = [2]
  const payload = [null, ['c_new', 'r_new'], null, null, [candidate]]
  bootstrapFetch(t, wire([['wrb.fr', null, JSON.stringify(payload)]]))

  const session = { conversationRecords: [] }
  const before = structuredClone(session)
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'private question', session),
    /Invalid text candidate/,
  )
  assert.deepEqual(session, before)
  assert.deepEqual(port.postedMessages, [])
  assertClean(port)
})

test('unconfirmed framed answers cannot update history or conversation state', async (t) => {
  const candidate = ['rc_new', ['partial answer']]
  const payload = [null, ['c_new', 'r_new'], null, null, [candidate]]
  bootstrapFetch(t, wire([['wrb.fr', null, JSON.stringify(payload)]]))

  const session = { conversationRecords: [] }
  const before = structuredClone(session)
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGeminiWebApi(port, 'private question', session),
    /confirm.*finished generating/,
  )
  assert.deepEqual(session, before)
  assert.deepEqual(port.postedMessages, [])
  assertClean(port)
})

test('an invalid structured Gemini model fails before the client is started', async (t) => {
  let askCalls = 0
  let fetchCalls = 0
  t.mock.method(GeminiWebClient.prototype, 'ask', async () => {
    askCalls += 1
    throw new Error('Gemini client should not be called')
  })
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1
    throw new Error('Gemini network request should not be made')
  })

  const session = {
    conversationRecords: [],
    apiMode: {
      customName: 'Flash',
      geminiWebModel: 'garbage-value',
      geminiWebExtendedThinking: false,
    },
  }
  const port = createFakePort()

  await assert.rejects(
    () =>
      generateAnswersWithGeminiWebApi(port, 'Question', session, {
        geminiWebModel: 'flash',
        geminiWebExtendedThinking: false,
      }),
    /Invalid Gemini Web model selection/,
  )

  assert.equal(askCalls, 0)
  assert.equal(fetchCalls, 0)
  assert.deepEqual(port.postedMessages, [])
  assertClean(port)
})
