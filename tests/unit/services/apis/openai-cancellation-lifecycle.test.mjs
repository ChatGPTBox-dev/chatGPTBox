import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import Browser from 'webextension-polyfill'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import { generateAnswersWithAzureOpenaiApi } from '../../../../src/services/apis/azure-openai-api.mjs'
import { generateAnswersWithOpenAICompatible } from '../../../../src/services/apis/openai-compatible-core.mjs'
import { generateAnswersWithOpenAIResponses } from '../../../../src/services/apis/openai-responses-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const testOptions = { timeout: 3000 }
const question = 'Question'
const stopGenerationId = 23
const finalChunk = 'data: {"choices":[{"delta":{"content":"Fallback"},"finish_reason":"stop"}]}\n\n'

beforeEach((t) => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
})

function deferred(t) {
  const gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  return gate
}

function fixture(provider, responses = true) {
  const config = {
    maxConversationContextLength: 3,
    maxResponseTokenLength: 128,
    temperatureOverrideEnabled: false,
    temperature: 1,
    azureEndpoint: 'https://lifecycle.openai.azure.com',
    azureApiKey: 'test-key',
    azureDeploymentName: 'gpt-4o',
    azureUseResponses: responses,
    customOpenAIProviders: [
      {
        id: 'lifecycle',
        name: 'Lifecycle',
        baseUrl: 'https://lifecycle.example/v1',
        chatCompletionsPath: '/chat/completions',
        apiProtocol: responses ? 'responses' : 'chat',
      },
    ],
    providerSecrets: { lifecycle: 'test-key' },
  }
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(config)
  const session = {
    modelName: provider === 'Azure' ? 'azureOpenAi' : 'customModel',
    conversationRecords: [],
    isRetry: false,
    ...(provider === 'Azure'
      ? {}
      : {
          apiMode: {
            groupName: 'customApiModelKeys',
            itemName: 'customModel',
            isCustom: true,
            providerId: 'lifecycle',
            customName: 'gpt-4o',
          },
        }),
  }
  const port = createFakePort()
  const start = (runtimeConfig = config) =>
    (provider === 'Azure'
      ? generateAnswersWithAzureOpenaiApi(port, question, session)
      : generateAnswersWithOpenAICompatibleApi(port, question, session, runtimeConfig)
    ).then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    )
  return { config, session, port, start }
}

async function reach(gate, request) {
  // Fail promptly if routing exits before reaching the expected asynchronous boundary.
  await Promise.race([
    gate.promise,
    request.then(({ error }) => {
      throw error || new Error('Request completed before reaching the deferred boundary')
    }),
  ])
}

function cancel(port, action) {
  if (action === 'stop') port.emitMessage({ stop: true, stopGenerationId })
  else port.emitDisconnect()
}

function assertClean(port) {
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
}

function assertOnlyStopAcknowledgement(port, action) {
  assert.deepEqual(
    port.postedMessages.filter((message) => message.done),
    action === 'stop' ? [{ done: true, stoppedGenerationId: stopGenerationId }] : [],
  )
}

function unsupportedResponse() {
  return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 })
}

function pausedStream(t, chunks) {
  const entered = deferred(t)
  const release = deferred(t)
  const response = createMockSseResponse(chunks)
  const reader = response.body.getReader()
  const originalRead = reader.read.bind(reader)
  let reads = 0
  t.mock.method(reader, 'read', async () => {
    if (++reads === 2) {
      entered.resolve()
      if ((await release.promise) === 'AbortError') {
        throw new DOMException('The operation was aborted', 'AbortError')
      }
    }
    return originalRead()
  })
  t.mock.method(response.body, 'getReader', () => reader)
  return { response, entered, release }
}

