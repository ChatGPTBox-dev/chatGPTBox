import { fetchSSE } from '../../utils/fetch-sse.mjs'
import { getConversationPairs } from '../../utils/get-conversation-pairs.mjs'
import { isEmpty } from 'lodash-es'
import { pushRecord, withAbortController } from './shared.mjs'
import { getTemperatureParams } from './temperature-params.mjs'

function buildHeaders(apiKey, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

export function buildResponsesInput(conversationRecords, question, maxContextLength) {
  const records = Array.isArray(conversationRecords) ? conversationRecords : []
  const hasContextLimit = Number.isFinite(maxContextLength) && maxContextLength >= 0
  const limitedRecords = hasContextLimit
    ? records.slice(Math.max(records.length - maxContextLength, 0))
    : records
  const input = getConversationPairs(limitedRecords, false)
  input.push({ role: 'user', content: question })
  return input
}

function convertResponseFormatToTextFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined
  if (responseFormat.type === 'json_schema') {
    return {
      format: {
        type: 'json_schema',
        name: responseFormat.name || responseFormat.json_schema?.name || 'response',
        strict: (responseFormat.strict ?? responseFormat.json_schema?.strict) !== false,
        schema: responseFormat.schema || responseFormat.json_schema?.schema || {},
      },
    }
  }
  if (responseFormat.type === 'json_object') {
    return { format: { type: 'json_object' } }
  }
  return undefined
}

export function buildResponsesBody({
  model,
  temperatureModel = model,
  input,
  instructions,
  config,
  extraBody = {},
}) {
  const safeExtraBody = { ...extraBody }
  delete safeExtraBody.temperature
  delete safeExtraBody.max_tokens
  delete safeExtraBody.max_completion_tokens
  delete safeExtraBody.messages
  delete safeExtraBody.prompt
  delete safeExtraBody.stream

  const { response_format: responseFormat, ...restExtraBody } = safeExtraBody

  const body = {
    model,
    input,
    stream: true,
    store: false,
    max_output_tokens: config?.maxResponseTokenLength,
    ...getTemperatureParams(config, temperatureModel),
    ...restExtraBody,
  }

  if (instructions) body.instructions = instructions

  if (responseFormat && !body.text) {
    const converted = convertResponseFormatToTextFormat(responseFormat)
    if (converted) body.text = converted
  }

  return body
}

function extractTextFromOutputItemContent(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'output_text') {
      if (typeof part.text === 'string') text += part.text
    } else if (part && typeof part === 'object' && typeof part.refusal === 'string') {
      text += part.refusal
    }
  }
  return text
}

export function extractResponsesOutputText(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text
  if (!Array.isArray(data.output)) return ''
  let text = ''
  for (const item of data.output) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message') {
      text += extractTextFromOutputItemContent(item.content)
    }
  }
  return text
}

function getResponsesErrorMessage(data) {
  const message =
    data?.response?.error?.message ||
    data?.error?.message ||
    data?.message ||
    (typeof data?.error === 'string' ? data.error : '')
  return message || 'Responses API request failed'
}

/**
 * Whether an error from a Responses API request looks like "route not supported"
 * (unknown endpoint, unsupported model/API version) as opposed to a request,
 * auth, or mid-stream failure. A 404 retains the legacy route fallback. Other
 * eligible HTTP statuses require an explicit Responses incompatibility message.
 */
export function isResponsesRouteUnsupportedError(error) {
  if (error?.status === 404) return true
  if (![400, 405, 501].includes(error?.status)) return false
  let message = String(error?.message || '')
  let code
  try {
    // HTTP errors are serialized JSON. Do not classify paths or hints from metadata.
    const body = JSON.parse(message)
    code = body?.error?.code || body?.code
    message =
      typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message || ''
  } catch {
    // Some compatible servers return plain-text errors.
  }
  if (typeof message !== 'string') return false
  const namesResponsesRoute =
    /\/(?:v1|openai)\/responses\b|\bresponses\s+api\b|\bresponses\b.*api-version|api-version.*\bresponses\b/i.test(
      message,
    )
  if (!namesResponsesRoute) return false
  if (code === 'model_not_found') return true
  // Require the failure to describe the endpoint, model, or API version itself,
  // not arbitrary input, parameters, files, or credentials mentioned elsewhere.
  const subject = '(?:api[- ]version|url|endpoint|route|model|responses\\s+api)'
  const value = '(?:\\s+(?:"[^"\\n]+"|\'[^\'\\n]+\'|\\/(?:v1|openai)\\/responses|\\d[\\w.-]*))?'
  const failure = '(?:not found|does not exist|not supported|unsupported|invalid)'
  return (
    /\b(?:unknown|unsupported|invalid)\s+(?:api[- ]version|url|endpoint|route)\b/i.test(message) ||
    new RegExp(`\\b${subject}${value}\\s+(?:(?:is|was)\\s+)?${failure}\\b`, 'i').test(message) ||
    /\bmodel(?:\s+(?:"[^"\n]+"|'[^'\n]+'|[\w.-]+))?\s+does not support\s+(?:the\s+)?(?:responses\s+api|\/(?:v1|openai)\/responses)\b/i.test(
      message,
    ) ||
    /\/(?:v1|openai)\/responses\b["']?\s+(?:is\s+)?(?:not found|does not exist|not supported|unsupported)\b/i.test(
      message,
    )
  )
}

/**
 * Apply one parsed Responses SSE event payload to the accumulated answer.
 * @returns {{ answer: string, done: boolean, failed: boolean, error?: Error }}
 */
