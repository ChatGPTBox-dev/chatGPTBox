import { getUserConfig } from '../../config/index.mjs'
import { getModelValue } from '../../utils/model-name-convert.mjs'
import { shouldDisableDefaultThinking } from './claude-api.mjs'
import { canTestConnectionSession } from './connection-test-groups.mjs'
import { getExtraBodyParams } from './extra-body-params.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'
import {
  hasNativeOllamaChatApiPath,
  resolveModelName,
  resolveProviderRequestShapingId,
} from './openai-api.mjs'
import { resolveOpenAICompatibleRequest } from './provider-registry.mjs'

const TEST_TIMEOUT_MS = 20000
const TEST_MAX_TOKENS = 1
const TEST_PROMPT = 'ping'
const TEST_MESSAGES = [{ role: 'user', content: TEST_PROMPT }]
const AZURE_API_VERSION = '2024-02-01'
const ANTHROPIC_API_VERSION = '2023-06-01'

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '')
}

/**
 * Mirror the request the live OpenAI-compatible path builds: same resolved URL, same
 * token parameter for the resolved provider, and the same extra request body. Only the
 * payload size and `stream` differ, so a mode that passes here can be talked to.
 * @returns {{requestUrl: string, headers: Record<string, string>, body: object} | null}
 */
function buildOpenAICompatibleTestRequest(config, session) {
  const request = resolveOpenAICompatibleRequest(config, session)
  if (!request) return null

  const model = resolveModelName(session, config)
  // Token parameters are shaped by the resolved provider rather than the raw id, so a
  // custom provider inheriting OpenAI still gets max_completion_tokens where required.
  const tokenParams =
    request.endpointType === 'completion'
      ? { max_tokens: TEST_MAX_TOKENS }
      : getChatCompletionsTokenParams(
          resolveProviderRequestShapingId(request),
          model,
          TEST_MAX_TOKENS,
        )
  const baseBody =
    request.endpointType === 'completion'
      ? { model, prompt: TEST_PROMPT, ...tokenParams }
      : { model, messages: TEST_MESSAGES, ...tokenParams }

  return {
    requestUrl: request.requestUrl,
    headers: {
      'Content-Type': 'application/json',
      ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: { ...baseBody, ...getExtraBodyParams(config), stream: false },
  }
}

function buildAzureTestRequest(config, session) {
  const endpoint = trimTrailingSlashes(config.azureEndpoint)
  const deploymentName = getModelValue(session) || config.azureDeploymentName
  if (!endpoint || !deploymentName) return null

  return {
    requestUrl: `${endpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=${AZURE_API_VERSION}`,
    headers: {
      'Content-Type': 'application/json',
      'api-key': config.azureApiKey || '',
    },
    body: {
      messages: TEST_MESSAGES,
      max_tokens: TEST_MAX_TOKENS,
      ...getExtraBodyParams(config),
      stream: false,
    },
  }
}

/**
 * Anthropic rejects a `max_tokens` that does not exceed an enabled thinking budget, so a
 * user-configured thinking budget has to be covered by the probe's token limit.
 */
function resolveAnthropicTestMaxTokens(extraBody) {
  const thinking = extraBody?.thinking
  if (thinking?.type === 'enabled' && Number.isFinite(thinking.budget_tokens)) {
    return Math.max(TEST_MAX_TOKENS, thinking.budget_tokens + 1)
  }
  return TEST_MAX_TOKENS
}

function buildAnthropicTestRequest(config, session) {
  const baseUrl = trimTrailingSlashes(config.customAnthropicApiUrl)
  const model = getModelValue(session)
  if (!baseUrl || !model) return null

  const extraBody = getExtraBodyParams(config)
  const body = {
    model,
    messages: TEST_MESSAGES,
    max_tokens: resolveAnthropicTestMaxTokens(extraBody),
  }
  if (shouldDisableDefaultThinking(model)) body.thinking = { type: 'disabled' }

  return {
    requestUrl: `${baseUrl}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
      'x-api-key': config.anthropicApiKey || '',
      'anthropic-dangerous-direct-browser-access': true,
    },
    body: { ...body, ...extraBody, stream: false },
  }
}

async function sendTestRequest({ requestUrl, headers, body }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      signal: controller.signal,
      // A redirect would send the credentials somewhere else and answer for the wrong
      // endpoint, so the probe reports it instead of following it.
      redirect: 'manual',
      headers,
      body: JSON.stringify(body),
    })
    const elapsedMs = Date.now() - startedAt
    if (response.type === 'opaqueredirect') {
      return {
        ok: false,
        elapsedMs,
        error: 'The endpoint redirected the request instead of answering it.',
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { ok: false, status: response.status, elapsedMs, error: detail.slice(0, 300) }
    }
    return { ok: true, status: response.status, elapsedMs }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error?.name === 'AbortError' ? 'timeout' : error?.message ?? String(error),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Send the smallest request that still proves the endpoint, key and model work together.
 * Each provider family is probed through the same request shape its live path uses, so a
 * session that passes here is one that can be talked to.
 * @param {object} session a session-shaped selector: `{apiMode}` for a configured mode,
 *   `{modelName: 'customModel'}` for the custom model on the General tab
 * @returns {Promise<{ok: boolean, status?: number, elapsedMs: number, error?: string}>}
 */
export async function testConnection(session) {
  if (!canTestConnectionSession(session)) {
    return { ok: false, elapsedMs: 0, error: 'unsupported-provider' }
  }

  const config = await getUserConfig()
  const groupName = session?.apiMode?.groupName
  const request =
    groupName === 'azureOpenAiApiModelKeys'
      ? buildAzureTestRequest(config, session)
      : groupName === 'claudeApiModelKeys'
      ? buildAnthropicTestRequest(config, session)
      : buildOpenAICompatibleTestRequest(config, session)

  if (!request) return { ok: false, elapsedMs: 0, error: 'unresolved-provider' }
  // The live path refuses Ollama's native chat endpoint, so a probe against it would
  // report a mode as reachable that can never hold a conversation.
  if (hasNativeOllamaChatApiPath(request.requestUrl)) {
    return { ok: false, elapsedMs: 0, error: 'unsupported-provider' }
  }
  return sendTestRequest(request)
}