for (const provider of ['OpenAI-compatible', 'Azure']) {
  test(
    `${provider}: failed HTTP fallback rejects without retrying and cleans listeners`,
    testOptions,
    async (t) => {
      const { port, session, start } = fixture(provider)
      const signals = []
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        signals.push(init.signal)
        return signals.length === 1
          ? unsupportedResponse()
          : createMockSseResponse([], {
              ok: false,
              status: 503,
              statusText: 'Service Unavailable',
              json: async () => ({ error: { message: 'Chat fallback unavailable' } }),
            })
      })

      const { error } = await start()
      assert.ok(error instanceof Error)
      assert.match(error.message, /Chat fallback unavailable/)
      assert.equal(signals.length, 2, 'a failed Chat fallback must not trigger a third fetch')
      assert.strictEqual(signals[0], signals[1])
      assert.equal(signals[0].aborted, false)
      assert.deepEqual(session.conversationRecords, [])
      assertClean(port)
      cancel(port, 'stop')
      assert.deepEqual(port.postedMessages, [])
    },
  )

  for (const [action, format] of ['stop', 'disconnect'].flatMap((action) =>
    ['JSON', 'text'].map((format) => [action, format]),
  )) {
    test(
      `${provider}: ${action} during initial 404 ${format} prevents fallback`,
      testOptions,
      async (t) => {
        const { port, session, start } = fixture(provider)
        const bodyEntered = deferred(t)
        const body = deferred(t)
        const calls = []
        t.mock.method(globalThis, 'fetch', async (url, init) => {
          calls.push({ url, signal: init.signal })
          if (calls.length > 1) return createMockSseResponse([finalChunk])
          const response = new Response(null, { status: 404 })
          t.mock.method(response, 'text', () => {
            bodyEntered.resolve()
            return body.promise
          })
          return response
        })
        const request = start()
        await reach(bodyEntered, request)
        cancel(port, action)
        const abortedWhilePending = calls[0].signal.aborted
        body.resolve(
          format === 'JSON' ? JSON.stringify({ error: { message: 'Not found' } }) : 'Not found',
        )
        const result = await request

        assert.equal(
          abortedWhilePending,
          true,
          'the original signal must abort while the HTTP body is pending',
        )
        assert.equal(result.error, undefined)
        assert.equal(calls.length, 1, 'cancellation must prevent the Chat fallback fetch')
        assert.deepEqual(session.conversationRecords, [])
        assertOnlyStopAcknowledgement(port, action)
        assert.equal(
          port.postedMessages.some((message) => message.answer || message.session),
          false,
        )
        assertClean(port)
      },
    )
  }
}

for (const [protocol, generate] of [
  ['Chat', generateAnswersWithOpenAICompatible],
  ['Responses', generateAnswersWithOpenAIResponses],
]) {
  test(
    `${protocol} core: owned listeners are cleaned when request preparation throws`,
    testOptions,
    async (t) => {
      const port = createFakePort()
      const session = { conversationRecords: [] }
      const failure = new Error('Request configuration unavailable')
      let listenersDuringPreparation
      const config = {
        get maxConversationContextLength() {
          listenersDuringPreparation = port.listenerCounts()
          throw failure
        },
      }
      const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
        createMockSseResponse([finalChunk]),
      )

      await assert.rejects(
        generate({
          port,
          question,
          session,
          config,
          endpointType: 'chat',
          requestUrl: 'https://lifecycle.example/v1/chat/completions',
          model: 'gpt-4o',
          apiKey: 'test-key',
        }),
        (error) => error === failure,
      )
      assert.deepEqual(listenersDuringPreparation, { onMessage: 1, onDisconnect: 1 })
      assert.equal(fetchMock.mock.callCount(), 0)
      assert.deepEqual(session.conversationRecords, [])
      assertClean(port)
      cancel(port, 'stop')
      assert.deepEqual(port.postedMessages, [])
    },
  )
}

for (const responses of [true, false]) {
  for (const action of ['stop', 'disconnect']) {
    test(
      `Azure: ${action} during initial config read with responses=${responses}`,
      testOptions,
      async (t) => {
        const { port, session, start } = fixture('Azure', responses)
        const configEntered = deferred(t)
        const configGate = deferred(t)
        const originalGet = Browser.storage.local.get.bind(Browser.storage.local)
        t.mock.method(Browser.storage.local, 'get', async (...args) => {
          configEntered.resolve()
          await configGate.promise
          return originalGet(...args)
        })
        const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
          createMockSseResponse([finalChunk]),
        )
        const request = start()
        await reach(configEntered, request)
        cancel(port, action)
        configGate.resolve()
        const result = await request

        assert.equal(result.error, undefined)
        assert.equal(
          fetchMock.mock.callCount(),
          0,
          'cancellation during config must prevent all fetches',
        )
        assert.deepEqual(session.conversationRecords, [])
        assertOnlyStopAcknowledgement(port, action)
        assert.equal(
          port.postedMessages.some((message) => message.answer || message.session),
          false,
        )
        assertClean(port)
      },
    )
  }
}

