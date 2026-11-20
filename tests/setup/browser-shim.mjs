// Minimal browser-extension API shim for Node test runtime.
// Scope is intentionally small: only APIs used by current unit tests are mocked.
import { isDeepStrictEqual } from 'node:util'
const createEvent = () => {
  const listeners = new Set()
  return {
    addListener(listener) {
      listeners.add(listener)
    },
    removeListener(listener) {
      listeners.delete(listener)
    },
    hasListener(listener) {
      return listeners.has(listener)
    },
    _trigger(...args) {
      for (const listener of Array.from(listeners)) {
        listener(...args)
      }
    },
    _clear() {
      listeners.clear()
    },
    _size() {
      return listeners.size
    },
  }
}

const runtimeOnMessage = createEvent()
const commandsOnCommand = createEvent()

const createStorageState = (values = {}) => Object.assign(Object.create(null), values)
let storageState = createStorageState()

const resolveStorageGet = (keys) => {
  if (keys === null || keys === undefined) return { ...storageState }

  if (typeof keys === 'string') {
    return Object.hasOwn(storageState, keys) ? { [keys]: storageState[keys] } : {}
  }

  if (Array.isArray(keys)) {
    const result = {}
    for (const key of keys) {
      if (Object.hasOwn(storageState, key)) result[key] = storageState[key]
    }
    return result
  }

  if (typeof keys === 'object') {
    const result = {}
    for (const [key, defaultValue] of Object.entries(keys)) {
      if (Object.hasOwn(storageState, key)) result[key] = storageState[key]
      else result[key] = defaultValue
    }
    return result
  }

  return {}
}

const storageLocalOnChanged = createEvent()
const storageOnChanged = createEvent()

// Both events of the real API are modelled: the area-specific
// `storage.local.onChanged` (Chromium 73, Firefox 101, Safari 14) and
// `storage.onChanged` for every area, which reports the area name as a second
// argument. Values are compared with structural equality, like Chromium; the
// `fireUnchangedKeys` option reproduces Firefox, which reports keys of the set
// call without checking whether the value changed.
//
// Events fire synchronously, so an invalidation is observable by the time an
// awaited `set`/`remove`/`clear` resolves, while the real events arrive later.
const fireStorageChanged = (
  before,
  after,
  { fireUnchangedKeys = false } = {},
  writtenKeys = undefined,
) => {
  const reportedKeys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
    ...(writtenKeys ?? []),
  ])

  const changes = {}
  for (const key of reportedKeys) {
    const hadKey = Object.hasOwn(before, key)
    const hasKey = Object.hasOwn(after, key)
    const unchanged = hadKey === hasKey && isDeepStrictEqual(before[key], after[key])
    // Chromium skips unchanged keys, while Firefox reports every key of the
    // write it performed, so an unchanged key is only reported when it was one
    // of the written keys.
    const reportUnchanged = fireUnchangedKeys && writtenKeys?.includes(key)
    if (unchanged && !reportUnchanged) continue
    changes[key] = { oldValue: before[key], newValue: after[key] }
  }
  if (Object.keys(changes).length === 0) return
  if (deferStorageEvents) {
    deferredStorageEvents.push(structuredClone(changes))
    return
  }
  storageLocalOnChanged._trigger(changes)
  storageOnChanged._trigger(changes, 'local')
}

// Extension contexts each hold their own module memory but share storage, and the
// storage-change event is delivered asynchronously, so a write that has already
// completed in one context is not visible to another until the event reaches it.
// Holding events back models that window, which is what a test has to reproduce to
// observe it.
let deferStorageEvents = false
const deferredStorageEvents = []

const storageLocal = {
  onChanged: storageLocalOnChanged,
  get(keys, callback) {
    const result = resolveStorageGet(keys)
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(result))
      return
    }
    return Promise.resolve(result)
  },
  set(items, callback) {
    const before = { ...storageState }
    const writtenKeys = Object.keys(items ?? {})
    Object.assign(storageState, items ?? {})
    fireStorageChanged(before, storageState, undefined, writtenKeys)
    if (typeof callback === 'function') {
      queueMicrotask(() => callback())
      return
    }
    return Promise.resolve()
  },
  remove(keys, callback) {
    const before = { ...storageState }
    const keyList = Array.isArray(keys) ? keys : [keys]
    for (const key of keyList) {
      delete storageState[key]
    }
    fireStorageChanged(before, storageState, undefined, keyList)
    if (typeof callback === 'function') {
      queueMicrotask(() => callback())
      return
    }
    return Promise.resolve()
  },
  clear(callback) {
    const before = { ...storageState }
    storageState = createStorageState()
    fireStorageChanged(before, storageState)
    if (typeof callback === 'function') {
      queueMicrotask(() => callback())
      return
    }
    return Promise.resolve()
  },
}

