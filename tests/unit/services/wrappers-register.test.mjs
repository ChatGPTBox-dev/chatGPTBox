import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'
import i18n from 'i18next'
import { createFakePort } from '../helpers/port.mjs'

// ---------------------------------------------------------------------------
// Extend browser shim with onConnect and cookies before importing source
// ---------------------------------------------------------------------------
const onConnectListeners = new Set()
globalThis.chrome.runtime.onConnect = {
  addListener(listener) {
    onConnectListeners.add(listener)
  },
  removeListener(listener) {
    onConnectListeners.delete(listener)
  },
}

let cookieJar = {}
globalThis.chrome.cookies = {
  getAll(query, callback) {
    const result = cookieJar[query.url] || []
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(result))
      return
    }
    return Promise.resolve(result)
  },
  get(query, callback) {
    const cookies = cookieJar[query.url] || []
    const found = cookies.find((c) => c.name === query.name) || null
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(found))
      return
    }
    return Promise.resolve(found)
  },
}

import {
  registerPortListener,
  getChatGptAccessToken,
  getBingAccessToken,
  getBardCookies,
  getClaudeSessionKey,
} from '../../../src/services/wrappers.mjs'
import Browser from 'webextension-polyfill'
import { normalizeApiMode } from '../../../src/utils/model-name-convert.mjs'
import { FETCH_REQUEST_FAILED } from '../../../src/utils/fetch-sse.mjs'
import { formatErrorMessage } from '../../../src/utils/error-text.mjs'

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

before(async () => {
  const summary = 'The browser could not complete the request to the API endpoint.'
  await i18n.init({
    resources: {
      en: { translation: { [summary]: summary } },
      zhHant: { translation: { [summary]: '瀏覽器無法完成對 API 端點的請求。' } },
    },
    fallbackLng: 'en',
  })
})

function triggerConnect(port) {
  for (const listener of Array.from(onConnectListeners)) {
    listener(port)
  }
}

function waitForPortError(port) {
  const postMessage = port.postMessage.bind(port)
  return new Promise((resolve) => {
    port.postMessage = (message) => {
      postMessage(message)
      if (message.error) resolve(message.error)
    }
  })
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
  onConnectListeners.clear()
  cookieJar = {}
})

// ---------------------------------------------------------------------------
// registerPortListener
// ---------------------------------------------------------------------------

test('registerPortListener calls executor with session, port, and config', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async (session, port, config) => {
    resolveExec({ session, port, config })
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  const result = await execDone

  assert.equal(executor.mock.calls.length, 1)
  assert.equal(result.session.modelName, 'chatgptApi4oMini')
  assert.ok(result.config)
  // Session should be posted back before executor runs
  assert.equal(port.postedMessages[0].session, result.session)
})

test('registerPortListener scopes error translations to each request', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'error', () => {})
  setStorage({
    hideContextMenu: true,
    modelName: 'chatgptApi4oMini',
    preferredLanguage: 'zhHant',
    userLanguage: 'en',
  })
  await i18n.changeLanguage('en')

  let releaseFirstRequest
  const firstRequestRelease = new Promise((resolve) => {
    releaseFirstRequest = resolve
  })
  let markFirstRequestStarted
  const firstRequestStarted = new Promise((resolve) => {
    markFirstRequestStarted = resolve
  })
  const executor = t.mock.fn(async (session) => {
    if (session.requestId === 'first') {
      markFirstRequestStarted()
      await firstRequestRelease
    }
    const error = new TypeError('Failed to fetch')
    error.code = FETCH_REQUEST_FAILED
    throw error
  })

  registerPortListener(executor)
  const firstPort = createFakePort()
  const firstErrorPosted = waitForPortError(firstPort)
  triggerConnect(firstPort)
  firstPort.emitMessage({ session: { requestId: 'first' } })
  await firstRequestStarted

  setStorage({
    hideContextMenu: true,
    modelName: 'chatgptApi4oMini',
    preferredLanguage: 'en',
    userLanguage: 'en',
  })
  const secondPort = createFakePort()
  const secondErrorPosted = waitForPortError(secondPort)
  triggerConnect(secondPort)
  secondPort.emitMessage({ session: { requestId: 'second' } })

  const secondError = await secondErrorPosted
  releaseFirstRequest()
  const firstError = await firstErrorPosted

  assert.match(firstError, /^瀏覽器無法完成對 API 端點的請求。/)
  assert.match(secondError, /^The browser could not complete the request to the API endpoint\./)
  assert.equal(i18n.language, 'en')
})

