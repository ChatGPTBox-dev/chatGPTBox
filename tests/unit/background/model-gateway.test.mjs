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

test('describeCapabilities supports API modes and rejects web-only models', async () => {
  const gateway = createModelGateway({
    getUserConfig: async () => ({ maxResponseTokenLength: 3000 }),
    resolveOpenAICompatibleRequest: (_config, modelSnapshot) =>
      modelSnapshot?.modelName === 'chatgptFree35'
        ? null
        : { requestUrl: 'https://api.openai.com/v1/chat/completions' },
    generateAnswersWithOpenAICompatible: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  })

  assert.deepEqual(
    await gateway.describeCapabilities({
      apiMode: { groupName: 'customApiModelKeys', providerId: 'openai' },
    }),
    {
      supported: true,
      reason: null,
      inputTokenBudget: 4000,
      maxOutputTokens: 20_000,
    },
  )

  assert.deepEqual(await gateway.describeCapabilities({ modelName: 'chatgptFree35' }), {
    supported: false,
    reason: 'MODEL_GATEWAY_UNSUPPORTED',
    inputTokenBudget: 4000,
    maxOutputTokens: 20_000,
  })
})

test('describeCapabilities accepts a legacy customModel resolved by the configured API endpoint', async () => {
  const config = {
    customModelName: 'doubao-pro-32k',
    customModelApiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    customModelApiKey: 'test-key',
  }
  const gateway = createModelGateway({
    getUserConfig: async () => config,
    resolveOpenAICompatibleRequest(resolvedConfig, modelSnapshot) {
      assert.equal(resolvedConfig, config)
      assert.deepEqual(modelSnapshot, { modelName: 'customModel', apiMode: null })
      return { requestUrl: config.customModelApiUrl }
    },
    generateAnswersWithOpenAICompatible: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  })

  assert.deepEqual(
    await gateway.describeCapabilities({ modelName: 'customModel', apiMode: null }),
    {
      supported: true,
      reason: null,
      inputTokenBudget: 4000,
      maxOutputTokens: 20_000,
    },
  )
})

test('invokeTool calls invokeOpenAICompatibleTool with resolved endpoint/model and returns parsed tool arguments', async () => {
  const entries = []
  let capturedArgs
  const gateway = createModelGateway({
    getUserConfig: async () => ({
      maxConversationContextLength: 8,
      maxResponseTokenLength: 3000,
      temperatureOverrideEnabled: false,
      temperature: 1,
    }),
    resolveOpenAICompatibleRequest: () => ({
      requestUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test',
      providerId: 'openai',
      extraBody: { custom: true },
      extraHeaders: { 'X-Test': '1' },
    }),
    invokeOpenAICompatibleTool: async (args) => {
      capturedArgs = args
      return {
        toolName: args.tool?.name,
        arguments: { summary: 'final answer', bullets: ['a', 'b'] },
        argumentBytes: 37,
      }
    },
    logger: createLogger(entries),
  })

  const modelSnapshot = Object.freeze({
    modelName: 'customModel',
    apiMode: Object.freeze({
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'gpt-4.1-mini',
    }),
  })
  const messages = Object.freeze([
    Object.freeze({ role: 'system', content: 'Summarize in concise bullets.' }),
    Object.freeze({ role: 'user', content: 'transcript content' }),
  ])
  const tool = Object.freeze({
    name: 'video_summary',
    description: 'Return the requested video summary.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        summary: Object.freeze({ type: 'string' }),
        bullets: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
      }),
      required: Object.freeze(['summary', 'bullets']),
    }),
  })

  const result = await gateway.invokeTool({
    requestId: 'request-1',
    taskId: 'task-1',
    modelSnapshot,
    messages,
    maxOutputTokens: 321,
    tool,
  })

  assert.deepEqual(result, {
    toolName: 'video_summary',
    arguments: { summary: 'final answer', bullets: ['a', 'b'] },
    argumentBytes: 37,
  })
  assert.equal(capturedArgs.model, 'gpt-4.1-mini')
  assert.equal(capturedArgs.provider, 'openai')
  assert.equal(capturedArgs.requestUrl, 'https://api.openai.com/v1/chat/completions')
  assert.equal(capturedArgs.apiKey, 'sk-test')
  assert.deepEqual(capturedArgs.messages, [
    { role: 'system', content: 'Summarize in concise bullets.' },
    { role: 'user', content: 'transcript content' },
  ])
  assert.deepEqual(capturedArgs.extraBody, { custom: true })
  assert.deepEqual(capturedArgs.extraHeaders, { 'X-Test': '1' })
  assert.equal(capturedArgs.maxOutputTokens, 321)
  assert.equal(capturedArgs.config.maxResponseTokenLength, 321)
  assert.equal(capturedArgs.config.maxConversationContextLength, 8)
  assert.equal(typeof capturedArgs.signal?.aborted, 'boolean')
  assert.deepEqual(capturedArgs.tool, tool)
  assert.deepEqual(modelSnapshot, {
    modelName: 'customModel',
    apiMode: {
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'gpt-4.1-mini',
    },
  })
  assert.equal(JSON.stringify(entries).includes('transcript content'), false)
  assert.equal(JSON.stringify(entries).includes('final answer'), false)
  assert.equal(JSON.stringify(entries).includes('"messages"'), false)
  assert.equal(JSON.stringify(entries).includes('"parameters"'), false)
  assert.equal(JSON.stringify(entries).includes('"arguments"'), false)
  assert.equal(JSON.stringify(entries).includes('bullets'), false)
})

