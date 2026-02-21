// Minimal browser-extension API shim for Node test runtime.
// Scope is intentionally small: only APIs used by current unit tests are mocked.
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

const storageLocal = {
  get(keys, callback) {
    const result = resolveStorageGet(keys)
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(result))
      return
    }
    return Promise.resolve(result)
  },
  set(items, callback) {
    Object.assign(storageState, items ?? {})
    if (typeof callback === 'function') {
      queueMicrotask(() => callback())
      return
    }
    return Promise.resolve()
  },
  clear(callback) {
    storageState = createStorageState()
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
  },
  tabs,
  windows,
  commands: {
    onCommand: commandsOnCommand,
  },
}

if (!globalThis.navigator) {
  globalThis.navigator = {
    language: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
  }
}

if (!globalThis.chrome) {
  globalThis.chrome = chromeShim
} else {
  globalThis.chrome.runtime ||= runtime
  globalThis.chrome.storage ||= { local: storageLocal }
  globalThis.chrome.storage.local ||= storageLocal
  globalThis.chrome.tabs ||= tabs
  globalThis.chrome.windows ||= windows
  globalThis.chrome.commands ||= { onCommand: commandsOnCommand }
}

globalThis.__TEST_BROWSER_SHIM__ = {
  setStorage(values) {
    Object.assign(storageState, values)
  },
  replaceStorage(values) {
    storageState = createStorageState(values)
  },
  clearStorage() {
    storageState = createStorageState()
  },
  getStorage() {
    return { ...storageState }
  },
  resetEvents() {
    runtimeOnMessage._clear()
    commandsOnCommand._clear()
  },
}
