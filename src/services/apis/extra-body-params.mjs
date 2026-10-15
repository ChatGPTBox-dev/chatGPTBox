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
 * Extra fields merged into the API request body.
 * @param {UserConfig} config
 * @returns {Record<string, unknown>}
 */
export function getExtraBodyParams(config) {
  const extraBody = parseExtraBody(config?.extraBody)
  if (!extraBody) return {}
  // Every API request is read as an SSE stream, so this key stays under extension control.
  delete extraBody.stream
  return extraBody
}
