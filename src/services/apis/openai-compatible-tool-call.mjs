import { isEmpty } from 'lodash-es'

import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'
import { getTemperatureParams } from './temperature-params.mjs'

export const MODEL_TOOL_CALL_MISSING = 'MODEL_TOOL_CALL_MISSING'
export const MODEL_TOOL_CALL_MULTIPLE = 'MODEL_TOOL_CALL_MULTIPLE'
export const MODEL_TOOL_NAME_MISMATCH = 'MODEL_TOOL_NAME_MISMATCH'
export const MODEL_TOOL_ARGUMENTS_INVALID = 'MODEL_TOOL_ARGUMENTS_INVALID'
export const MODEL_TOOL_SCHEMA_INVALID = 'MODEL_TOOL_SCHEMA_INVALID'
export const MODEL_TOOL_ARGUMENTS_TOO_LARGE = 'MODEL_TOOL_ARGUMENTS_TOO_LARGE'

const RESERVED_EXTRA_BODY_KEYS = new Set([
  'messages',
  'model',
  'stream',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
])

const SAFE_FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'other']
const SAFE_FINISH_REASON_SET = new Set(SAFE_FINISH_REASONS)

function createStableError(code) {
  const err = new Error(code)
  err.code = code
  return err
}

function buildHeaders(apiKey, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getSafeExtraBody(extraBody) {
  const safeExtraBody = { ...(extraBody || {}) }
  for (const key of RESERVED_EXTRA_BODY_KEYS) {
    delete safeExtraBody[key]
  }
  return safeExtraBody
}

function isUnsupportedSchemaKey(key) {
  return !['type', 'required', 'properties', 'items', 'additionalProperties'].includes(key)
}

function assertSupportedJsonSchema(schema) {
  if (!isPlainObject(schema)) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)

  for (const key of Object.keys(schema)) {
    if (isUnsupportedSchemaKey(key)) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
  }

  const { type, required, properties, items, additionalProperties } = schema
  if (!['object', 'array', 'string'].includes(type))
    throw createStableError(MODEL_TOOL_SCHEMA_INVALID)

  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((k) => typeof k !== 'string')) {
      throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    }
  }

  if (type === 'object') {
    if (additionalProperties !== false) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    if (items !== undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    if (properties !== undefined) {
      if (!isPlainObject(properties)) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
      for (const value of Object.values(properties)) {
        assertSupportedJsonSchema(value)
      }
    }

    if (Array.isArray(required)) {
      if (!isPlainObject(properties) && required.length > 0) {
        throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
      }
      if (isPlainObject(properties)) {
        for (const name of required) {
          if (!(name in properties)) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
        }
      }
    }
  }

  if (type === 'array') {
    if (properties !== undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    if (required !== undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    if (items === undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    assertSupportedJsonSchema(items)
  }

  if (type === 'string') {
    if (properties !== undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    if (required !== undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
    if (items !== undefined) throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
  }
}

function validateValueAgainstSchema(value, schema) {
  if (schema.type === 'string') return typeof value === 'string'

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false
    return value.every((item) => validateValueAgainstSchema(item, schema.items))
  }

  if (schema.type === 'object') {
    if (!isPlainObject(value)) return false

    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!(name in value)) return false
      }
    }

    if (isPlainObject(schema.properties)) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in value && !validateValueAgainstSchema(value[key], propertySchema)) return false
      }
    }

    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(
        isPlainObject(schema.properties) ? Object.keys(schema.properties) : [],
      )
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) return false
      }
    }

    return true
  }

  return false
}

function extractToolCallsFromEvent(data) {
  const choice = data?.choices?.[0]
  const deltaCalls = choice?.delta?.tool_calls
  const messageCalls = choice?.message?.tool_calls
  if (Array.isArray(deltaCalls) && Array.isArray(messageCalls))
    return [...deltaCalls, ...messageCalls]
  if (Array.isArray(deltaCalls)) return deltaCalls
  if (Array.isArray(messageCalls)) return messageCalls
  return []
}