test('invokeTool logs a safe errorCode for known and unknown failures without leaking payloads', async () => {
  const entries = []
  const baseGateway = {
    getUserConfig: async () => ({
      maxConversationContextLength: 8,
      maxResponseTokenLength: 3000,
      temperatureOverrideEnabled: false,
      temperature: 1,
      customModelApiKey: 'sk-should-not-leak',
    }),
    resolveOpenAICompatibleRequest: () => ({
      requestUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-should-not-leak',
      providerId: 'openai',
      extraBody: { custom: true },
      extraHeaders: { Authorization: 'Bearer sk-should-not-leak' },
    }),
    logger: createLogger(entries),
  }

  const modelSnapshot = Object.freeze({
    apiMode: Object.freeze({
      groupName: 'customApiModelKeys',
      providerId: 'openai',
      customName: 'gpt-4.1-mini',
    }),
  })
  const messages = Object.freeze([
    Object.freeze({ role: 'system', content: 'Do not leak this transcript content.' }),
    Object.freeze({ role: 'user', content: 'transcript content' }),
  ])
  const tool = Object.freeze({
    name: 'video_summary',
    description: 'Return the requested video summary.',
    parameters: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        summary: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['summary']),
    }),
  })

  const knownError = Object.assign(new Error('MODEL_TOOL_CALL_MISSING'), {
    code: 'MODEL_TOOL_CALL_MISSING',
    protocolDiagnostics: {
      eventCount: 3,
      choiceEventCount: 2,
      finishReasons: ['stop', 'function_call', 'other'],
      sawContent: true,
      sawReasoningContent: true,
      sawDeltaToolCalls: false,
      sawMessageToolCalls: true,
      sawLegacyFunctionCall: true,
      rawText: 'transcript content should not leak',
      arguments: '{"secret":"should not leak"}',
    },
    arguments: '{"secret":"should not leak"}',
  })
  const knownGateway = createModelGateway({
    ...baseGateway,
    invokeOpenAICompatibleTool: async () => {
      throw knownError
    },
    generateAnswersWithOpenAICompatible: async () => {},
  })

  await assert.rejects(
    () =>
      knownGateway.invokeTool({
        requestId: 'request-known',
        taskId: 'task-known',
        modelSnapshot,
        messages,
        maxOutputTokens: 200,
        tool,
      }),
    { message: 'MODEL_TOOL_CALL_MISSING' },
  )

  const knownFailureLog = entries.find(
    ([level, entry]) =>
      level === 'warn' && entry?.event === 'video-summary-model-gateway.invokeTool.failed',
  )?.[1]
  assert.equal(knownFailureLog?.errorCode, 'MODEL_TOOL_CALL_MISSING')
  assert.deepEqual(knownFailureLog?.protocolDiagnostics, {
    eventCount: 3,
    choiceEventCount: 2,
    finishReasons: ['stop', 'other'],
    sawContent: true,
    sawReasoningContent: true,
    sawDeltaToolCalls: false,
    sawMessageToolCalls: true,
    sawLegacyFunctionCall: true,
  })

  // Unknown failures must map to a stable redacted code.
  const unknownError = new Error(
    'boom: transcript content sk-should-not-leak {"arguments":{"a":1}}',
  )
  const unknownGateway = createModelGateway({
    ...baseGateway,
    invokeOpenAICompatibleTool: async () => {
      throw unknownError
    },
    generateAnswersWithOpenAICompatible: async () => {},
  })

  await assert.rejects(
    () =>
      unknownGateway.invokeTool({
        requestId: 'request-unknown',
        taskId: 'task-unknown',
        modelSnapshot,
        messages,
        maxOutputTokens: 200,
        tool,
      }),
    { message: unknownError.message },
  )

  const unknownFailureLog = entries
    .filter(
      ([level, entry]) =>
        level === 'warn' && entry?.event === 'video-summary-model-gateway.invokeTool.failed',
    )
    .at(-1)?.[1]
  assert.equal(unknownFailureLog?.errorCode, 'MODEL_GATEWAY_TOOL_CALL_FAILED')

  const serializedLogs = JSON.stringify(entries)
  assert.equal(serializedLogs.includes('transcript content'), false)
  assert.equal(serializedLogs.includes('sk-should-not-leak'), false)
  assert.equal(serializedLogs.includes('"messages"'), false)
  assert.equal(serializedLogs.includes('"parameters"'), false)
  assert.equal(serializedLogs.includes('"arguments"'), false)
  assert.equal(serializedLogs.includes('function_call'), false)
})

