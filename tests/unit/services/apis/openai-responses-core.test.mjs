import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  applyResponsesStreamEvent,
  buildResponsesBody,
  buildResponsesInput,
  extractResponsesOutputText,
  generateAnswersWithOpenAIResponses,
  isResponsesRouteUnsupportedError,
} from '../../../../src/services/apis/openai-responses-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('buildResponsesInput maps history pairs and appends the current question', () => {
  const input = buildResponsesInput(
    [
      { question: 'PrevQ', answer: 'PrevA' },
      { question: 'Q2', answer: 'A2' },
    ],
    'CurrentQ',
    9,
  )
  assert.deepEqual(input, [
    { role: 'user', content: 'PrevQ' },
    { role: 'assistant', content: 'PrevA' },
    { role: 'user', content: 'Q2' },
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'CurrentQ' },
  ])
})

test('buildResponsesInput respects maxConversationContextLength', () => {
  const input = buildResponsesInput([{ question: 'Old', answer: 'OldA' }], 'CurrentQ', 0)
  assert.deepEqual(input, [{ role: 'user', content: 'CurrentQ' }])
})

test('buildResponsesBody uses max_output_tokens and drops chat-only keys', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.6',
    input: [{ role: 'user', content: 'hi' }],
    config: { maxResponseTokenLength: 321 },
    extraBody: {
      max_tokens: 1,
      max_completion_tokens: 2,
      messages: [{ role: 'user', content: 'ignored' }],
      temperature: 0.1,
      stream: false,
    },
  })
  assert.equal(body.model, 'gpt-5.6')
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.max_output_tokens, 321)
  assert.equal(Object.hasOwn(body, 'max_tokens'), false)
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false)
  assert.equal(Object.hasOwn(body, 'messages'), false)
  assert.equal(Object.hasOwn(body, 'temperature'), false)
})

test('buildResponsesBody converts response_format to text.format', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.6',
    input: 'hi',
    config: { maxResponseTokenLength: 100 },
    extraBody: {
      response_format: {
        type: 'json_schema',
        name: 'answer',
        strict: true,
        schema: { type: 'object' },
      },
    },
  })
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'answer',
      strict: true,
      schema: { type: 'object' },
    },
  })
  assert.equal(Object.hasOwn(body, 'response_format'), false)
})

for (const { label, fields, expected } of [
  {
    label: 'nested metadata',
    fields: { json_schema: { name: 'nested_answer', strict: false, schema: { type: 'object' } } },
    expected: { name: 'nested_answer', strict: false, schema: { type: 'object' } },
  },
  {
    label: 'top-level metadata takes precedence',
    fields: {
      name: 'top_answer',
      strict: false,
      schema: { type: 'string' },
      json_schema: { name: 'nested_answer', strict: true, schema: { type: 'object' } },
    },
    expected: { name: 'top_answer', strict: false, schema: { type: 'string' } },
  },
  {
    label: 'explicit top-level true overrides nested false',
    fields: { strict: true, json_schema: { name: 'nested_answer', strict: false } },
    expected: { name: 'nested_answer', strict: true, schema: {} },
  },
  {
    label: 'missing metadata keeps defaults',
    fields: {},
    expected: { name: 'response', strict: true, schema: {} },
  },
  {
    label: 'nullish metadata falls back to nested fields',
    fields: { name: '', strict: null, json_schema: { name: 'nested_answer', strict: false } },
    expected: { name: 'nested_answer', strict: false, schema: {} },
  },
]) {
  test(`buildResponsesBody preserves schema contract: ${label}`, () => {
    const extraBody = { response_format: { type: 'json_schema', ...fields } }
    const original = structuredClone(extraBody)
    const body = buildResponsesBody({ model: 'test', input: 'hi', config: {}, extraBody })
    assert.deepEqual(body.text.format, { type: 'json_schema', ...expected })
    assert.equal(Object.hasOwn(body, 'response_format'), false)
    assert.deepEqual(extraBody, original)
  })
}

test('buildResponsesBody preserves explicit text instead of converting response_format', () => {
  const text = { format: { type: 'json_object' } }
  const body = buildResponsesBody({
    model: 'test',
    input: 'hi',
    config: {},
    extraBody: {
      text,
      response_format: { type: 'json_schema', json_schema: { name: 'ignored', strict: false } },
    },
  })
  assert.deepEqual(body.text, text)
  assert.equal(Object.hasOwn(body, 'response_format'), false)
})

