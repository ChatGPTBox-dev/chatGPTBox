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

function bootstrapFetch(t, responseText) {
  t.mock.method(globalThis, 'fetch', async (...[, init]) => {
    if (init.method === 'POST') return new Response(responseText)
    return new Response('{"SNlM0e":"test-at"}')
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

test('uses model and thinking options from the selected API mode preset', async (t) => {
  t.mock.method(GeminiWebClient.prototype, 'ask', async (...args) => {
    const { isRequestCurrent, ...options } = args[3]
    assert.equal(typeof isRequestCurrent, 'function')
    assert.equal(isRequestCurrent(), true)
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

test('protocol failures preserve conversation state and do not report success', async (t) => {
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
  assert.deepEqual(port.postedMessages, [])
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
