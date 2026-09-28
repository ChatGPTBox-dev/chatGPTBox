import assert from 'node:assert/strict'
import { test } from 'node:test'

import { invokeOpenAICompatibleTool } from '../../../../src/services/apis/openai-compatible-tool-call.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const createBasicConfig = () => ({
  temperatureOverrideEnabled: true,
  temperature: 0.25,
})

test('invokeOpenAICompatibleTool sends pinned tool request and aggregates streamed tool arguments', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const tool = {
    name: 'submit_chunk_summary',
    description: 'Submit a chunk summary',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        localSummary: { type: 'string' },
      },
      required: ['localSummary'],
    },
  }

  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"ignored","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"submit_chunk_summary","arguments":"{\\"local"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Summary\\":\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])
  })

  const result = await invokeOpenAICompatibleTool({
    requestUrl: 'https://api.example.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Summarize this chunk.' },
    ],
    maxOutputTokens: 128,
    config: createBasicConfig(),
    provider: 'compat',
    extraBody: {
      model: 'wrong',
      messages: [{ role: 'user', content: 'wrong' }],
      stream: false,
      tools: [],
      tool_choice: { type: 'function', function: { name: 'wrong' } },
      parallel_tool_calls: true,
    },
    extraHeaders: { 'X-Test': '1' },
    tool,
  })

  assert.equal(capturedInit.method, 'POST')
  assert.equal(capturedInit.headers.Authorization, 'Bearer sk-test')
  assert.equal(capturedInit.headers['Content-Type'], 'application/json')
  assert.equal(capturedInit.headers['X-Test'], '1')

  const body = JSON.parse(capturedInit.body)
  assert.equal(body.model, 'gpt-4o-mini')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 128)
  assert.equal(body.temperature, 0.25)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Summarize this chunk.' },
  ])
  assert.deepEqual(body.tools, [{ type: 'function', function: tool }])
  assert.deepEqual(body.tool_choice, {
    type: 'function',
    function: { name: tool.name },
  })
  assert.equal(body.parallel_tool_calls, false)

  assert.deepEqual(result, {
    toolName: 'submit_chunk_summary',
    arguments: { localSummary: 'ok' },
    argumentBytes: new TextEncoder().encode('{"localSummary":"ok"}').length,
  })
})

test('invokeOpenAICompatibleTool supports non-stream responses containing choices[0].message.tool_calls', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const tool = {
    name: 'submit_chunk_summary',
    description: 'Submit a chunk summary',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        localSummary: { type: 'string' },
      },
      required: ['localSummary'],
    },
  }

  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'submit_chunk_summary',
                    arguments: '{"localSummary":"ok"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ])
  })

  const result = await invokeOpenAICompatibleTool({
    requestUrl: 'https://api.example.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: 'Summarize this chunk.' }],
    maxOutputTokens: 128,
    config: createBasicConfig(),
    provider: 'compat',
    tool,
  })

  assert.deepEqual(result.arguments, { localSummary: 'ok' })
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_CALL_MISSING when no tool call is produced', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) => err?.code === 'MODEL_TOOL_CALL_MISSING' && err?.message === 'MODEL_TOOL_CALL_MISSING',
  )
})

