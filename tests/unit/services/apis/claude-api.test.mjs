import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithClaudeApi } from '../../../../src/services/apis/claude-api.mjs'
import { FETCH_RESPONSE_STREAM_FAILED } from '../../../../src/utils/fetch-sse.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

const setupCompletionTest = (modelName = 'claudeOpus5Api') => {
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 100,
    temperature: 0.5,
  })
  return {
    session: {
      modelName,
      conversationRecords: [],
      isRetry: false,
    },
    port: createFakePort(),
  }
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('claude-api: sends correct URL and headers', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 512,
    temperature: 0.7,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Hello', session)

  assert.equal(capturedInput, 'https://api.anthropic.com/v1/messages')
  assert.equal(capturedInit.headers['x-api-key'], 'sk-ant-test')
  assert.equal(capturedInit.headers['anthropic-version'], '2023-06-01')
  assert.equal(capturedInit.headers['anthropic-dangerous-direct-browser-access'], true)
  assert.equal(capturedInit.headers['Content-Type'], 'application/json')
})

test('claude-api: sends model, max_tokens, temperature in body', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 1024,
    temperatureOverrideEnabled: true,
    temperature: 0.9,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Q', session)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.model, 'claude-sonnet-4-6')
  assert.equal(body.max_tokens, 1024)
  assert.equal(body.temperature, 0.9)
  assert.equal(body.stream, true)
})

test('claude-api: uses the provider temperature default', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 1024,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Q', session)

  const body = JSON.parse(capturedInit.body)
  assert.equal(Object.hasOwn(body, 'temperature'), false)
})

test('claude-api: keeps temperature for Opus 4.6', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 1024,
    temperatureOverrideEnabled: true,
    temperature: 0.9,
  })

  const session = {
    modelName: 'claudeOpus46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Q', session)

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.model, 'claude-opus-4-6')
  assert.equal(body.max_tokens, 1024)
  assert.equal(body.temperature, 0.9)
  assert.equal(body.stream, true)
})

test('claude-api: omits temperature for models that reject custom sampling', async (t) => {
  t.mock.method(console, 'debug', () => {})

  for (const [modelName, model] of [
    ['claudeOpus47Api', 'claude-opus-4-7'],
    ['claudeOpus48Api', 'claude-opus-4-8'],
    ['claudeOpus5Api', 'claude-opus-5'],
    ['claudeSonnet5Api', 'claude-sonnet-5'],
  ]) {
    await t.test(modelName, async (t) => {
      setStorage({
        customClaudeApiUrl: 'https://api.anthropic.com',
        claudeApiKey: 'sk-ant-test',
        maxConversationContextLength: 3,
        maxResponseTokenLength: 1024,
        temperatureOverrideEnabled: true,
        temperature: 0.9,
      })

      const session = {
        modelName,
        conversationRecords: [],
        isRetry: false,
      }
      const port = createFakePort()

      let capturedInit
      t.mock.method(globalThis, 'fetch', async (_input, init) => {
        capturedInit = init
        return createMockSseResponse([
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ])
      })

      await generateAnswersWithClaudeApi(port, 'Q', session)

      const body = JSON.parse(capturedInit.body)
      assert.equal(body.model, model)
      assert.equal(body.max_tokens, 1024)
      assert.equal(body.stream, true)
      assert.equal(Object.hasOwn(body, 'temperature'), false)
      if (model === 'claude-sonnet-5') {
        assert.deepEqual(body.thinking, { type: 'disabled' })
      } else {
        assert.equal(Object.hasOwn(body, 'thinking'), false)
      }
    })
  }
})

test('claude-api: delta.text streams accumulate and message_stop terminates', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA' }],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'CurrentQ', session)

  assert.deepEqual(port.postedMessages, [
    { answer: 'Hel', done: false, session: null },
    { answer: 'Hello', done: false, session: null },
    { answer: null, done: true, session },
  ])
})

