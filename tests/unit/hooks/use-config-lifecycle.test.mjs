import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, afterEach, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import PropTypes from 'prop-types'

register('./tests/setup/use-config-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let dom
let useConfig
const originalDescriptors = new Map()
const globalNames = ['window', 'document', 'Node', 'HTMLElement']

function ConfigProbe({ onConfig, onInit }) {
  const config = useConfig(onInit)
  onConfig(config)
  return null
}

ConfigProbe.propTypes = {
  onConfig: PropTypes.func.isRequired,
  onInit: PropTypes.func.isRequired,
}

const createContainer = () => {
  const container = document.createElement('div')
  document.body.append(container)
  return container
}

const mountProbe = (container, onConfig, onInit) => {
  act(() => {
    render(h(ConfigProbe, { onConfig, onInit }), container)
  })
}

const unmountProbe = (container) => {
  act(() => {
    render(null, container)
  })
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')

  for (const name of globalNames) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    })
  }

  globalThis.__USE_CONFIG_TEST__ = {
    getUserConfig: async () => ({ status: 'loaded' }),
    setConfigCalls: 0,
    storageListeners: new Set(),
  }
  ;({ useConfig } = await import('../../../src/hooks/use-config.mjs'))
})

afterEach(() => {
  document.body.replaceChildren()
  globalThis.__USE_CONFIG_TEST__.setConfigCalls = 0
  globalThis.__USE_CONFIG_TEST__.storageListeners.clear()
  globalThis.__USE_CONFIG_TEST__.getUserConfig = async () => ({ status: 'loaded' })
})

after(() => {
  dom.window.close()
  delete globalThis.__USE_CONFIG_TEST__

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

test('useConfig applies a pending config result while still mounted', async () => {
  const pendingConfig = deferred()
  const observed = []
  let initCount = 0
  const state = globalThis.__USE_CONFIG_TEST__
  state.getUserConfig = () => pendingConfig.promise
  const container = createContainer()

  mountProbe(
    container,
    (config) => observed.push(config),
    () => {
      initCount += 1
    },
  )

  assert.equal(state.storageListeners.size, 1)
  assert.equal(observed.at(-1).status, 'default')

  await act(async () => {
    pendingConfig.resolve({ status: 'loaded' })
    await pendingConfig.promise
    await Promise.resolve()
  })

  assert.equal(state.setConfigCalls, 1)
  assert.equal(initCount, 1)
  assert.equal(observed.at(-1).status, 'loaded')

  unmountProbe(container)
  assert.equal(state.storageListeners.size, 0)
})

test('useConfig ignores a pending config result after unmount', async () => {
  const pendingConfig = deferred()
  let initCount = 0
  const state = globalThis.__USE_CONFIG_TEST__
  state.getUserConfig = () => pendingConfig.promise
  const container = createContainer()

  mountProbe(
    container,
    () => {},
    () => {
      initCount += 1
    },
  )
  unmountProbe(container)

  assert.equal(state.storageListeners.size, 0)

  await act(async () => {
    pendingConfig.resolve({ status: 'stale' })
    await pendingConfig.promise
    await Promise.resolve()
  })

  assert.equal(state.setConfigCalls, 0)
  assert.equal(initCount, 0)
})

test('an old unmounted config result cannot affect a later mount', async () => {
  const firstConfig = deferred()
  const secondConfig = deferred()
  const state = globalThis.__USE_CONFIG_TEST__
  let configRead = 0
  let firstInitCount = 0
  let secondInitCount = 0
  const secondObserved = []

  state.getUserConfig = () => {
    configRead += 1
    return configRead === 1 ? firstConfig.promise : secondConfig.promise
  }

  const firstContainer = createContainer()
  mountProbe(
    firstContainer,
    () => {},
    () => {
      firstInitCount += 1
    },
  )
  unmountProbe(firstContainer)

  const secondContainer = createContainer()
  mountProbe(
    secondContainer,
    (config) => secondObserved.push(config),
    () => {
      secondInitCount += 1
    },
  )

  await act(async () => {
    secondConfig.resolve({ status: 'second' })
    await secondConfig.promise
    await Promise.resolve()
  })

  assert.equal(state.setConfigCalls, 1)
  assert.equal(secondInitCount, 1)
  assert.equal(secondObserved.at(-1).status, 'second')

  await act(async () => {
    firstConfig.resolve({ status: 'first-stale' })
    await firstConfig.promise
    await Promise.resolve()
  })

  assert.equal(state.setConfigCalls, 1)
  assert.equal(firstInitCount, 0)
  assert.equal(secondInitCount, 1)
  assert.equal(secondObserved.at(-1).status, 'second')
  assert.equal(state.storageListeners.size, 1)

  unmountProbe(secondContainer)
  assert.equal(state.storageListeners.size, 0)
})
