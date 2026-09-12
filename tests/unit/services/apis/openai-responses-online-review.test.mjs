import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithOpenAICompatibleApi } from '../../../../src/services/apis/openai-api.mjs'
import { generateAnswersWithAzureOpenaiApi } from '../../../../src/services/apis/azure-openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

beforeEach((t) => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'warn', () => {})
})

function createRequest(provider, endpoints = {}, retry = false) {
  const config = {
    azureUseResponses: true,
    azureEndpoint: 'https://azure.example',
    azureApiKey: 'test-key',
    azureDeploymentName: 'test-deployment',
    customOpenAIProviders: [
      {
        id: 'online-review',
        name: 'Online review',
        apiProtocol: 'responses',
        responsesUrl: 'https://responses.example/v1/responses',
        ...endpoints,
      },
    ],
    providerSecrets: { 'online-review': 'test-key' },
  }
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(config)
  const history = [
    { question: retry ? 'Question' : 'Previous question', answer: 'Previous answer' },
  ]
  const session = {
    modelName: provider === 'Azure' ? 'azureOpenAi' : 'customModel',
    conversationRecords: structuredClone(history),
    isRetry: retry,
    ...(provider === 'Azure'
      ? {}
      : {
          apiMode: {
            groupName: 'customApiModelKeys',
            itemName: 'customModel',
            isCustom: true,
            providerId: 'online-review',
            customName: 'gpt-4o',
          },
        }),
  }
  const port = createFakePort()
  return {
    port,
    session,
    history,
    run: () =>
      provider === 'Azure'
        ? generateAnswersWithAzureOpenaiApi(port, 'Question', session)
        : generateAnswersWithOpenAICompatibleApi(port, 'Question', session, config),
  }
}

function assertFailedWithoutSaving({ port, session, history }) {
  assert.deepEqual(session.conversationRecords, history)
  assert.equal(
    port.postedMessages.some((message) => message.done),
    false,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
}

const emptyCompletedJson = JSON.stringify({ status: 'completed', output: [] })
const emptyCompletedEvent = `data: ${JSON.stringify({
  type: 'response.completed',
  response: { status: 'completed', output: [] },
})}\n\n`
const lateTextEvent = 'data: {"type":"response.output_text.delta","delta":"Late answer"}\n\n'
const doneEvent = 'data: [DONE]\n\n'

for (const provider of ['OpenAI-compatible', 'Azure']) {
  for (const retry of [false, true]) {
    for (const [label, chunks] of [
      ['completed JSON', [emptyCompletedJson]],
      ['split completed JSON', [emptyCompletedJson.slice(0, 15), emptyCompletedJson.slice(15)]],
      ['empty JSON object', ['{}']],
      ['bare completion', ['data: {"type":"response.completed"}\n\n', doneEvent]],
      ['empty completion', [emptyCompletedEvent, doneEvent]],
      ['terminator only', [doneEvent]],
      ['empty delta', ['data: {"type":"response.output_text.delta","delta":""}\n\n', doneEvent]],
      [
        'reasoning-only JSON',
        [JSON.stringify({ status: 'completed', output: [{ type: 'reasoning', summary: [] }] })],
      ],
      ['completion before coalesced late text', [emptyCompletedEvent + lateTextEvent + doneEvent]],
      ['completion before later text', [emptyCompletedEvent, lateTextEvent, doneEvent]],
    ]) {
      test(`${provider} rejects ${label} without saving or fallback (retry=${retry})`, async (t) => {
        const request = createRequest(
          provider,
          { chatCompletionsUrl: 'https://chat.example/chat' },
          retry,
        )
        const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
          createMockSseResponse(chunks),
        )

        await assert.rejects(
          request.run(),
          (error) =>
            error.message === 'Responses API completed without output text' &&
            error.status === undefined,
        )

        assert.equal(fetchMock.mock.callCount(), 1)
        assertFailedWithoutSaving(request)
        assert.equal(request.session.isRetry, retry)
        assert.equal(
          request.port.postedMessages.some((message) => message.session || message.answer),
          false,
        )
      })
    }

    for (const [label, answer, chunks] of [
      [
        'accumulated text before empty completion',
        'Answer',
        [
          'data: {"type":"response.output_text.delta","delta":"Answer"}\n\n',
          emptyCompletedEvent,
          doneEvent,
        ],
      ],
      [
        'refusal JSON',
        'Cannot answer',
        [
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer' }] }],
          }),
        ],
      ],
      ['whitespace JSON', ' \n', [JSON.stringify({ status: 'completed', output_text: ' \n' })]],
    ]) {
      test(`${provider} retains ${label} (retry=${retry})`, async (t) => {
        const request = createRequest(provider, {}, retry)
        const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
          createMockSseResponse(chunks),
        )
        await request.run()

        assert.equal(fetchMock.mock.callCount(), 1)
        assert.deepEqual(request.session.conversationRecords, [
          ...(retry ? [] : request.history),
          { question: 'Question', answer },
        ])
        assert.equal(
          request.port.postedMessages.filter((message) => message.done === true).length,
          1,
        )
        assert.deepEqual(request.port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
      })
    }
  }
}