test('extractResponsesOutputText reads output_text and message items', () => {
  assert.equal(extractResponsesOutputText({ output_text: 'direct' }), 'direct')
  assert.equal(
    extractResponsesOutputText({
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello ' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'world' }],
        },
      ],
    }),
    'Hello world',
  )
  assert.equal(extractResponsesOutputText({}), '')
})

test('applyResponsesStreamEvent accumulates deltas and finishes on completed', () => {
  let result = applyResponsesStreamEvent('', {
    type: 'response.output_text.delta',
    delta: 'Hel',
  })
  assert.equal(result.answer, 'Hel')
  assert.equal(result.done, false)

  result = applyResponsesStreamEvent(result.answer, {
    type: 'response.output_text.delta',
    delta: 'lo',
  })
  assert.equal(result.answer, 'Hello')

  result = applyResponsesStreamEvent(result.answer, { type: 'response.completed' })
  assert.equal(result.done, true)
  assert.equal(result.answer, 'Hello')
})

test('applyResponsesStreamEvent surfaces error events', () => {
  const result = applyResponsesStreamEvent('partial', {
    type: 'error',
    message: 'boom',
    error: { message: 'boom' },
  })
  assert.equal(result.failed, true)
  assert.match(result.error.message, /boom/)
})

test('generateAnswersWithOpenAIResponses streams typed events into one answer', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ maxConversationContextLength: 3, maxResponseTokenLength: 256 })

  const session = {
    modelName: 'chatgptApi5_6',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA' }],
    isRetry: false,
  }
  const port = createFakePort()

  let capturedInput
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    capturedInput = input
    capturedInit = init
    return createMockSseResponse([
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ])
  })

  await generateAnswersWithOpenAIResponses({
    port,
    question: 'CurrentQ',
    session,
    requestUrl: 'https://api.openai.com/v1/responses',
    model: 'gpt-5.6',
    apiKey: 'sk-test',
    config: {
      maxConversationContextLength: 3,
      maxResponseTokenLength: 256,
    },
  })

  assert.equal(capturedInput, 'https://api.openai.com/v1/responses')
  const body = JSON.parse(capturedInit.body)
  assert.equal(body.model, 'gpt-5.6')
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.max_output_tokens, 256)
  assert.deepEqual(body.input.at(-1), { role: 'user', content: 'CurrentQ' })
  assert.equal(
    port.postedMessages.some((message) => message.done === false && message.answer === 'Hello'),
    true,
  )
  assert.deepEqual(port.postedMessages.at(-1), { answer: null, done: true, session })
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'CurrentQ', answer: 'Hello' })
})

for (const transport of ['JSON', 'split JSON', 'SSE']) {
  test(`generateAnswersWithOpenAIResponses rejects failed ${transport} responses without saving or finishing`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    const records = [{ question: 'PrevQ', answer: 'PrevA' }]
    const session = {
      modelName: 'chatgptApi5_6',
      conversationRecords: [...records],
      isRetry: false,
    }
    const port = createFakePort()
    const response = {
      id: 'resp_failed',
      object: 'response',
      status: 'failed',
      error: { code: 'server_error', message: 'Provider could not complete the response' },
      output: [],
    }
    const chunk =
      transport !== 'SSE'
        ? JSON.stringify(response)
        : `data: ${JSON.stringify({ type: 'response.failed', response })}\n\ndata: [DONE]\n\n`
    const chunks = transport === 'split JSON' ? [chunk.slice(0, 25), chunk.slice(25)] : [chunk]
    t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(chunks))

    await assert.rejects(
      generateAnswersWithOpenAIResponses({
        port,
        question: 'Q',
        session,
        requestUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5.6',
        apiKey: 'sk-test',
        config: { maxConversationContextLength: 9, maxResponseTokenLength: 100 },
      }),
      { message: response.error.message },
    )

    assert.deepEqual(session.conversationRecords, records)
    assert.equal(
      port.postedMessages.some((message) => message.done === true),
      false,
    )
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

for (const { split, answer } of [
  { split: false, answer: 'Hello' },
  { split: true, answer: 'Hello' },
  { split: false, answer: '' },
  { split: true, answer: '' },
]) {
  test(`generateAnswersWithOpenAIResponses validates a completed JSON response before saving (split: ${split}, answer: ${JSON.stringify(
    answer,
  )})`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    const session = { modelName: 'chatgptApi5_6', conversationRecords: [], isRetry: false }
    const port = createFakePort()
    const json = JSON.stringify({
      id: 'resp_completed',
      object: 'response',
      status: 'completed',
      error: null,
      output: answer ? [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] : [],
    })
    t.mock.method(globalThis, 'fetch', async () =>
      createMockSseResponse(split ? [json.slice(0, 25), json.slice(25)] : [json]),
    )

    const request = generateAnswersWithOpenAIResponses({
      port,
      question: 'Q',
      session,
      requestUrl: 'https://api.openai.com/v1/responses',
      model: 'gpt-5.6',
      apiKey: 'sk-test',
      config: { maxConversationContextLength: 9, maxResponseTokenLength: 100 },
    })

    if (!answer) {
      await assert.rejects(request, { message: 'Responses API completed without output text' })
      assert.deepEqual(session.conversationRecords, [])
      assert.equal(
        port.postedMessages.some((message) => message.done || message.session),
        false,
      )
      assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
      return
    }
    await request
    assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer }])
    assert.deepEqual(
      port.postedMessages.filter((message) => message.done === true),
      [{ answer: null, done: true, session }],
    )
  })
}