const tabs = {
  query(_queryInfo, callback) {
    const result = []
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(result))
      return
    }
    return Promise.resolve(result)
  },
  sendMessage(_tabId, _message, optionsOrCallback, callback) {
    const cb =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : typeof callback === 'function'
        ? callback
        : null
    if (cb) {
      queueMicrotask(() => cb())
      return
    }
    return Promise.resolve()
  },
}

const windows = {
  create(_createData, callback) {
    const result = { id: 1 }
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(result))
      return
    }
    return Promise.resolve(result)
  },
  update(_windowId, _updateInfo, callback) {
    const result = { id: 1 }
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(result))
      return
    }
    return Promise.resolve(result)
  },
}

const runtime = {
  id: 'test-extension-id',
  onMessage: runtimeOnMessage,
  sendMessage(_message, optionsOrCallback, callback) {
    const cb =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : typeof callback === 'function'
        ? callback
        : null
    if (cb) {
      queueMicrotask(() => cb())
      return
    }
    return Promise.resolve()
  },
  getURL(path) {
    return `chrome-extension://test/${path}`
  },
}

const chromeShim = {
  runtime,
  storage: {
    local: storageLocal,
    onChanged: storageOnChanged,
  },
  tabs,
  windows,
  commands: {
    onCommand: commandsOnCommand,
  },
}

Object.defineProperty(globalThis, 'navigator', {
  value: {
    language: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
  },
  configurable: true,
})

if (!globalThis.chrome) {
  globalThis.chrome = chromeShim
} else {
  globalThis.chrome.runtime ||= runtime
  globalThis.chrome.storage ||= { local: storageLocal, onChanged: storageOnChanged }
  globalThis.chrome.storage.local ||= storageLocal
  globalThis.chrome.storage.onChanged ||= storageOnChanged
  globalThis.chrome.storage.local.onChanged ||= storageLocalOnChanged
  globalThis.chrome.tabs ||= tabs
  globalThis.chrome.windows ||= windows
  globalThis.chrome.commands ||= { onCommand: commandsOnCommand }
}

// The config module listens for locale changes on the global object, which the
// Node test runtime does not have. This gives the tests the same hook.
const globalListeners = new Map()
globalThis.addEventListener = (type, listener) => {
  if (!globalListeners.has(type)) globalListeners.set(type, new Set())
  globalListeners.get(type).add(listener)
}
globalThis.removeEventListener = (type, listener) => {
  globalListeners.get(type)?.delete(listener)
}
globalThis.__TEST_BROWSER_SHIM__ = {
  // Fire a window-level event, such as the locale change the config module
  // listens for.
  dispatchGlobalEvent(type) {
    for (const listener of [...(globalListeners.get(type) ?? [])]) listener()
  },
  setStorage(values, options) {
    const before = { ...storageState }
    Object.assign(storageState, values)
    fireStorageChanged(before, storageState, options, Object.keys(values ?? {}))
  },
  replaceStorage(values) {
    const before = { ...storageState }
    storageState = createStorageState(values)
    fireStorageChanged(before, storageState)
  },
  clearStorage() {
    const before = { ...storageState }
    storageState = createStorageState()
    fireStorageChanged(before, storageState)
  },
  getStorage() {
    return { ...storageState }
  },
  resetEvents() {
    runtimeOnMessage._clear()
    commandsOnCommand._clear()
  },
  resetStorageEvents() {
    storageLocalOnChanged._clear()
    storageOnChanged._clear()
  },
  // Hold storage-change events back, so a test can read storage in the window
  // between a write resolving and its event being delivered.
  deferStorageEvents(defer = true) {
    deferStorageEvents = defer
  },
  // Deliver everything held back, in the order the writes happened.
  flushStorageEvents() {
    deferStorageEvents = false
    const queued = deferredStorageEvents.splice(0)
    for (const changes of queued) {
      storageLocalOnChanged._trigger(changes)
      storageOnChanged._trigger(changes, 'local')
    }
    return queued.length
  },
  pendingStorageEvents() {
    return deferredStorageEvents.length
  },
}
