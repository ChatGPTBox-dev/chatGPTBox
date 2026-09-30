import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createFakePort } from '../../helpers/port.mjs'

register('./tests/setup/bing-web-lifecycle-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

const deferred = () => {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 50; ++attempt) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(message)
}

let generateAnswersWithBingWebApi

before(async () => {
  globalThis.__BING_WEB_LIFECYCLE_TEST__ = {
    clientConstructCount: 0,
    sendMessageCount: 0,
    getUserConfig: async () => ({ modelMode: 'balanced' }),
    sendMessage: async () => {
      throw new Error('sendMessage should not run in this regression test')
    },
  }
  ;({ generateAnswersWithBingWebApi } = await import('../../../../src/services/apis/bing-web.mjs'))
})

after(() => {
  delete globalThis.__BING_WEB_LIFECYCLE_TEST__
})

test('configuration failure cleans Bing provider listeners before rejecting', async () => {
  const state = globalThis.__BING_WEB_LIFECYCLE_TEST__
  const configError = new Error('configuration failed')
  state.clientConstructCount = 0
  state.sendMessageCount = 0
  state.getUserConfig = async () => {
    throw configError
  }

  const port = createFakePort()
  const session = {
    conversationRecords: [],
    modelName: 'test-model',
  }

  await assert.rejects(
    generateAnswersWithBingWebApi(port, 'question', session, 'token'),
    configError,
  )

  assert.equal(state.clientConstructCount, 0)
  assert.equal(state.sendMessageCount, 0)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  assert.deepEqual(port.postedMessages, [])
})

test('aborting while provider config is pending prevents Bing request startup', async () => {
  const state = globalThis.__BING_WEB_LIFECYCLE_TEST__
  const pendingConfig = deferred()
  let configReadCount = 0
  state.clientConstructCount = 0
  state.sendMessageCount = 0
  state.getUserConfig = () => {
    configReadCount += 1
    return pendingConfig.promise
  }

  const port = createFakePort()
  const session = {
    conversationRecords: [],
    modelName: 'test-model',
  }

  const generation = generateAnswersWithBingWebApi(port, 'question', session, 'token')
  await waitFor(() => configReadCount === 1, 'provider configuration read did not start')

  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 1 })
  port.emitDisconnect()
  assert.deepEqual(port.listenerCounts(), { onMessage: 1, onDisconnect: 0 })

  pendingConfig.resolve({ modelMode: 'balanced' })
  await generation

  assert.equal(state.clientConstructCount, 0)
  assert.equal(state.sendMessageCount, 0)
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
  assert.deepEqual(port.postedMessages, [])
})
