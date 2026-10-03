/**
 * Parse the user-provided extra request body.
 * @param {unknown} raw JSON text from the advanced settings textarea
 * @returns {Record<string, unknown> | null} the parsed object, or null when unusable
 */
export function parseExtraBody(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

/**
 * Keys every request builder owns. A custom body may add parameters the UI does
 * not expose, but replacing these would desync the request from the conversation,
 * model and settings the user picked, and `stream` must stay on for SSE parsing.
 */
const RESERVED_KEYS = ['stream', 'model', 'messages', 'prompt', 'temperature']

/**
 * Extra fields merged into the API request body.
 * @param {UserConfig} config
 * @returns {Record<string, unknown>}
 */
export function getExtraBodyParams(config) {
  const extraBody = parseExtraBody(config?.extraBody)
  if (!extraBody) return {}
  for (const key of RESERVED_KEYS) delete extraBody[key]
  return extraBody
}