function normalizeIndex(index) {
  const num = typeof index === 'number' ? index : Number(index)
  return Number.isInteger(num) && num >= 0 ? num : null
}

function normalizeFinishReason(value) {
  if (typeof value !== 'string' || !value) return null
  return SAFE_FINISH_REASON_SET.has(value) ? value : 'other'
}

function createProtocolDiagnosticsTracker() {
  return {
    eventCount: 0,
    choiceEventCount: 0,
    finishReasons: new Set(),
    sawContent: false,
    sawReasoningContent: false,
    sawDeltaToolCalls: false,
    sawMessageToolCalls: false,
    sawLegacyFunctionCall: false,
  }
}

function trackProtocolDiagnostics(tracker, data) {
  if (!tracker || typeof tracker !== 'object') return

  const choices = data?.choices
  if (!Array.isArray(choices) || choices.length === 0) return

  tracker.choiceEventCount += 1
  const choice = choices[0]

  const finishReason = normalizeFinishReason(choice?.finish_reason)
  if (finishReason) tracker.finishReasons.add(finishReason)

  const delta = choice?.delta
  const message = choice?.message

  if (typeof delta?.content === 'string' && delta.content) tracker.sawContent = true
  if (typeof message?.content === 'string' && message.content) tracker.sawContent = true

  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
    tracker.sawReasoningContent = true
  }
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
    tracker.sawReasoningContent = true
  }

  if (Array.isArray(delta?.tool_calls)) tracker.sawDeltaToolCalls = true
  if (Array.isArray(message?.tool_calls)) tracker.sawMessageToolCalls = true

  if (isPlainObject(delta?.function_call)) tracker.sawLegacyFunctionCall = true
  if (isPlainObject(message?.function_call)) tracker.sawLegacyFunctionCall = true
}

function finalizeProtocolDiagnostics(tracker) {
  const safe = {
    eventCount:
      Number.isInteger(tracker?.eventCount) && tracker.eventCount >= 0 ? tracker.eventCount : 0,
    choiceEventCount:
      Number.isInteger(tracker?.choiceEventCount) && tracker.choiceEventCount >= 0
        ? tracker.choiceEventCount
        : 0,
    finishReasons: [],
    sawContent: tracker?.sawContent === true,
    sawReasoningContent: tracker?.sawReasoningContent === true,
    sawDeltaToolCalls: tracker?.sawDeltaToolCalls === true,
    sawMessageToolCalls: tracker?.sawMessageToolCalls === true,
    sawLegacyFunctionCall: tracker?.sawLegacyFunctionCall === true,
  }

  const reasons = tracker?.finishReasons instanceof Set ? tracker.finishReasons : new Set()
  for (const reason of SAFE_FINISH_REASONS) {
    if (reasons.has(reason)) safe.finishReasons.push(reason)
  }

  return safe
}

/**
 * @param {object} params
 * @param {string} params.requestUrl
 * @param {string} params.model
 * @param {string} [params.apiKey]
 * @param {Array<{role: string, content: any}>} params.messages
 * @param {number} params.maxOutputTokens
 * @param {UserConfig} params.config
 * @param {string} [params.provider]
 * @param {Record<string, any>} [params.extraBody]
 * @param {Record<string, string>} [params.extraHeaders]
 * @param {{name: string, description?: string, parameters: any}} params.tool
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.maxArgumentsBytes]
 * @returns {Promise<{ toolName: string, arguments: object, argumentBytes: number }>}
 */
