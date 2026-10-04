import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelGateway } from '../../../src/background/model-gateway.mjs'

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

function createGateway(overrides = {}) {
  return createModelGateway({
    getUserConfig: async () => ({}),
    describeModelTextSupport: () => ({ state: 'supported' }),
    generateTextWithModel: async () => ({ text: 'summary', finishReason: 'stop' }),
    logger: createLogger([]),
    ...overrides,
  })
}

test('describeCapabilities reports Kimi Web as text-capable', async () => {
  const gateway = createModelGateway({
    getUserConfig: async () => ({ kimiMoonShotRefreshToken: 'secret' }),
    describeModelTextSupport: (config, modelIdentity) => {
      assert.deepEqual(config, { kimiMoonShotRefreshToken: 'secret' })
      assert.deepEqual(modelIdentity, { modelName: 'moonshotWebFree' })
      return { state: 'supported' }
    },
    generateTextWithModel: async () => ({ text: 'unused', finishReason: null }),
    logger: createLogger([]),
  })

  assert.deepEqual(await gateway.describeCapabilities({ modelName: 'moonshotWebFree' }), {
    supported: true,
    state: 'supported',
    reason: null,
    condition: null,
    inputTokenBudget: 4000,
    maxOutputTokens: 20_000,
  })
})

test('describeCapabilities preserves unsupported, temporary, and actionable conditions', async () => {
  const descriptors = [
    {
      support: { state: 'unsupported', reason: 'MODEL_GATEWAY_UNSUPPORTED' },
      expected: {
        supported: false,
        state: 'unsupported',
        reason: 'MODEL_GATEWAY_UNSUPPORTED',
        condition: null,
        inputTokenBudget: 4000,
        maxOutputTokens: 20_000,
      },
    },
    {
      support: { state: 'temporary', reason: 'MODEL_TEMPORARY_FAILURE', condition: 'temporary' },
      expected: {
        supported: false,
        state: 'temporary',
        reason: 'MODEL_TEMPORARY_FAILURE',
        condition: 'temporary',
        inputTokenBudget: 4000,
        maxOutputTokens: 20_000,
      },
    },
  ]

  for (const { support, expected } of descriptors) {
    const gateway = createGateway({ describeModelTextSupport: () => support })
    assert.deepEqual(await gateway.describeCapabilities({ modelName: 'test-model' }), expected)
  }

  for (const condition of ['login-required', 'provider-page-required']) {
    const error = Object.assign(new Error('private provider detail'), {
      code:
        condition === 'login-required' ? 'MODEL_LOGIN_REQUIRED' : 'MODEL_PROVIDER_PAGE_REQUIRED',
      condition,
    })
    const gateway = createGateway({
      describeModelTextSupport() {
        throw error
      },
    })
    assert.deepEqual(await gateway.describeCapabilities({ modelName: 'test-model' }), {
      supported: false,
      state: 'temporary',
      reason: error.code,
      condition,
      inputTokenBudget: 4000,
      maxOutputTokens: 20_000,
    })
  }
})

test('describeCapabilities converts unknown failures to a safe temporary descriptor', async () => {
  const gateway = createGateway({
    describeModelTextSupport() {
      throw new Error('secret provider response')
    },
  })

  assert.deepEqual(await gateway.describeCapabilities({ modelName: 'test-model' }), {
    supported: false,
    state: 'temporary',
    reason: 'MODEL_TEMPORARY_FAILURE',
    condition: 'temporary',
    inputTokenBudget: 4000,
    maxOutputTokens: 20_000,
  })
})

test('generateText forwards immutable inputs, bounded output tokens, and an abort signal', async () => {
  const entries = []
  let capturedArgs
  const gateway = createGateway({
    generateTextWithModel: async (args) => {
      capturedArgs = args
      args.modelSnapshot.modelName = 'mutated'
      args.messages[0].content = 'mutated'
      return { text: 'private returned summary', finishReason: 'length', raw: 'private payload' }
    },
    logger: createLogger(entries),
  })
  const modelSnapshot = Object.freeze({
    modelName: 'moonshotWebFree',
    apiMode: Object.freeze({ groupName: 'web', providerId: 'kimi' }),
  })
  const messages = Object.freeze([
    Object.freeze({ role: 'user', content: 'private transcript content' }),
  ])

  const result = await gateway.generateText({
    requestId: 'request-1',
    taskId: 'task-1',
    modelSnapshot,
    messages,
    maxOutputTokens: 50_000,
  })

  assert.deepEqual(result, { text: 'private returned summary', finishReason: 'length' })
  assert.notEqual(capturedArgs.modelSnapshot, modelSnapshot)
  assert.notEqual(capturedArgs.messages, messages)
  assert.equal(capturedArgs.maxOutputTokens, 20_000)
  assert.equal(typeof capturedArgs.signal?.aborted, 'boolean')
  assert.deepEqual(modelSnapshot, {
    modelName: 'moonshotWebFree',
    apiMode: { groupName: 'web', providerId: 'kimi' },
  })
  assert.deepEqual(messages, [{ role: 'user', content: 'private transcript content' }])
  const logs = JSON.stringify(entries)
  assert.equal(logs.includes('private transcript content'), false)
  assert.equal(logs.includes('private returned summary'), false)
  assert.equal(logs.includes('private payload'), false)
  assert.equal(logs.includes('"messages"'), false)
  assert.equal(logs.includes('length'), true)
})

test('generateText logs safe metadata when generation fails', async () => {
  const entries = []
  const gateway = createGateway({
    generateTextWithModel: async () => {
      throw Object.assign(new Error('private transcript and provider response'), {
        code: 'MODEL_LOGIN_REQUIRED',
        condition: 'login-required',
      })
    },
    logger: createLogger(entries),
  })

  await assert.rejects(
    () =>
      gateway.generateText({
        requestId: 'request-failed',
        taskId: 'task-failed',
        modelSnapshot: { modelName: 'moonshotWebFree' },
        messages: [{ role: 'user', content: 'private transcript' }],
        maxOutputTokens: 200,
      }),
    { code: 'MODEL_LOGIN_REQUIRED' },
  )

  const logs = JSON.stringify(entries)
  assert.equal(logs.includes('MODEL_LOGIN_REQUIRED'), true)
  assert.equal(logs.includes('private transcript'), false)
  assert.equal(logs.includes('provider response'), false)
})

test('cancel aborts only the matching in-flight generateText request', async () => {
  const signals = []
  const gateway = createGateway({
    generateTextWithModel: ({ signal }) =>
      new Promise((resolve, reject) => {
        signals.push(signal)
        signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
      }),
  })

  const pending = gateway.generateText({
    requestId: 'request-3',
    taskId: 'task-3',
    modelSnapshot: { modelName: 'moonshotWebFree' },
    messages: [{ role: 'user', content: 'private transcript' }],
    maxOutputTokens: 200,
  })
  await Promise.resolve()

  gateway.cancel({ requestId: 'other-request', taskId: 'task-3' })
  assert.equal(signals[0]?.aborted, false)

  gateway.cancel({ requestId: 'request-3', taskId: 'task-3' })
  await assert.rejects(() => pending, { message: 'request aborted' })
  assert.equal(signals[0]?.aborted, true)
})
