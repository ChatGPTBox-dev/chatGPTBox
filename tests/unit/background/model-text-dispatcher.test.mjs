import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelTextDispatcher } from '../../../src/background/model-text-dispatcher.mjs'

function createLogger(entries) {
  return {
    info(entry) {
      entries.push(['info', entry])
    },
    warn(entry) {
      entries.push(['warn', entry])
    },
    error(entry) {
      entries.push(['error', entry])
    },
  }
}

function createBaseDependencies(overrides = {}) {
  return {
    getUserConfig: async () => ({ modelName: 'customModel', apiMode: null }),
    getChatGptAccessToken: async () => 'chatgpt-token',
    getClaudeSessionKey: async () => 'claude-session',
    getBingAccessToken: async () => 'bing-token',
    getBardCookies: async () => '__Secure-1PSID=bard-cookie',
    generateAnswersWithChatgptWebApi: async () => {
      throw new Error('unexpected ChatGPT Web route')
    },
    generateWithChatgptPageProxy: undefined,
    generateAnswersWithClaudeWebApi: async () => {
      throw new Error('unexpected Claude Web route')
    },
    generateAnswersWithMoonshotWebApi: async () => {
      throw new Error('unexpected Kimi Web route')
    },
    generateAnswersWithBingWebApi: async () => {
      throw new Error('unexpected Bing Web route')
    },
    generateAnswersWithBardWebApi: async () => {
      throw new Error('unexpected Gemini Web route')
    },
    generateAnswersWithOpenAICompatibleApi: async () => {
      throw new Error('unexpected OpenAI-compatible route')
    },
    generateAnswersWithClaudeApi: async () => {
      throw new Error('unexpected Claude API route')
    },
    generateAnswersWithAzureOpenaiApi: async () => {
      throw new Error('unexpected Azure route')
    },
    generateAnswersWithWaylaidwandererApi: async () => {
      throw new Error('unexpected GitHub third-party route')
    },
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  }
}

async function assertRejectsWithCode(promise, code, extraAssertions = () => {}) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, code)
    assert.equal(error.code, code)
    extraAssertions(error)
    return true
  })
}

test('Kimi Web uses a fresh isolated session and returns cumulative provider text', async () => {
  const sessions = []
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'moonshotWebFree',
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithMoonshotWebApi: async (port, question, session, config) => {
        sessions.push({ question, session, config })
        assert.equal(config.maxResponseTokenLength, 1200)
        port.postMessage({ answer: 'partial', done: false })
        session.conversationRecords.push({ question, answer: 'final answer' })
        port.postMessage({ answer: 'final answer', done: true, session })
      },
    }),
  )

  const result = await dispatcher.generateText({
    modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
    messages: [
      { role: 'system', content: 'template' },
      { role: 'user', content: 'data' },
    ],
    maxOutputTokens: 1200,
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, { text: 'final answer', finishReason: null })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].question, '<system>\ntemplate\n\n<user>\ndata')
  assert.equal(sessions[0].session.question, sessions[0].question)
  assert.equal(sessions[0].session.conversationRecords.length, 1)
  assert.equal(sessions[0].session.modelName, 'moonshotWebFree')
  assert.equal(sessions[0].session.autoClean, true)
  assert.equal(sessions[0].session.moonshot_conversation !== undefined, true)
})

test('OpenAI-compatible routing receives a cloned config capped at maxOutputTokens', async () => {
  const config = {
    modelName: 'chatgptApi4oMini',
    apiMode: null,
    maxResponseTokenLength: 4000,
    nested: { original: true },
  }
  let captured
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => config,
      generateAnswersWithOpenAICompatibleApi: async (port, question, session, receivedConfig) => {
        captured = { question, session, config: receivedConfig }
        receivedConfig.nested.original = false
        port.postMessage({ answer: 'api text', done: true })
      },
    }),
  )

  const result = await dispatcher.generateText({
    modelSnapshot: { modelName: 'chatgptApi4oMini', apiMode: null },
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 333,
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, { text: 'api text', finishReason: null })
  assert.equal(captured.config.maxResponseTokenLength, 333)
  assert.notEqual(captured.config, config)
  assert.notEqual(captured.config.nested, config.nested)
  assert.equal(config.maxResponseTokenLength, 4000)
  assert.equal(config.nested.original, true)
  assert.equal(captured.session.modelName, 'chatgptApi4oMini')
})