test('claude-api: rejects incomplete Claude responses', async (t) => {
  t.mock.method(console, 'debug', () => {})

  for (const { name, modelName, contentEvents, stopReason, error, partialAnswer } of [
    {
      name: 'thinking exhausts the response token limit',
      modelName: 'claudeOpus5Api',
      contentEvents: [
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}\n\n',
      ],
      stopReason: 'max_tokens',
      error: /Claude reached the response token limit/,
    },
    {
      name: 'text is truncated at the response token limit',
      modelName: 'claudeSonnet46Api',
      contentEvents: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
      ],
      stopReason: 'max_tokens',
      error: /Claude reached the response token limit/,
      partialAnswer: 'Partial',
    },
    {
      name: 'the model context window is exhausted',
      modelName: 'claudeOpus5Api',
      contentEvents: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
      ],
      stopReason: 'model_context_window_exceeded',
      error: /Claude reached the model context window limit/,
      partialAnswer: 'Partial',
    },
    {
      name: 'the request is refused',
      modelName: 'claudeHaiku45Api',
      contentEvents: [],
      stopReason: 'refusal',
      error: /Claude declined to respond to this request/,
    },
    {
      name: 'the turn is paused',
      modelName: 'claudeOpus5Api',
      contentEvents: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
      ],
      stopReason: 'pause_turn',
      error: /Claude response stream ended before completion/,
      partialAnswer: 'Partial',
    },
    {
      name: 'the stop reason is unknown',
      modelName: 'claudeOpus5Api',
      contentEvents: [],
      stopReason: 'future_stop_reason',
      error: /Claude response stream ended before completion/,
    },
    {
      name: 'the stop reason is missing',
      modelName: 'claudeOpus5Api',
      contentEvents: [],
      error: /Claude response stream ended before completion/,
    },
  ]) {
    await t.test(name, async (t) => {
      const { session, port } = setupCompletionTest(modelName)

      t.mock.method(globalThis, 'fetch', async () =>
        createMockSseResponse([
          ...contentEvents,
          ...(stopReason
            ? [`data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}\n\n`]
            : []),
          'data: {"type":"message_stop"}\n\n',
        ]),
      )

      await assert.rejects(generateAnswersWithClaudeApi(port, 'Q', session), error)
      if (partialAnswer) {
        assert.equal(
          port.postedMessages.some(
            (message) => message.done === false && message.answer === partialAnswer,
          ),
          true,
        )
      }
      assert.equal(
        port.postedMessages.some((message) => message.done === true && message.session === session),
        false,
      )
      assert.deepEqual(session.conversationRecords, [])
      assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
    })
  }
})

test('claude-api: preserves streamed API error details', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  const providerError = { type: 'overloaded_error', message: 'Overloaded' }
  const errorEnvelope = { type: 'error', error: providerError, request_id: 'req_test' }
  let readCount = 0
  let requestSignal
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    requestSignal = init.signal
    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1
              if (readCount > 1) throw new Error('read after streamed API error')
              return {
                done: false,
                value: new TextEncoder().encode(
                  `event: error\ndata: ${JSON.stringify(errorEnvelope)}\n\n` +
                    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n' +
                    'data: {"type":"message_stop"}\n\n',
                ),
              }
            },
          }
        },
      },
    }
  })

  await assert.rejects(generateAnswersWithClaudeApi(port, 'Q', session), (error) => {
    assert.deepEqual(JSON.parse(error.message), errorEnvelope)
    return true
  })
  assert.equal(readCount, 1)
  assert.equal(requestSignal.aborted, true)
  assert.deepEqual(session.conversationRecords, [])
  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    false,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: preserves success before a later streamed API error', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  let requestSignal
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    requestSignal = init.signal
    return createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Later"}}\n\n' +
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
    ])
  })

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.equal(requestSignal.aborted, true)
  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'Answer' }])
  assert.deepEqual(port.postedMessages, [
    { answer: 'Answer', done: false, session: null },
    { answer: null, done: true, session },
  ])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: accepts stop_sequence as a completed response', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"stop_sequence"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'Answer' }])
  assert.equal(
    port.postedMessages.some((message) => message.done === true && message.session === session),
    true,
  )
})