test('registerPortListener defaults modelName from config when not set', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'claude2Api' })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async (session) => {
    resolveExec(session)
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  const session = await execDone

  assert.equal(session.modelName, 'claudeSonnet46Api')
})

test('registerPortListener preserves modelName when already set', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async (session) => {
    resolveExec(session)
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { modelName: 'customModel', conversationRecords: [] } })
  const session = await execDone

  assert.equal(session.modelName, 'customModel')
})

test('registerPortListener skips apiMode default for customModel', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'customModel', apiMode: { groupName: 'openai', itemName: 'gpt-4o' } })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async (session) => {
    resolveExec(session)
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { modelName: 'customModel', conversationRecords: [] } })
  const session = await execDone

  assert.equal(session.apiMode, undefined)
})

test('registerPortListener defaults apiMode from config for non-custom models', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const apiMode = { groupName: 'openai', itemName: 'gpt-4o' }
  setStorage({ modelName: 'chatgptApi4oMini', apiMode })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async (session) => {
    resolveExec(session)
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  const session = await execDone

  assert.deepEqual(session.apiMode, normalizeApiMode(apiMode))
})

test('registerPortListener sets aiName when not provided', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async (session) => {
    resolveExec(session)
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  const session = await execDone

  // aiName is assigned (t() may return undefined when i18next is not initialised)
  assert.ok(Object.hasOwn(session, 'aiName'))
})

test('registerPortListener ignores messages without session', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  const executor = t.mock.fn(async () => {})

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ notSession: true })
  // Give the async handler a tick to process
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(executor.mock.calls.length, 0)
  assert.deepEqual(port.postedMessages, [])
})

test('registerPortListener tags responses with proxy and request generation ids', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  let resolveExec
  const execDone = new Promise((resolve) => {
    resolveExec = resolve
  })
  const executor = t.mock.fn(async (_session, requestPort) => {
    requestPort.postMessage({ done: true })
    resolveExec()
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({
    session: { conversationRecords: [] },
    proxyGenerationId: 7,
    requestGenerationId: 11,
  })
  await execDone

  assert.equal(port.postedMessages.length, 2)
  assert.equal(
    port.postedMessages.every(
      (message) => message.proxyGenerationId === 7 && message.requestGenerationId === 11,
    ),
    true,
  )
})

test('registerPortListener drops responses from a superseded session request', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  const requestPorts = []
  const connectionPorts = []
  let resolveRequest
  const requestReady = () =>
    new Promise((resolve) => {
      resolveRequest = resolve
    })
  let ready = requestReady()
  const executor = t.mock.fn(
    async (
      _session,
      requestPort,
      _config,
      _isLatestSessionRequest,
      _requestGenerationId,
      connectionPort,
    ) => {
      requestPorts.push(requestPort)
      connectionPorts.push(connectionPort)
      resolveRequest()
    },
  )

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  await ready
  ready = requestReady()
  port.emitMessage({ session: { conversationRecords: [] } })
  await ready

  assert.notEqual(requestPorts[0], requestPorts[1])
  assert.deepEqual(connectionPorts, [port, port])

  requestPorts[0].postMessage({ done: true })
  assert.equal(port.postedMessages.length, 2)
  requestPorts[1].postMessage({ done: true })

  assert.equal(port.postedMessages.length, 3)
  assert.deepEqual(port.postedMessages.at(-1), { done: true })
})