test('Claude API, Azure, and GitHub third-party models select the configured adapters', async () => {
  const calls = []
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'claudeSonnet45Api' }),
      generateAnswersWithClaudeApi: async (port, question, session, config) => {
        calls.push(['claude-api', session.modelName, config.maxResponseTokenLength])
        port.postMessage({ answer: 'claude api', done: true })
      },
      generateAnswersWithAzureOpenaiApi: async (port, question, session, config) => {
        calls.push(['azure', session.modelName, config.maxResponseTokenLength])
        port.postMessage({ answer: 'azure api', done: true })
      },
      generateAnswersWithWaylaidwandererApi: async (port, question, session, config) => {
        calls.push(['github', session.modelName, config.maxResponseTokenLength])
        port.postMessage({ answer: 'github api', done: true })
      },
    }),
  )

  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'claudeSonnet45Api', apiMode: null },
      messages: [{ role: 'user', content: 'one' }],
      maxOutputTokens: 101,
      signal: new AbortController().signal,
    }),
    { text: 'claude api', finishReason: null },
  )
  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'azureOpenAi', apiMode: null },
      messages: [{ role: 'user', content: 'two' }],
      maxOutputTokens: 202,
      signal: new AbortController().signal,
    }),
    { text: 'azure api', finishReason: null },
  )
  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'waylaidwandererApi', apiMode: null },
      messages: [{ role: 'user', content: 'three' }],
      maxOutputTokens: 303,
      signal: new AbortController().signal,
    }),
    { text: 'github api', finishReason: null },
  )

  assert.deepEqual(calls, [
    ['claude-api', 'claudeSonnet45Api', 101],
    ['azure', 'azureOpenAi', 202],
    ['github', 'waylaidwandererApi', 303],
  ])
})

test('web models select Claude, Bing, Gemini, ChatGPT direct, ChatGPT page, and Kimi adapters', async () => {
  const calls = []
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'chatgptFree35',
        chatgptTabId: null,
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithClaudeWebApi: async (port, question, session, sessionKey, config) => {
        calls.push(['claude-web', sessionKey, session.modelName, config.maxResponseTokenLength])
        port.postMessage({ answer: 'claude web', done: true })
      },
      generateAnswersWithBingWebApi: async (
        port,
        question,
        session,
        accessToken,
        sydneyMode,
        config,
      ) => {
        calls.push([
          'bing-web',
          accessToken,
          sydneyMode,
          session.modelName,
          config.maxResponseTokenLength,
        ])
        port.postMessage({ answer: 'bing web', done: true })
      },
      generateAnswersWithBardWebApi: async (port, question, session, cookies) => {
        calls.push(['gemini-web', cookies, session.modelName])
        port.postMessage({ answer: 'gemini web', done: true })
      },
      generateAnswersWithChatgptWebApi: async (port, question, session, accessToken, config) => {
        calls.push([
          'chatgpt-direct',
          accessToken,
          session.modelName,
          config.maxResponseTokenLength,
        ])
        port.postMessage({ answer: 'chatgpt direct', done: true })
      },
      generateWithChatgptPageProxy: async ({ port, session, tabId, config }) => {
        calls.push(['chatgpt-page', tabId, session.modelName, config.maxResponseTokenLength])
        port.postMessage({ answer: 'chatgpt page', done: true })
      },
      generateAnswersWithMoonshotWebApi: async (port, question, session, config) => {
        calls.push(['kimi-web', session.modelName, config.maxResponseTokenLength])
        port.postMessage({ answer: 'kimi web', done: true })
      },
    }),
  )

  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'claude2WebFree', apiMode: null },
      messages: [{ role: 'user', content: 'one' }],
      maxOutputTokens: 11,
      signal: new AbortController().signal,
    }),
    { text: 'claude web', finishReason: null },
  )
  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'bingFreeSydney', apiMode: null },
      messages: [{ role: 'user', content: 'two' }],
      maxOutputTokens: 22,
      signal: new AbortController().signal,
    }),
    { text: 'bing web', finishReason: null },
  )
  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'bardWebFree', apiMode: null },
      messages: [{ role: 'user', content: 'three' }],
      maxOutputTokens: 33,
      signal: new AbortController().signal,
    }),
    { text: 'gemini web', finishReason: null },
  )
  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
      messages: [{ role: 'user', content: 'four' }],
      maxOutputTokens: 44,
      signal: new AbortController().signal,
    }),
    { text: 'chatgpt direct', finishReason: null },
  )

  const pageDispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: 8765 }),
      generateWithChatgptPageProxy: async ({ session }) => {
        calls.push(['chatgpt-page', session.modelName])
        return { text: 'chatgpt page', finishReason: null }
      },
    }),
  )
  assert.deepEqual(
    await pageDispatcher.generateText({
      modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
      messages: [{ role: 'user', content: 'five' }],
      maxOutputTokens: 55,
      signal: new AbortController().signal,
    }),
    { text: 'chatgpt page', finishReason: null },
  )

  assert.deepEqual(
    await dispatcher.generateText({
      modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
      messages: [{ role: 'user', content: 'six' }],
      maxOutputTokens: 66,
      signal: new AbortController().signal,
    }),
    { text: 'kimi web', finishReason: null },
  )

  assert.deepEqual(calls, [
    ['claude-web', 'claude-session', 'claude2WebFree', 11],
    ['bing-web', 'bing-token', true, 'bingFreeSydney', 22],
    ['gemini-web', '__Secure-1PSID=bard-cookie', 'bardWebFree'],
    ['chatgpt-direct', 'chatgpt-token', 'chatgptFree35', 44],
    ['chatgpt-page', 'chatgptFree35'],
    ['kimi-web', 'moonshotWebFree', 66],
  ])
})

