import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
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

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

function triggerConnect(port) {
  for (const listener of Array.from(onConnectListeners)) {
    listener(port)
  }
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

  assert.equal(session.modelName, 'claude2Api')
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

  assert.deepEqual(session.apiMode, apiMode)
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
  assert.ok(port.postedMessages.some((m) => m.error === 'executor boom'))
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