test('registerPortListener allows a stopped request to post before its replacement starts', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  let requestPort
  let resolveExec
  const execReady = new Promise((resolve) => {
    resolveExec = resolve
  })
  const executor = t.mock.fn(async (_session, currentRequestPort) => {
    requestPort = currentRequestPort
    resolveExec()
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  await execReady
  port.emitMessage({ stop: true })
  requestPort.postMessage({ session: { conversationRecords: [] } })

  assert.deepEqual(port.postedMessages.slice(-2), [
    { done: true },
    { session: { conversationRecords: [] } },
  ])
})

test('registerPortListener catches executor errors and calls handlePortError', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(console, 'error', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  let resolveExec
  const execDone = new Promise((r) => {
    resolveExec = r
  })
  const executor = t.mock.fn(async () => {
    resolveExec()
    throw new Error('executor boom')
  })

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  port.emitMessage({ session: { conversationRecords: [] } })
  await execDone
  // Give time for the catch block to run
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(executor.mock.calls.length, 1)
  // handlePortError should have posted an error message
  assert.ok(port.postedMessages.some((m) => m.error === formatErrorMessage('executor boom')))
})

test('registerPortListener removes listeners on port disconnect', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ modelName: 'chatgptApi4oMini' })

  const executor = t.mock.fn(async () => {})

  registerPortListener(executor)
  const port = createFakePort()
  triggerConnect(port)

  // Port now has onMessage + onDisconnect listeners
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })

  port.emitDisconnect()

  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

// ---------------------------------------------------------------------------
// getChatGptAccessToken — cached token
// ---------------------------------------------------------------------------

test('getChatGptAccessToken returns cached token from config', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ accessToken: 'cached-token-123', tokenSavedOn: Date.now() })

  const token = await getChatGptAccessToken()
  assert.equal(token, 'cached-token-123')
})

// ---------------------------------------------------------------------------
// getChatGptAccessToken — fetch from session endpoint
// ---------------------------------------------------------------------------

test('getChatGptAccessToken fetches token when not cached', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ tokenSavedOn: Date.now() })
  cookieJar['https://chatgpt.com/'] = [
    { name: 'session', value: 'abc' },
    { name: 'cf', value: 'xyz' },
  ]

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/api/auth/session')
    assert.equal(init.credentials, 'include')
    assert.equal(init.headers.Cookie, 'session=abc; cf=xyz')
    return {
      status: 200,
      json: async () => ({ accessToken: 'fresh-token-456' }),
    }
  })

  const token = await getChatGptAccessToken()
  assert.equal(token, 'fresh-token-456')
})

test('getChatGptAccessToken throws CLOUDFLARE on 403', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ tokenSavedOn: Date.now() })
  cookieJar['https://chatgpt.com/'] = []

  t.mock.method(globalThis, 'fetch', async () => ({
    status: 403,
    json: async () => ({}),
  }))

  await assert.rejects(() => getChatGptAccessToken(), { message: 'CLOUDFLARE' })
})

test('getChatGptAccessToken throws UNAUTHORIZED when response has no token', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ tokenSavedOn: Date.now() })
  cookieJar['https://chatgpt.com/'] = []

  t.mock.method(globalThis, 'fetch', async () => ({
    status: 200,
    json: async () => ({}),
  }))

  await assert.rejects(() => getChatGptAccessToken(), { message: 'UNAUTHORIZED' })
})

test('getChatGptAccessToken throws UNAUTHORIZED when json parsing fails', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ tokenSavedOn: Date.now() })
  cookieJar['https://chatgpt.com/'] = []

  t.mock.method(globalThis, 'fetch', async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError('bad json')
    },
  }))

  await assert.rejects(() => getChatGptAccessToken(), { message: 'UNAUTHORIZED' })
})

// ---------------------------------------------------------------------------
// getChatGptAccessToken — Browser.cookies unavailable (issue #912)
// ---------------------------------------------------------------------------