test('two concurrent calls receive different synthetic ports and sessions', async () => {
  const seen = []
  const release = []
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'moonshotWebFree',
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithMoonshotWebApi: async (port, question, session) => {
        seen.push({ port, question, session })
        await new Promise((resolve) => release.push(resolve))
        port.postMessage({ answer: question, done: true })
      },
    }),
  )

  const first = dispatcher.generateText({
    modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
    messages: [{ role: 'user', content: 'first' }],
    maxOutputTokens: 1,
    signal: new AbortController().signal,
  })
  const second = dispatcher.generateText({
    modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
    messages: [{ role: 'user', content: 'second' }],
    maxOutputTokens: 1,
    signal: new AbortController().signal,
  })

  while (seen.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.notEqual(seen[0].port, seen[1].port)
  assert.notEqual(seen[0].session, seen[1].session)
  assert.notEqual(seen[0].session.sessionId, seen[1].session.sessionId)

  release.splice(0).forEach((resolve) => resolve())
  assert.deepEqual(await Promise.all([first, second]), [
    { text: '<user>\nfirst', finishReason: null },
    { text: '<user>\nsecond', finishReason: null },
  ])
})

test('aborting one signal sends stop only to that synthetic port and rejects before stop acknowledgment', async () => {
  const ports = []
  const controllers = [new AbortController(), new AbortController()]
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'moonshotWebFree',
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithMoonshotWebApi: async (port) => {
        ports.push(port)
        port.onMessage.addListener((message) => {
          if (message?.stop) port.postMessage({ done: true })
        })
        await new Promise(() => {})
      },
    }),
  )

  const first = dispatcher.generateText({
    modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
    messages: [{ role: 'user', content: 'first secret' }],
    maxOutputTokens: 1,
    signal: controllers[0].signal,
  })
  const second = dispatcher.generateText({
    modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
    messages: [{ role: 'user', content: 'second secret' }],
    maxOutputTokens: 1,
    signal: controllers[1].signal,
  })

  while (ports.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))
  let firstStopCount = 0
  let secondStopCount = 0
  ports[0].onMessage.addListener((message) => {
    if (message?.stop) firstStopCount += 1
  })
  ports[1].onMessage.addListener((message) => {
    if (message?.stop) secondStopCount += 1
  })

  controllers[0].abort()
  await assertRejectsWithCode(first, 'MODEL_GATEWAY_ABORTED')
  assert.equal(firstStopCount, 1)
  assert.equal(secondStopCount, 0)

  controllers[1].abort()
  await assertRejectsWithCode(second, 'MODEL_GATEWAY_ABORTED')
  assert.equal(secondStopCount, 1)
})

