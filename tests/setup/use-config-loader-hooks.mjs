const sources = {
  'test:use-config-react': `
    import { useEffect as preactUseEffect, useState as preactUseState } from 'preact/hooks'

    export const useEffect = preactUseEffect
    export const useState = (initialValue) => {
      const [value, setValue] = preactUseState(initialValue)
      return [
        value,
        (nextValue) => {
          globalThis.__USE_CONFIG_TEST__.setConfigCalls += 1
          return setValue(nextValue)
        },
      ]
    }
  `,
  'test:use-config-config': `
    export const defaultConfig = { status: 'default' }
    export const getUserConfig = () => globalThis.__USE_CONFIG_TEST__.getUserConfig()
  `,
  'test:use-config-browser': `
    const state = globalThis.__USE_CONFIG_TEST__
    export default {
      storage: {
        local: {
          onChanged: {
            addListener(listener) {
              state.storageListeners.add(listener)
            },
            removeListener(listener) {
              state.storageListeners.delete(listener)
            },
          },
        },
      },
    }
  `,
  'test:use-config-listener': `
    export const createConfigStorageListener = () => () => {}
  `,
}

const stubs = new Map([
  ['react', 'test:use-config-react'],
  ['../config/index.mjs', 'test:use-config-config'],
  ['webextension-polyfill', 'test:use-config-browser'],
  ['./config-storage-listener.mjs', 'test:use-config-listener'],
])

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/hooks/use-config.mjs')) {
    const stubUrl = stubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  if (context.parentURL === 'test:use-config-react' && specifier === 'preact/hooks') {
    return nextResolve(specifier, { ...context, parentURL: import.meta.url })
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:use-config-')) {
    return {
      shortCircuit: true,
      format: 'module',
      source: sources[url],
    }
  }

  return nextLoad(url, context)
}
