const PENDING_COLOR = '#9a6700'
const REACHABLE_COLOR = '#2da44e'
const UNREACHABLE_COLOR = '#d1242f'
// A mode with no request shape to send is neither up nor down, so it stays neutral.
const UNSUPPORTED_COLOR = '#57606a'

function getConnectionTestColor(test) {
  if (test.pending) return PENDING_COLOR
  if (test.unsupported) return UNSUPPORTED_COLOR
  return test.ok ? REACHABLE_COLOR : UNREACHABLE_COLOR
}

/**
 * The Test button doubles as the result display: only its colour changes, so the row
 * layout stays stable and no extra status text is rendered next to it.
 * @param {{pending?: boolean, ok?: boolean, unsupported?: boolean} | undefined} test
 * @returns {Record<string, string> | undefined}
 */
export function getConnectionTestButtonStyle(test) {
  if (!test) return undefined
  const color = getConnectionTestColor(test)
  return { color, borderColor: color }
}

/**
 * The button label carries the result, so the row needs no separate status element.
 * @param {{pending?: boolean, ok?: boolean, unsupported?: boolean, elapsedMs?: number}
 *   | undefined} test
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function getConnectionTestLabel(test, t) {
  if (!test) return t('Test')
  if (test.pending) return t('Testing...')
  if (test.unsupported) return t('Not testable')
  if (test.ok) return `${t('Reachable')} ${test.elapsedMs}ms`
  return t('Unreachable')
}

/**
 * The result detail stays available as the button's tooltip.
 * @param {{pending?: boolean, ok?: boolean, unsupported?: boolean, error?: string,
 *   elapsedMs?: number} | undefined} test
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function getConnectionTestTitle(test, t) {
  if (!test) return ''
  if (test.pending) return t('Testing...')
  if (test.unsupported) return t('Not testable')
  if (test.ok) return `${t('Reachable')} ${test.elapsedMs}ms`
  return test.error ? `${t('Unreachable')}: ${test.error}` : t('Unreachable')
}