test('provider error port messages reject with a normalized safe error and settle exactly once', async () => {
  const entries = []
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'moonshotWebFree',
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithMoonshotWebApi: async (port) => {
        port.postMessage({ answer: 'partial provider text', done: false })
        port.postMessage({ error: 'raw provider prompt/token details should not leak' })
        port.postMessage({ answer: 'late answer should be ignored', done: true })
      },
      logger: createLogger(entries),
    }),
  )

  await assertRejectsWithCode(
    dispatcher.generateText({
      modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
      messages: [{ role: 'user', content: 'sensitive prompt text' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    'MODEL_GATEWAY_PROVIDER_ERROR',
  )
  assert.equal(JSON.stringify(entries).includes('raw provider prompt'), false)
  assert.equal(JSON.stringify(entries).includes('sensitive prompt'), false)
  assert.equal(JSON.stringify(entries).includes('partial provider text'), false)
  assert.equal(JSON.stringify(entries).includes('late answer'), false)
})

test('missing Kimi refresh token becomes MODEL_LOGIN_REQUIRED with login-required condition', async () => {
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'moonshotWebFree', kimiMoonShotRefreshToken: '' }),
      generateAnswersWithMoonshotWebApi: async () => {
        throw new Error('Kimi route should not run without a refresh token')
      },
    }),
  )

  await assertRejectsWithCode(
    dispatcher.generateText({
      modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
      messages: [{ role: 'user', content: 'data' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    'MODEL_LOGIN_REQUIRED',
    (error) => {
      assert.equal(error.condition, 'login-required')
      assert.equal(error.modelName, 'moonshotWebFree')
    },
  )
})

test('missing ChatGPT page proxy or direct token becomes actionable instead of unsupported', async () => {
  const directDispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: null }),
      getChatGptAccessToken: async () => undefined,
      generateAnswersWithChatgptWebApi: async () => {
        throw new Error('ChatGPT direct route should not run without a token')
      },
    }),
  )
  await assertRejectsWithCode(
    directDispatcher.generateText({
      modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
      messages: [{ role: 'user', content: 'data' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    'MODEL_LOGIN_REQUIRED',
    (error) => {
      assert.equal(error.condition, 'login-required')
      assert.equal(error.modelName, 'chatgptFree35')
    },
  )

  const pageDispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: 123 }),
      generateWithChatgptPageProxy: undefined,
      generateAnswersWithChatgptWebApi: async () => {
        throw new Error('ChatGPT direct route should not run when a page proxy is configured')
      },
    }),
  )
  await assertRejectsWithCode(
    pageDispatcher.generateText({
      modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
      messages: [{ role: 'user', content: 'data' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    'MODEL_PROVIDER_PAGE_REQUIRED',
    (error) => {
      assert.equal(error.condition, 'provider-page-required')
      assert.equal(error.modelName, 'chatgptFree35')
    },
  )
})

test('prompt answer token and config values never appear in injected logger entries', async () => {
  const entries = []
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'chatgptApi4oMini',
        apiMode: null,
        maxResponseTokenLength: 4000,
        apiKey: 'sk-sensitive-config',
      }),
      generateAnswersWithOpenAICompatibleApi: async (port) => {
        port.postMessage({ answer: 'secret generated answer', done: true })
      },
      logger: createLogger(entries),
    }),
  )

  await dispatcher.generateText({
    modelSnapshot: { modelName: 'chatgptApi4oMini', apiMode: null },
    messages: [{ role: 'user', content: 'secret prompt content' }],
    maxOutputTokens: 777,
    signal: new AbortController().signal,
  })

  const serializedLogs = JSON.stringify(entries)
  assert.equal(serializedLogs.includes('secret prompt content'), false)
  assert.equal(serializedLogs.includes('secret generated answer'), false)
  assert.equal(serializedLogs.includes('777'), false)
  assert.equal(serializedLogs.includes('sk-sensitive-config'), false)
  assert.equal(serializedLogs.includes('maxResponseTokenLength'), false)
})

test('aborting during an async credential getter rejects promptly and prevents provider dispatch', async () => {
  const controller = new AbortController()
  let providerDispatched = false
  let credentialStarted = false
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: null }),
      getChatGptAccessToken: async () => {
        credentialStarted = true
        await new Promise(() => {})
      },
      generateAnswersWithChatgptWebApi: async () => {
        providerDispatched = true
      },
    }),
  )

  const result = dispatcher.generateText({
    modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
    messages: [{ role: 'user', content: 'secret prompt during credential wait' }],
    maxOutputTokens: 1,
    signal: controller.signal,
  })

  while (!credentialStarted) await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()

  await assertRejectsWithCode(result, 'MODEL_GATEWAY_ABORTED')
  assert.equal(providerDispatched, false)
})