test('invokeTool accepts a legacy customModel resolved by the configured API endpoint', async () => {
  let capturedModel = null
  const gateway = createModelGateway({
    getUserConfig: async () => ({ customModelName: 'doubao-pro-32k' }),
    resolveOpenAICompatibleRequest: () => ({
      requestUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      apiKey: 'test-key',
      providerId: 'legacy-custom-default',
    }),
    invokeOpenAICompatibleTool: async ({ model }) => {
      capturedModel = model
      return { toolName: 'video_summary', arguments: { summary: 'summary' }, argumentBytes: 19 }
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const result = await gateway.invokeTool({
    requestId: 'request-legacy-custom',
    taskId: 'task-legacy-custom',
    modelSnapshot: { modelName: 'customModel', apiMode: null },
    messages: [{ role: 'user', content: 'transcript content' }],
    maxOutputTokens: 200,
    tool: { name: 'video_summary', description: 'Return a summary.', parameters: {} },
  })

  assert.deepEqual(result, {
    toolName: 'video_summary',
    arguments: { summary: 'summary' },
    argumentBytes: 19,
  })
  assert.equal(capturedModel, 'doubao-pro-32k')
})

test('invokeTool rejects unsupported model identities before calling the OpenAI-compatible tool invoker', async () => {
  let callCount = 0
  const gateway = createModelGateway({
    getUserConfig: async () => ({
      maxConversationContextLength: 8,
      maxResponseTokenLength: 3000,
      temperatureOverrideEnabled: false,
      temperature: 1,
    }),
    resolveOpenAICompatibleRequest: () => null,
    invokeOpenAICompatibleTool: async () => {
      callCount += 1
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  await assert.rejects(
    () =>
      gateway.invokeTool({
        requestId: 'request-2',
        taskId: 'task-2',
        modelSnapshot: { modelName: 'chatgptFree35' },
        messages: [{ role: 'user', content: 'transcript content' }],
        maxOutputTokens: 200,
        tool: { name: 'video_summary', description: 'Return a summary.', parameters: {} },
      }),
    { message: 'MODEL_GATEWAY_UNSUPPORTED' },
  )
  assert.equal(callCount, 0)
})

test('cancel aborts only the matching in-flight invokeTool request', async () => {
  const abortedSignals = []
  const settled = []
  const gateway = createModelGateway({
    getUserConfig: async () => ({
      maxConversationContextLength: 8,
      maxResponseTokenLength: 3000,
      temperatureOverrideEnabled: false,
      temperature: 1,
    }),
    resolveOpenAICompatibleRequest: () => ({
      requestUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test',
      providerId: 'openai',
    }),
    invokeOpenAICompatibleTool: ({ signal }) =>
      new Promise((resolve, reject) => {
        abortedSignals.push(signal)
        if (signal.aborted) {
          reject(new Error('aborted before start'))
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            settled.push('aborted')
            reject(new Error('request aborted'))
          },
          { once: true },
        )
      }),
    logger: { info() {}, warn() {}, error() {} },
  })

  const pending = gateway.invokeTool({
    requestId: 'request-3',
    taskId: 'task-3',
    modelSnapshot: {
      apiMode: { groupName: 'customApiModelKeys', providerId: 'openai', customName: 'gpt-4o-mini' },
    },
    messages: [{ role: 'user', content: 'transcript content' }],
    maxOutputTokens: 200,
    tool: { name: 'video_summary', description: 'Return a summary.', parameters: {} },
  })
  await Promise.resolve()

  gateway.cancel({ requestId: 'other-request', taskId: 'task-3' })
  assert.equal(abortedSignals[0]?.aborted, false)

  gateway.cancel({ requestId: 'request-3', taskId: 'task-3' })
  await assert.rejects(() => pending, { message: 'request aborted' })
  assert.deepEqual(settled, ['aborted'])
})
