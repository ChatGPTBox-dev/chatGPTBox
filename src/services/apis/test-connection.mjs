import { getUserConfig } from '../../config/index.mjs'
import { resolveModelName } from './openai-api.mjs'
import { getChatCompletionsTokenParams } from './openai-token-params.mjs'
import { resolveOpenAICompatibleRequest } from './provider-registry.mjs'

const TEST_TIMEOUT_MS = 20000
const TEST_MAX_TOKENS = 1

/**
 * Send the smallest chat request that still proves the endpoint, key and model work
 * together. Resolution goes through the same helper the real request path uses, so a mode
 * that passes here is a mode that can be talked to.
 * @param {object} apiMode an API mode as stored in the config
 * @returns {Promise<{ok: boolean, status?: number, elapsedMs: number, error?: string}>}
 */
export async function testApiModeConnection(apiMode) {
  const config = await getUserConfig()
  const session = { apiMode }
  const request = resolveOpenAICompatibleRequest(config, session)
  if (!request) return { ok: false, elapsedMs: 0, error: 'unresolved-provider' }

  const model = resolveModelName(session, config)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const response = await fetch(request.requestUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        ...getChatCompletionsTokenParams(request.providerId ?? '', model, TEST_MAX_TOKENS),
        stream: false,
      }),
    })
    const elapsedMs = Date.now() - startedAt
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