test('aborting before credential getter resolves prevents direct provider dispatch', async () => {
  const controller = new AbortController()
  let resolveCredential
  let providerDispatched = false
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: null }),
      getChatGptAccessToken: async () => {
        await new Promise((resolve) => {
          resolveCredential = resolve
        })
        return 'late-token'
      },
      generateAnswersWithChatgptWebApi: async () => {
        providerDispatched = true
      },
    }),
  )

  const result = dispatcher.generateText({
    modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
    messages: [{ role: 'user', content: 'secret late credential prompt' }],
    maxOutputTokens: 1,
    signal: controller.signal,
  })

  while (!resolveCredential) await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  resolveCredential()

  await assertRejectsWithCode(result, 'MODEL_GATEWAY_ABORTED')
  assert.equal(providerDispatched, false)
})

test('ChatGPT page proxy uses Task 6 request-scoped contract and aborts promptly', async () => {
  const controller = new AbortController()
  let capturedRequest
  let proxySignalAborted = false
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: 42 }),
      generateWithChatgptPageProxy: async (request) => {
        capturedRequest = request
        request.signal.addEventListener('abort', () => {
          proxySignalAborted = true
        })
        await new Promise(() => {})
      },
    }),
  )

  const result = dispatcher.generateText({
    requestId: 'req-1',
    modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
    messages: [{ role: 'user', content: 'page proxy prompt' }],
    maxOutputTokens: 55,
    signal: controller.signal,
  })

  while (!capturedRequest) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(capturedRequest.requestId, 'req-1')
  assert.equal(capturedRequest.signal, controller.signal)
  assert.equal(capturedRequest.port, undefined)
  assert.equal(capturedRequest.tabId, undefined)
  assert.equal(capturedRequest.session.modelName, 'chatgptFree35')
  assert.equal(capturedRequest.session.question, '<user>\npage proxy prompt')

  controller.abort()

  await assertRejectsWithCode(result, 'MODEL_GATEWAY_ABORTED')
  assert.equal(proxySignalAborted, true)
})

test('ChatGPT page proxy result is returned through request-scoped contract', async () => {
  let capturedRequest
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'chatgptFree35', chatgptTabId: 42 }),
      generateWithChatgptPageProxy: async (request) => {
        capturedRequest = request
        return { text: 'page proxy final', finishReason: 'stop' }
      },
    }),
  )

  const result = await dispatcher.generateText({
    requestId: 'req-2',
    modelSnapshot: { modelName: 'chatgptFree35', apiMode: null },
    messages: [{ role: 'user', content: 'page proxy success' }],
    maxOutputTokens: 55,
    signal: new AbortController().signal,
  })

  assert.equal(capturedRequest.requestId, 'req-2')
  assert.deepEqual(result, { text: 'page proxy final', finishReason: 'stop' })
})

test('provider error text is preserved only in trusted background state', async () => {
  const entries = []
  const humanMessage = 'Translated provider message with secret prompt fragment'
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'moonshotWebFree',
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithMoonshotWebApi: async (port) => {
        port.postMessage({ error: humanMessage })
      },
      logger: createLogger(entries),
    }),
  )

  await assert.rejects(
    dispatcher.generateText({
      modelSnapshot: { modelName: 'moonshotWebFree', apiMode: null },
      messages: [{ role: 'user', content: 'secret prompt fragment' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.message, 'MODEL_GATEWAY_PROVIDER_ERROR')
      assert.equal(error.code, 'MODEL_GATEWAY_PROVIDER_ERROR')
      assert.equal(error.trustedHumanMessage, humanMessage)
      assert.equal(Object.keys(error).includes('trustedHumanMessage'), false)
      assert.equal(JSON.stringify(error).includes(humanMessage), false)
      return true
    },
  )
  assert.equal(JSON.stringify(entries).includes(humanMessage), false)
  assert.equal(JSON.stringify(entries).includes('secret prompt fragment'), false)
})