export function applyResponsesStreamEvent(answer, data) {
  if (!data || typeof data !== 'object') return { answer, done: false, failed: false }
  const eventType = data.type
  if (
    !isEmpty(data.error) ||
    eventType === 'response.failed' ||
    eventType === 'error' ||
    data.status === 'failed'
  ) {
    return { answer, done: false, failed: true, error: new Error(getResponsesErrorMessage(data)) }
  }
  // A standalone response snapshot must not become a success via the synthetic DONE marker.
  // Streaming lifecycle events can legitimately carry an in-progress response.
  if (!eventType && ['queued', 'in_progress', 'cancelled'].includes(data.status)) {
    return {
      answer,
      done: false,
      failed: true,
      error: new Error(`Responses API returned a non-success status: ${data.status}`),
    }
  }
  if (eventType === 'response.output_text.delta' && typeof data.delta === 'string') {
    return { answer: answer + data.delta, done: false, failed: false }
  }
  if (eventType === 'response.incomplete' || (!eventType && data.status === 'incomplete')) {
    const response = data.response || data
    const fullText = extractResponsesOutputText(response)
    if (!fullText && !answer) {
      const reason = response.incomplete_details?.reason || 'no output text'
      return {
        answer,
        done: false,
        failed: true,
        error: new Error(`Responses API response incomplete: ${reason}`),
      }
    }
    return { answer: fullText || answer, done: true, failed: false }
  }
  if (eventType === 'response.completed') {
    const fullText = extractResponsesOutputText(data.response || data)
    return { answer: fullText || answer, done: true, failed: false }
  }
  if (Array.isArray(data.output) || typeof data.output_text === 'string') {
    const fullText = extractResponsesOutputText(data)
    if (fullText) return { answer: fullText, done: false, failed: false }
  }
  return { answer, done: false, failed: false }
}

/**
 * @param {object} params
 * @param {Browser.Runtime.Port} params.port
 * @param {string} params.question
 * @param {Session} params.session
 * @param {string} params.requestUrl
 * @param {string} params.model
 * @param {string | null} [params.temperatureModel] Canonical model ID, or null for opaque aliases.
 * @param {string} params.apiKey
 * @param {UserConfig} params.config
 * @param {Record<string, any>} [params.extraBody]
 * @param {Record<string, string>} [params.extraHeaders]
 * @param {ReturnType<typeof import('./shared.mjs').setAbortController>} [params.abortContext]
 */
export async function generateAnswersWithOpenAIResponses(params) {
  return withAbortController(
    params.port,
    (abortContext) => generateResponsesRequest({ ...params, abortContext }),
    params.abortContext,
  )
}

async function generateResponsesRequest({
  port,
  question,
  session,
  requestUrl,
  model,
  temperatureModel = model,
  apiKey,
  config,
  extraBody = {},
  extraHeaders = {},
  abortContext,
}) {
  const { controller, getStopGenerationId, isCurrentSessionRequest } = abortContext
  if (controller.signal.aborted) return

  const conversationRecords = Array.isArray(session.conversationRecords)
    ? session.conversationRecords
    : []
  session.conversationRecords = conversationRecords
  const requestBody = buildResponsesBody({
    model,
    temperatureModel,
    input: buildResponsesInput(conversationRecords, question, config?.maxConversationContextLength),
    config,
    extraBody,
  })

  let answer = ''
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (!answer) throw new Error('Responses API completed without output text')
    pushRecord(session, question, answer)
    port.postMessage({ answer: null, done: true, session: session })
  }
  const fail = (error) => {
    if (finished) return
    finished = true
    throw error
  }

  await fetchSSE(requestUrl, {
    bufferJsonResponse: true,
    method: 'POST',
    signal: controller.signal,
    headers: buildHeaders(apiKey, extraHeaders),
    body: JSON.stringify(requestBody),
    onMessage(message) {
      if (finished || controller.signal.aborted) return
      if (message.trim() === '[DONE]') {
        finish()
        return
      }
      let data
      try {
        data = JSON.parse(message)
      } catch (error) {
        fail(error)
        return
      }

      const result = applyResponsesStreamEvent(answer, data)
      if (result.failed) {
        fail(result.error)
        return
      }
      answer = result.answer
      port.postMessage({ answer: answer, done: false, session: null })

      if (result.done) {
        finish()
      }
    },
    async onStart() {},
    async onEnd(aborted = false) {
      if (!finished) {
        if (aborted || controller.signal.aborted) {
          const shouldPostSession = Boolean(answer) || session.isRetry
          if (shouldPostSession && isCurrentSessionRequest()) {
            if (answer) {
              pushRecord(session, question, answer)
            }
            session.isRetry = false
            try {
              const stoppedGenerationId = getStopGenerationId()
              port.postMessage({
                session,
                ...(stoppedGenerationId === undefined ? {} : { stoppedGenerationId }),
              })
            } catch (e) {
              console.warn('[openai-responses-core] Failed to post session on abort:', e)
            }
          }
        } else {
          fail(new Error('Responses API stream ended before completion'))
        }
      }
    },
    async onError(resp) {
      if (resp instanceof Error) throw resp
      let message = await resp.text().catch(() => '')
      try {
        const errorBody = JSON.parse(message)
        message = isEmpty(errorBody) ? '' : JSON.stringify(errorBody)
      } catch {
        // Keep plain-text error details; the body has already been consumed once.
      }
      const error = new Error(message.trim() || `${resp.status} ${resp.statusText}`)
      error.status = resp?.status
      throw error
    },
  })
}
