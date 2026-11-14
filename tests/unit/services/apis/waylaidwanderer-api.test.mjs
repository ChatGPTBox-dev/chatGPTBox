import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { generateAnswersWithWaylaidwandererApi } from '../../../../src/services/apis/waylaidwanderer-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('waylaidwanderer-api: isolated diagnostics do not emit raw SSE or console output', async (t) => {
  const consoleMessages = []
  t.mock.method(console, 'debug', (...args) => consoleMessages.push(args.join(' ')))
  const session = {
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  const diagnostics = []
  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse(['data: "SECRET_ANSWER"\n\n', 'data: [DONE]\n\n']),
  )

  await generateAnswersWithWaylaidwandererApi(
    port,
    'SECRET_PROMPT',
    session,
    { githubThirdPartyUrl: 'https://override.example.test/chat' },
    {
      diagnostics: {
        debug(message, details) {
          diagnostics.push({ message, details })
        },
      },
    },
  )

  assert.equal(JSON.stringify(consoleMessages).includes('SECRET_ANSWER'), false)
  assert.equal(JSON.stringify(consoleMessages).includes('SECRET_PROMPT'), false)
  assert.equal(JSON.stringify(diagnostics).includes('SECRET_ANSWER'), false)
  assert.equal(JSON.stringify(diagnostics).includes('SECRET_PROMPT'), false)
  assert.equal(diagnostics.length > 0, true)
})

test('waylaidwanderer-api: uses an isolated config override instead of stored defaults', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ githubThirdPartyUrl: 'https://stored.example.invalid' })

  const session = {
    conversationRecords: [],
    isRetry: false,
  }
  const port = createFakePort()
  let capturedInput
  t.mock.method(globalThis, 'fetch', async (input) => {
    capturedInput = input
    return createMockSseResponse(['data: "OK"\n\n', 'data: [DONE]\n\n'])
  })

  await generateAnswersWithWaylaidwandererApi(port, 'Q', session, {
    githubThirdPartyUrl: 'https://override.example.test/chat',
  })

  assert.equal(capturedInput, 'https://override.example.test/chat')
  assert.deepEqual(session.conversationRecords.at(-1), { question: 'Q', answer: 'OK' })
})