test('claude-api: stops an in-progress response without reporting an error', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const response = createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
    ])
    const reader = response.body.getReader()
    response.body.getReader = () => ({
      async read() {
        const result = await reader.read()
        if (result.done) {
          port.emitMessage({ stop: true })
          assert.equal(init.signal.aborted, true)
          throw new DOMException('Aborted', 'AbortError')
        }
        return result
      },
    })
    return response
  })

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.deepEqual(session.conversationRecords, [])
  assert.deepEqual(port.postedMessages, [
    { answer: 'Partial', done: false, session: null },
    { done: true },
  ])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: preserves a successful response when the stream later fails', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  const response = createMockSseResponse([
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Later"}}\n\n',
  ])
  const reader = response.body.getReader()
  response.body.getReader = () => ({
    async read() {
      const result = await reader.read()
      if (result.done) throw new Error('stream failed after message_stop')
      return result
    },
  })
  t.mock.method(globalThis, 'fetch', async () => response)

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer: 'Answer' }])
  assert.deepEqual(port.postedMessages, [
    { answer: 'Answer', done: false, session: null },
    { answer: null, done: true, session },
  ])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: rejects a clean EOF before message_stop', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
    ]),
  )

  await assert.rejects(
    generateAnswersWithClaudeApi(port, 'Q', session),
    /Claude response stream ended before completion/,
  )

  assert.deepEqual(session.conversationRecords, [])
  assert.deepEqual(port.postedMessages, [{ answer: 'Partial', done: false, session: null }])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: propagates callback errors after successful completion', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  port.onMessage.removeListener = () => {
    throw new Error('listener cleanup failed')
  }
  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await assert.rejects(generateAnswersWithClaudeApi(port, 'Q', session), /listener cleanup failed/)
  assert.equal(port.listenerCounts().onDisconnect, 0)
})

test('claude-api: propagates response stream errors before message_stop', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  const response = createMockSseResponse([
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
  ])
  const reader = response.body.getReader()
  response.body.getReader = () => ({
    async read() {
      const result = await reader.read()
      if (result.done) throw new Error('stream interrupted')
      return result
    },
  })
  t.mock.method(globalThis, 'fetch', async () => response)

  await assert.rejects(generateAnswersWithClaudeApi(port, 'Q', session), (error) => {
    assert.equal(error.code, FETCH_RESPONSE_STREAM_FAILED)
    assert.match(error.message, /stream interrupted/)
    return true
  })
  assert.deepEqual(session.conversationRecords, [])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: reports an incomplete stop reason without waiting for EOF', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const { session, port } = setupCompletionTest()
  let readCount = 0
  let requestSignal
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    requestSignal = init.signal
    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1
              if (readCount > 1) throw new Error('read after incomplete message_stop')
              return {
                done: false,
                value: new TextEncoder().encode(
                  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n' +
                    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n' +
                    'data: {"type":"message_stop"}\n\n',
                ),
              }
            },
          }
        },
      },
    }
  })

  await assert.rejects(
    generateAnswersWithClaudeApi(port, 'Q', session),
    /Claude reached the response token limit/,
  )

  assert.equal(readCount, 1)
  assert.equal(requestSignal.aborted, true)
  assert.deepEqual(session.conversationRecords, [])
  assert.deepEqual(port.postedMessages, [{ answer: 'Partial', done: false, session: null }])
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: pushRecord on message_stop', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'MyQ', session)

  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'MyQ',
    answer: 'Answer',
  })
})

test('claude-api: cleans up listeners on end', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: throws on error response', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'bad-key',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperature: 0.1,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([], {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid x-api-key' } }),
    }),
  )

  await assert.rejects(
    async () => generateAnswersWithClaudeApi(port, 'Q', session),
    /invalid x-api-key/,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('claude-api: ignores unparseable JSON messages', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    customClaudeApiUrl: 'https://api.anthropic.com',
    claudeApiKey: 'sk-ant-test',
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
    temperature: 0.5,
  })

  const session = {
    modelName: 'claudeSonnet46Api',
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()

  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: not-valid-json\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]),
  )

  await generateAnswersWithClaudeApi(port, 'Q', session)

  assert.equal(
    port.postedMessages.some((m) => m.done === false && m.answer === 'OK'),
    true,
  )
})