export async function invokeOpenAICompatibleTool({
  requestUrl,
  model,
  apiKey,
  messages,
  maxOutputTokens,
  config,
  provider = 'compat',
  extraBody = {},
  extraHeaders = {},
  tool,
  signal,
  maxArgumentsBytes = 262_144,
}) {
  const safeExtraBody = getSafeExtraBody(extraBody)

  const protocolDiagnosticsTracker = createProtocolDiagnosticsTracker()

  const requestBody = {
    ...safeExtraBody,
    messages: (Array.isArray(messages) ? messages : []).map(({ role, content }) => ({
      role,
      content,
    })),
    model,
    stream: true,
    ...getChatCompletionsTokenParams(provider, model, maxOutputTokens),
    ...getTemperatureParams(config, model),
    tools: [{ type: 'function', function: structuredClone(tool) }],
    tool_choice: { type: 'function', function: { name: tool?.name } },
    parallel_tool_calls: false,
  }

  const encoder = new TextEncoder()

  const toolCallsByIndex = new Map()
  const appendToolCallFragment = (toolCall) => {
    const idx = normalizeIndex(toolCall?.index)
    if (idx === null) return

    let entry = toolCallsByIndex.get(idx)
    if (!entry) {
      entry = { name: undefined, argumentsText: '', argumentBytes: 0 }
      toolCallsByIndex.set(idx, entry)
    }

    const name = toolCall?.function?.name
    if (typeof name === 'string' && name && entry.name === undefined) {
      entry.name = name
    }

    const fragment = toolCall?.function?.arguments
    if (typeof fragment === 'string' && fragment) {
      entry.argumentsText += fragment
      entry.argumentBytes += encoder.encode(fragment).length
      if (entry.argumentBytes > maxArgumentsBytes) {
        throw createStableError(MODEL_TOOL_ARGUMENTS_TOO_LARGE)
      }
    }
  }

  const errorFromResponse = async (resp) => {
    if (resp instanceof Error) throw resp
    const error = await resp.json().catch(() => ({}))
    throw new Error(!isEmpty(error) ? JSON.stringify(error) : `${resp.status} ${resp.statusText}`)
  }

  return new Promise((resolve, reject) => {
    fetchSSE(requestUrl, {
      method: 'POST',
      signal,
      headers: buildHeaders(apiKey, extraHeaders),
      body: JSON.stringify(requestBody),
      onMessage(message) {
        if (message.trim() === '[DONE]') return

        let data
        try {
          data = JSON.parse(message)
        } catch {
          return
        }

        protocolDiagnosticsTracker.eventCount += 1
        trackProtocolDiagnostics(protocolDiagnosticsTracker, data)

        for (const toolCall of extractToolCallsFromEvent(data)) {
          appendToolCallFragment(toolCall)
        }
      },
      async onStart() {},
      async onEnd() {
        try {
          if (toolCallsByIndex.size === 0) {
            const err = createStableError(MODEL_TOOL_CALL_MISSING)
            err.protocolDiagnostics = finalizeProtocolDiagnostics(protocolDiagnosticsTracker)
            throw err
          }
          if (toolCallsByIndex.size !== 1) throw createStableError(MODEL_TOOL_CALL_MULTIPLE)

          const [{ name: toolName, argumentsText, argumentBytes }] = toolCallsByIndex.values()
          if (toolName !== tool?.name) throw createStableError(MODEL_TOOL_NAME_MISMATCH)

          let parsedArguments
          try {
            parsedArguments = JSON.parse(argumentsText)
          } catch {
            throw createStableError(MODEL_TOOL_ARGUMENTS_INVALID)
          }

          if (!isPlainObject(parsedArguments)) throw createStableError(MODEL_TOOL_ARGUMENTS_INVALID)

          assertSupportedJsonSchema(tool?.parameters)
          if (!validateValueAgainstSchema(parsedArguments, tool.parameters)) {
            throw createStableError(MODEL_TOOL_SCHEMA_INVALID)
          }

          resolve({ toolName, arguments: parsedArguments, argumentBytes })
        } catch (err) {
          reject(err)
        }
      },
      async onError(resp) {
        try {
          await errorFromResponse(resp)
        } catch (err) {
          reject(err)
        }
      },
    }).catch(reject)
  })
}
