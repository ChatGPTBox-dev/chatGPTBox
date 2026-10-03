export function isAbortError(err) {
  if (!err || typeof err !== 'object') return false
  const name = typeof err.name === 'string' ? err.name : ''
  const isLegacyAbortError =
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.code === DOMException.ABORT_ERR
  return name === 'AbortError' || isLegacyAbortError
}