test('invokeOpenAICompatibleTool attaches safe protocolDiagnostics for MODEL_TOOL_CALL_MISSING (streaming) without leaking content, finish_reason, or arguments', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const secretContent = 'transcript content SECRET_SHOULD_NOT_LEAK'
  const secretArgs = '{"localSummary":"RAW_ARGS_SHOULD_NOT_LEAK"}'
  const secretReasoning = 'REASONING_SECRET_SHOULD_NOT_LEAK'

  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: secretContent,
              reasoning_content: secretReasoning,
              function_call: {
                name: 'submit_chunk_summary',
                arguments: secretArgs,
              },
            },
            finish_reason: 'function_call',
          },
        ],
      })}\n\n`,
      'data: [DONE]\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) => {
      assert.equal(err?.code, 'MODEL_TOOL_CALL_MISSING')
      assert.equal(err?.message, 'MODEL_TOOL_CALL_MISSING')
      assert.deepEqual(err?.protocolDiagnostics, {
        eventCount: 1,
        choiceEventCount: 1,
        finishReasons: ['other'],
        sawContent: true,
        sawReasoningContent: true,
        sawDeltaToolCalls: false,
        sawMessageToolCalls: false,
        sawLegacyFunctionCall: true,
      })
      const serialized = JSON.stringify(err)
      assert.equal(serialized.includes(secretContent), false)
      assert.equal(serialized.includes(secretReasoning), false)
      assert.equal(serialized.includes(secretArgs), false)
      assert.equal(serialized.includes('function_call'), false)
      return true
    },
  )
})

test('invokeOpenAICompatibleTool attaches safe protocolDiagnostics for MODEL_TOOL_CALL_MISSING (common response) without leaking content', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const secretContent = 'COMMON_RESPONSE_SECRET_SHOULD_NOT_LEAK'

  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: secretContent,
              tool_calls: [],
            },
            finish_reason: 'stop',
          },
        ],
      }),
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) => {
      assert.equal(err?.code, 'MODEL_TOOL_CALL_MISSING')
      assert.equal(err?.message, 'MODEL_TOOL_CALL_MISSING')
      assert.deepEqual(err?.protocolDiagnostics, {
        eventCount: 1,
        choiceEventCount: 1,
        finishReasons: ['stop'],
        sawContent: true,
        sawReasoningContent: false,
        sawDeltaToolCalls: false,
        sawMessageToolCalls: true,
        sawLegacyFunctionCall: false,
      })
      assert.equal(JSON.stringify(err).includes(secretContent), false)
      return true
    },
  )
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_CALL_MULTIPLE when multiple tool calls are produced', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"submit_chunk_summary","arguments":"{}"}},{"index":1,"type":"function","function":{"name":"submit_chunk_summary","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) =>
      err?.code === 'MODEL_TOOL_CALL_MULTIPLE' && err?.message === 'MODEL_TOOL_CALL_MULTIPLE',
  )
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_NAME_MISMATCH when tool name differs', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"wrong","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) =>
      err?.code === 'MODEL_TOOL_NAME_MISMATCH' && err?.message === 'MODEL_TOOL_NAME_MISMATCH',
  )
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_ARGUMENTS_INVALID for invalid JSON arguments and does not leak raw arguments', async (t) => {
  t.mock.method(console, 'debug', () => {})
  const rawArgs = 'not-json-raw-arguments'
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: { name: 'submit_chunk_summary', arguments: rawArgs },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n`,
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) =>
      err?.code === 'MODEL_TOOL_ARGUMENTS_INVALID' &&
      err?.message === 'MODEL_TOOL_ARGUMENTS_INVALID' &&
      !String(err?.message || '').includes(rawArgs),
  )
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_SCHEMA_INVALID for unsupported JSON schema', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"submit_chunk_summary","arguments":"{\\"localSummary\\":\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: { type: 'number' },
      },
    }),
    (err) =>
      err?.code === 'MODEL_TOOL_SCHEMA_INVALID' && err?.message === 'MODEL_TOOL_SCHEMA_INVALID',
  )
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_SCHEMA_INVALID when arguments do not satisfy schema (required/type/additionalProperties)', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"submit_chunk_summary","arguments":"{\\"localSummary\\":123,\\"extra\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { localSummary: { type: 'string' } },
          required: ['localSummary'],
        },
      },
    }),
    (err) =>
      err?.code === 'MODEL_TOOL_SCHEMA_INVALID' && err?.message === 'MODEL_TOOL_SCHEMA_INVALID',
  )
})

test('invokeOpenAICompatibleTool throws MODEL_TOOL_ARGUMENTS_TOO_LARGE once arguments exceed maxArgumentsBytes', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"submit_chunk_summary","arguments":"123456"}}]}}]}\n\n',
    ])
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      maxArgumentsBytes: 5,
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
    }),
    (err) =>
      err?.code === 'MODEL_TOOL_ARGUMENTS_TOO_LARGE' &&
      err?.message === 'MODEL_TOOL_ARGUMENTS_TOO_LARGE',
  )
})

test('invokeOpenAICompatibleTool propagates HTTP/provider error responses', async (t) => {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => {
    return createMockSseResponse([], {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'bad request' } }),
    })
  })

  await assert.rejects(
    invokeOpenAICompatibleTool({
      requestUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'Summarize' }],
      maxOutputTokens: 128,
      config: createBasicConfig(),
      provider: 'compat',
      tool: {
        name: 'submit_chunk_summary',
        description: 'x',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
    }),
    (err) => String(err?.message || '').includes('bad request'),
  )
})