test('getChatGptAccessToken omits Cookie header when Browser.cookies.getAll is unavailable', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ tokenSavedOn: Date.now() })

  // Simulate environments (e.g. some Firefox / restricted contexts) where
  // chrome.cookies.getAll is not exposed. Override on the polyfill object
  // and restore afterwards so other tests are unaffected.
  const originalGetAll = Browser.cookies.getAll
  Object.defineProperty(Browser.cookies, 'getAll', {
    value: undefined,
    writable: true,
    configurable: true,
  })
  t.after(() => {
    Object.defineProperty(Browser.cookies, 'getAll', {
      value: originalGetAll,
      writable: true,
      configurable: true,
    })
  })

  let observedCredentials
  let observedHasCookieHeader
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/api/auth/session')
    observedCredentials = init.credentials
    observedHasCookieHeader = Object.prototype.hasOwnProperty.call(init.headers, 'Cookie')
    return {
      status: 200,
      json: async () => ({ accessToken: 'token-without-cookies' }),
    }
  })

  const token = await getChatGptAccessToken()
  assert.equal(token, 'token-without-cookies')
  // No empty Cookie header — let the browser attach session cookies via credentials: 'include'.
  assert.equal(observedHasCookieHeader, false)
  assert.equal(observedCredentials, 'include')
})

test('getChatGptAccessToken omits Cookie header when Browser.cookies is undefined', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({ tokenSavedOn: Date.now() })

  // Simulate environments where the cookies API is entirely missing.
  const originalCookies = Browser.cookies
  Browser.cookies = undefined
  t.after(() => {
    Browser.cookies = originalCookies
  })

  let observedCredentials
  let observedHasCookieHeader
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    observedCredentials = init.credentials
    observedHasCookieHeader = Object.prototype.hasOwnProperty.call(init.headers, 'Cookie')
    return {
      status: 200,
      json: async () => ({ accessToken: 'token-no-cookies-api' }),
    }
  })

  const token = await getChatGptAccessToken()
  assert.equal(token, 'token-no-cookies-api')
  assert.equal(observedHasCookieHeader, false)
  assert.equal(observedCredentials, 'include')
})

// ---------------------------------------------------------------------------
// getBingAccessToken
// ---------------------------------------------------------------------------

test('getBingAccessToken returns _U cookie value', async () => {
  cookieJar['https://bing.com/'] = [{ name: '_U', value: 'bing-token' }]

  const token = await getBingAccessToken()
  assert.equal(token, 'bing-token')
})

test('getBingAccessToken returns undefined when cookie missing', async () => {
  cookieJar['https://bing.com/'] = []

  const token = await getBingAccessToken()
  assert.equal(token, undefined)
})

// ---------------------------------------------------------------------------
// getBardCookies
// ---------------------------------------------------------------------------

test('getBardCookies returns formatted cookie string', async () => {
  cookieJar['https://google.com/'] = [{ name: '__Secure-1PSID', value: 'bard-sid' }]

  const cookies = await getBardCookies()
  assert.equal(cookies, '__Secure-1PSID=bard-sid')
})

test('getBardCookies returns __Secure-1PSID=undefined when cookie missing', async () => {
  cookieJar['https://google.com/'] = []

  const cookies = await getBardCookies()
  assert.equal(cookies, '__Secure-1PSID=undefined')
})

// ---------------------------------------------------------------------------
// getClaudeSessionKey
// ---------------------------------------------------------------------------

test('getClaudeSessionKey returns sessionKey cookie value', async () => {
  cookieJar['https://claude.ai/'] = [{ name: 'sessionKey', value: 'sk-claude' }]

  const key = await getClaudeSessionKey()
  assert.equal(key, 'sk-claude')
})

test('getClaudeSessionKey returns undefined when cookie missing', async () => {
  cookieJar['https://claude.ai/'] = []

  const key = await getClaudeSessionKey()
  assert.equal(key, undefined)
})