for (const chatCompletionsUrl of [
  'not a URL',
  '/relative/chat',
  'https://[invalid',
  'ftp://chat.example/responses',
  'javascript:alert(1)',
]) {
  for (const status of [400, 404, 405, 501]) {
    for (const retry of [false, true]) {
      test(`Invalid Chat URL ${chatCompletionsUrl} preserves HTTP ${status} (retry=${retry})`, async (t) => {
        const request = createRequest('OpenAI-compatible', { chatCompletionsUrl }, retry)
        const errorBody = JSON.stringify({ error: { message: 'Responses API is not supported' } })
        const urls = []
        t.mock.method(globalThis, 'fetch', async (url) => {
          urls.push(url)
          if (urls.length === 1) return new Response(errorBody, { status })
          return createMockSseResponse([
            'data: {"choices":[{"delta":{"content":"Unexpected fallback"},"finish_reason":"stop"}]}\n\n',
          ])
        })
        await assert.rejects(
          request.run(),
          (error) => error.status === status && error.message === errorBody,
        )
        assert.deepEqual(urls, ['https://responses.example/v1/responses'])
        assertFailedWithoutSaving(request)
      })
    }
  }
}

for (const chatCompletionsUrl of [
  'https://chat.example/custom/responses',
  'https://CHAT.example:443/custom/ReSpOnSeS?next=a%2Fb&version=1',
  'http://localhost:8000/custom/responses/?version=2',
  'https://chat.example/custom/chat?next=/responses',
]) {
  for (const status of [400, 404, 405, 501]) {
    for (const retry of [false, true]) {
      test(`Chat fallback preserves configured URL ${chatCompletionsUrl} after HTTP ${status} (retry=${retry})`, async (t) => {
        const request = createRequest('OpenAI-compatible', { chatCompletionsUrl }, retry)
        const calls = []
        t.mock.method(globalThis, 'fetch', async (url, options) => {
          calls.push({ url, signal: options.signal })
          if (calls.length === 1) {
            return new Response(
              JSON.stringify({ error: { message: 'Responses API is not supported' } }),
              { status },
            )
          }
          return createMockSseResponse([
            'data: {"choices":[{"delta":{"content":"Fallback answer"},"finish_reason":"stop"}]}\n\n',
          ])
        })
        await request.run()
        assert.deepEqual(
          calls.map(({ url }) => url),
          ['https://responses.example/v1/responses', chatCompletionsUrl],
        )
        assert.equal(calls[0].signal, calls[1].signal)
        assert.equal(calls[1].signal.aborted, false)
        assert.equal(request.port.postedMessages.filter((message) => message.done).length, 1)
        assert.deepEqual(request.session.conversationRecords, [
          ...(retry ? [] : request.history),
          { question: 'Question', answer: 'Fallback answer' },
        ])
        assert.deepEqual(request.port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
      })
    }
  }
}

for (const provider of ['OpenAI-compatible', 'Azure']) {
  for (const [partial, retry] of [false, true].flatMap((partial) =>
    [false, true].map((retry) => [partial, retry]),
  )) {
    for (const terminal of ['[DONE]', '{"type":"response.completed"}', null]) {
      for (const coalesced of [false, true]) {
        test(`${provider} rejects malformed SSE before ${
          terminal ?? 'EOF'
        } (partial=${partial}, retry=${retry}, coalesced=${coalesced})`, async (t) => {
          const request = createRequest(
            provider,
            { chatCompletionsUrl: 'https://chat.example/custom/chat' },
            retry,
          )
          const events = [
            ...(partial
              ? ['data: {"type":"response.output_text.delta","delta":"Partial"}\n\n']
              : []),
            'data: {invalid-json}\n\n',
            ...(terminal ? [`data: ${terminal}\n\n`] : []),
          ]
          const calls = []
          t.mock.method(globalThis, 'fetch', async (url) => {
            calls.push(url)
            return createMockSseResponse(coalesced ? [events.join('')] : events)
          })

          await assert.rejects(request.run(), SyntaxError)
          assert.equal(calls.length, 1, 'Malformed SSE must not trigger a Chat request')
          assertFailedWithoutSaving(request)
          assert.equal(request.session.isRetry, retry)
          assert.equal(
            request.port.postedMessages.filter((message) => message.answer === 'Partial').length,
            partial ? 1 : 0,
          )
        })
      }
    }
  }
}

for (const responsesUrl of [
  'https://responses.example/v1/responses',
  'https://responses.example/v1/responses/?api-version=1',
  'https://responses.example/custom/respond?api-version=2',
]) {
  for (const status of [400, 404, 405, 501]) {
    test(`Responses-only provider preserves HTTP ${status} at ${responsesUrl} without guessing Chat`, async (t) => {
      const request = createRequest('OpenAI-compatible', { responsesUrl })
      const errorBody = JSON.stringify({ error: { message: 'Responses API is not supported' } })
      const urls = []
      t.mock.method(globalThis, 'fetch', async (url) => {
        urls.push(url)
        if (urls.length === 1) return new Response(errorBody, { status })
        return createMockSseResponse([
          'data: {"choices":[{"delta":{"content":"Unexpected fallback"},"finish_reason":"stop"}]}\n\n',
        ])
      })

      await assert.rejects(
        request.run(),
        (error) => error.status === status && error.message === errorBody,
      )
      assert.deepEqual(urls, [responsesUrl])
      assertFailedWithoutSaving(request)
    })
  }
}