for (const provider of ['OpenAI-compatible', 'Azure']) {
  test(
    `${provider}: normal 404 fallback shares one live signal and completes`,
    testOptions,
    async (t) => {
      const { port, session, start } = fixture(provider)
      const calls = []
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, signal: init.signal, listeners: port.listenerCounts() })
        return calls.length === 1 ? unsupportedResponse() : createMockSseResponse([finalChunk])
      })
      assert.equal((await start()).error, undefined)
      assert.equal(calls.length, 2)
      assert.match(calls[0].url, /\/responses(?:\?|$)/)
      assert.match(calls[1].url, /\/chat\/completions(?:\?|$)/)
      assert.strictEqual(calls[0].signal, calls[1].signal)
      assert.equal(calls[0].signal.aborted, false)
      for (const call of calls) {
        assert.deepEqual(call.listeners, { onMessage: 1, onDisconnect: 1 })
      }
      assert.deepEqual(session.conversationRecords, [{ question, answer: 'Fallback' }])
      assert.ok(port.postedMessages.some((message) => message.done && message.session === session))
      assertClean(port)
    },
  )

  for (const action of ['stop', 'disconnect']) {
    for (const ending of ['AbortError', 'late completion']) {
      test(
        `${provider}: ${action} during fallback stream handles ${ending}`,
        testOptions,
        async (t) => {
          const { port, session, start } = fixture(provider)
          const stream = pausedStream(t, [
            'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":" late"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ])
          const signals = []
          t.mock.method(globalThis, 'fetch', async (_url, init) => {
            signals.push(init.signal)
            return signals.length === 1 ? unsupportedResponse() : stream.response
          })
          const request = start()
          await reach(stream.entered, request)
          assert.deepEqual(port.postedMessages, [{ answer: 'Partial', done: false, session: null }])
          cancel(port, action)
          stream.release.resolve(ending)
          assert.equal((await request).error, undefined)

          assert.equal(signals.length, 2)
          assert.strictEqual(signals[0], signals[1])
          assert.equal(signals[0].aborted, true)
          assert.deepEqual(
            port.postedMessages.filter((message) => typeof message.answer === 'string'),
            [{ answer: 'Partial', done: false, session: null }],
          )
          // Azure Chat has never persisted unfinished answers; the compatible core does.
          assert.deepEqual(
            session.conversationRecords,
            provider === 'Azure' ? [] : [{ question, answer: 'Partial' }],
          )
          assert.deepEqual(
            port.postedMessages.filter((message) => message.session),
            provider === 'Azure'
              ? []
              : [
                  {
                    session,
                    ...(action === 'stop' ? { stoppedGenerationId: stopGenerationId } : {}),
                  },
                ],
          )
          assertOnlyStopAcknowledgement(port, action)
          assertClean(port)
        },
      )
    }

    test(
      `${provider}: ${action} ignores late Responses events and preserves partial text`,
      testOptions,
      async (t) => {
        const { port, session, start } = fixture(provider)
        const stream = pausedStream(t, [
          'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
          'data: {"type":"response.output_text.delta","delta":" late"}\n\ndata: {"type":"response.completed","response":{"output_text":"Partial late"}}\n\ndata: [DONE]\n\n',
        ])
        let signal
        const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, init) => {
          signal = init.signal
          return stream.response
        })
        const request = start()
        await reach(stream.entered, request)
        assert.deepEqual(port.postedMessages, [{ answer: 'Partial', done: false, session: null }])
        cancel(port, action)
        stream.release.resolve()
        assert.equal((await request).error, undefined)

        assert.equal(signal.aborted, true)
        assert.equal(fetchMock.mock.callCount(), 1)
        assert.deepEqual(session.conversationRecords, [{ question, answer: 'Partial' }])
        assert.deepEqual(
          port.postedMessages.filter((message) => typeof message.answer === 'string'),
          [{ answer: 'Partial', done: false, session: null }],
        )
        assertOnlyStopAcknowledgement(port, action)
        assertClean(port)
      },
    )
  }

  for (const responses of [true, false]) {
    test(
      `${provider}: config rejection cleans outer listeners with responses=${responses}`,
      testOptions,
      async (t) => {
        const { port, session, start } = fixture(provider, responses)
        const failure = new Error('Storage unavailable')
        const configEntered = deferred(t)
        const configGate = deferred(t)
        t.mock.method(Browser.storage.local, 'get', async () => {
          configEntered.resolve()
          await configGate.promise
          throw failure
        })
        const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
          createMockSseResponse([finalChunk]),
        )
        const request = start(null)
        await reach(configEntered, request)
        const listenersWhilePending = port.listenerCounts()
        configGate.resolve()
        assert.strictEqual((await request).error, failure)
        assert.deepEqual(listenersWhilePending, { onMessage: 1, onDisconnect: 1 })
        assert.equal(fetchMock.mock.callCount(), 0)
        assert.deepEqual(session.conversationRecords, [])
        assertClean(port)
        cancel(port, 'stop')
        assert.deepEqual(port.postedMessages, [], 'failed requests must not leave a stop listener')
      },
    )

    test(
      `${provider}: preflight failure cleans listeners with responses=${responses}`,
      testOptions,
      async (t) => {
        const { config, port, session, start } = fixture(provider, responses)
        if (provider === 'Azure') {
          // Invalid persisted settings fail URL construction before fetch.
          globalThis.__TEST_BROWSER_SHIM__.setStorage({ azureEndpoint: 42 })
        } else {
          config.customOpenAIProviders[0].enabled = false
        }
        const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
          createMockSseResponse([finalChunk]),
        )
        const { error } = await start()
        assert.ok(error instanceof Error)
        assert.match(error.message, provider === 'Azure' ? /replace/ : /Failed to resolve/)
        assert.equal(fetchMock.mock.callCount(), 0)
        assert.deepEqual(session.conversationRecords, [])
        assertClean(port)
        cancel(port, 'stop')
        assert.deepEqual(port.postedMessages, [])
      },
    )
  }
}
