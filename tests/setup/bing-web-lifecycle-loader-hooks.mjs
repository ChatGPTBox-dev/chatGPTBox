const sources = {
  'test:bing-web-config': `
    export const getUserConfig = () => globalThis.__BING_WEB_LIFECYCLE_TEST__.getUserConfig()
  `,
  'test:bing-web-client': `
    export default class BingAIClient {
      constructor() {
        const state = globalThis.__BING_WEB_LIFECYCLE_TEST__
        state.clientConstructCount += 1
        this.conversationsCache = new Map()
      }

      async sendMessage(...args) {
        const state = globalThis.__BING_WEB_LIFECYCLE_TEST__
        state.sendMessageCount += 1
        return state.sendMessage(...args)
      }
    }
  `,
  'test:bing-web-model': `
    export const getModelValue = () => null
  `,
}

const stubs = new Map([
  ['../../config/index.mjs', 'test:bing-web-config'],
  ['../clients/bing/index.mjs', 'test:bing-web-client'],
  ['../../utils/model-name-convert.mjs', 'test:bing-web-model'],
])

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/services/apis/bing-web.mjs')) {
    const stubUrl = stubs.get(specifier)
    if (stubUrl) return { url: stubUrl, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('test:bing-web-')) {
    return {
      shortCircuit: true,
      format: 'module',
      source: sources[url],
    }
  }

  return nextLoad(url, context)
}