test('isolated routes receive safe diagnostic sinks without touching global console', async () => {
  const globalConsoleMessages = []
  const originalDebug = console.debug
  console.debug = (...args) => {
    globalConsoleMessages.push(args.join(' '))
  }
  const diagnosticEntries = []
  const routeCalls = []
  const makeAdapter =
    (routeName) =>
    async (port, ...args) => {
      const options = args.at(-1)
      routeCalls.push(routeName)
      options.diagnostics.debug('safe adapter event', {
        routeName,
        prompt: 'secret prompt must not leak',
        answer: 'secret answer must not leak',
        token: 'secret-token',
        config: { apiKey: 'secret-config' },
      })
      console.debug('unrelated global console remains visible', routeName)
      port.postMessage({ answer: `${routeName} result`, done: true })
    }
  const dispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({
        modelName: 'chatgptFree35',
        chatgptTabId: null,
        kimiMoonShotRefreshToken: 'kimi-refresh',
      }),
      generateAnswersWithChatgptWebApi: makeAdapter('chatgpt-web-direct'),
      generateAnswersWithClaudeWebApi: makeAdapter('claude-web'),
      generateAnswersWithMoonshotWebApi: makeAdapter('kimi-web'),
      generateAnswersWithBingWebApi: makeAdapter('bing-web'),
      generateAnswersWithBardWebApi: makeAdapter('gemini-web'),
      generateAnswersWithOpenAICompatibleApi: makeAdapter('openai-compatible'),
      generateAnswersWithClaudeApi: makeAdapter('claude-api'),
      generateAnswersWithAzureOpenaiApi: makeAdapter('azure-openai'),
      generateAnswersWithWaylaidwandererApi: makeAdapter('github-third-party'),
      diagnosticSink(entry) {
        diagnosticEntries.push(entry)
      },
    }),
  )

  try {
    for (const modelName of [
      'chatgptFree35',
      'claude2WebFree',
      'moonshotWebFree',
      'bingFree4',
      'bardWebFree',
      'chatgptApi4oMini',
      'claudeSonnet45Api',
      'azureOpenAi',
      'waylaidwandererApi',
    ]) {
      await dispatcher.generateText({
        modelSnapshot: { modelName, apiMode: null },
        messages: [{ role: 'user', content: 'secret prompt must not leak' }],
        maxOutputTokens: 99,
        signal: new AbortController().signal,
      })
    }
  } finally {
    console.debug = originalDebug
  }

  assert.deepEqual(routeCalls, [
    'chatgpt-web-direct',
    'claude-web',
    'kimi-web',
    'bing-web',
    'gemini-web',
    'openai-compatible',
    'claude-api',
    'azure-openai',
    'github-third-party',
  ])
  assert.equal(globalConsoleMessages.length, 9)
  assert.equal(
    globalConsoleMessages.every((message) => message.includes('unrelated global console')),
    true,
  )
  const serializedDiagnostics = JSON.stringify(diagnosticEntries)
  assert.equal(serializedDiagnostics.includes('secret prompt must not leak'), false)
  assert.equal(serializedDiagnostics.includes('secret answer must not leak'), false)
  assert.equal(serializedDiagnostics.includes('secret-token'), false)
  assert.equal(serializedDiagnostics.includes('secret-config'), false)
  assert.equal(serializedDiagnostics.includes('safe adapter event'), true)
})

test('thrown login and generic adapter errors keep trusted text non-enumerable', async () => {
  const loginText = 'Please login translated message with sensitive prompt'
  const loginDispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'claude2WebFree' }),
      getClaudeSessionKey: async () => {
        throw new Error(loginText)
      },
    }),
  )

  await assert.rejects(
    loginDispatcher.generateText({
      modelSnapshot: { modelName: 'claude2WebFree', apiMode: null },
      messages: [{ role: 'user', content: 'sensitive prompt' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.message, 'MODEL_LOGIN_REQUIRED')
      assert.equal(error.trustedHumanMessage, loginText)
      assert.equal(Object.keys(error).includes('trustedHumanMessage'), false)
      assert.equal(JSON.stringify(error).includes(loginText), false)
      return true
    },
  )

  const genericText = 'Translated generic adapter failure with sensitive prompt'
  const genericDispatcher = createModelTextDispatcher(
    createBaseDependencies({
      getUserConfig: async () => ({ modelName: 'azureOpenAi' }),
      generateAnswersWithAzureOpenaiApi: async () => {
        throw new Error(genericText)
      },
    }),
  )

  await assert.rejects(
    genericDispatcher.generateText({
      modelSnapshot: { modelName: 'azureOpenAi', apiMode: null },
      messages: [{ role: 'user', content: 'sensitive prompt' }],
      maxOutputTokens: 1,
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(error.message, 'MODEL_GATEWAY_GENERATION_FAILED')
      assert.equal(error.trustedHumanMessage, genericText)
      assert.equal(Object.keys(error).includes('trustedHumanMessage'), false)
      assert.equal(JSON.stringify(error).includes(genericText), false)
      return true
    },
  )
})