test('generateAnswersWithOpenAIResponses saves split JSON with whitespace and UTF-8 once', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = { modelName: 'chatgptApi5_6', conversationRecords: [], isRetry: false }
  const port = createFakePort()
  const answer = 'Hello 臺灣 🌏'
  const bytes = new TextEncoder().encode(
    ` \r\n\t${JSON.stringify({ status: 'completed', output_text: answer })}`,
  )
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
            controller.close()
          },
        }),
      ),
  )

  await generateAnswersWithOpenAIResponses({
    port,
    question: 'Q',
    session,
    requestUrl: 'https://api.openai.com/v1/responses',
    model: 'gpt-5.6',
    config: {},
  })

  assert.deepEqual(session.conversationRecords, [{ question: 'Q', answer }])
  assert.equal(
    port.postedMessages.some((message) => message.answer === answer),
    true,
  )
  assert.equal(port.postedMessages.filter((message) => message.done === true).length, 1)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

for (const { name, chunks, error } of [
  { name: 'malformed JSON', chunks: ['{"status":', 'invalid}'], error: SyntaxError },
  { name: 'truncated JSON', chunks: ['{"status":', '"completed"'], error: SyntaxError },
  { name: 'empty body', chunks: [], error: SyntaxError },
  { name: 'whitespace body', chunks: [' \n', '\t'], error: SyntaxError },
]) {
  test(`generateAnswersWithOpenAIResponses rejects ${name} without saving empty success`, async (t) => {
    t.mock.method(console, 'debug', () => {})
    const records = [{ question: 'Previous', answer: 'Previous answer' }]
    const session = {
      modelName: 'chatgptApi5_6',
      conversationRecords: [...records],
      isRetry: false,
    }
    const port = createFakePort()
    t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(chunks))

    await assert.rejects(
      generateAnswersWithOpenAIResponses({
        port,
        question: 'Q',
        session,
        requestUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5.6',
        config: {},
      }),
      error,
    )

    assert.deepEqual(session.conversationRecords, records)
    assert.equal(
      port.postedMessages.some((message) => message.done === true),
      false,
    )
    assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  })
}

test('generateAnswersWithOpenAIResponses exposes HTTP status on errors', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const session = { modelName: 'chatgptApi5_6', conversationRecords: [], isRetry: false }
  const port = createFakePort()
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }),
  )

  await assert.rejects(
    generateAnswersWithOpenAIResponses({
      port,
      question: 'Q',
      session,
      requestUrl: 'https://api.openai.com/v1/responses',
      model: 'gpt-5.6',
      apiKey: 'sk-test',
      config: { maxConversationContextLength: 9, maxResponseTokenLength: 100 },
    }),
    (error) => {
      assert.equal(error.status, 404)
      return true
    },
  )
})

test('isResponsesRouteUnsupportedError only matches route-naming failures', () => {
  assert.equal(isResponsesRouteUnsupportedError({ status: 404, message: 'x' }), true)
  assert.equal(
    isResponsesRouteUnsupportedError({
      status: 400,
      message: '{"error":{"message":"Unknown URL /v1/responses"}}',
    }),
    true,
  )
  assert.equal(
    isResponsesRouteUnsupportedError({
      status: 400,
      message: 'The api-version is invalid for /openai/responses',
    }),
    true,
  )
  assert.equal(isResponsesRouteUnsupportedError({ message: 'something unknown failed' }), false)
  assert.equal(isResponsesRouteUnsupportedError({ message: 'boom' }), false)
  assert.equal(isResponsesRouteUnsupportedError(null), false)
})
