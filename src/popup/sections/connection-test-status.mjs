const PENDING_COLOR = '#9a6700'
const REACHABLE_COLOR = '#2da44e'
const UNREACHABLE_COLOR = '#d1242f'

/**
 * The Test button doubles as the result display: only its colour changes, so the row
 * layout stays stable and no extra status text is rendered next to it.
 * @param {{pending?: boolean, ok?: boolean} | undefined} test
 * @returns {Record<string, string> | undefined}
 */
export function getConnectionTestButtonStyle(test) {
  if (!test) return undefined
  const color = test.pending ? PENDING_COLOR : test.ok ? REACHABLE_COLOR : UNREACHABLE_COLOR
  return { color, borderColor: color }
}

/**
 * The button label carries the result, so the row needs no separate status element.
 * @param {{pending?: boolean, ok?: boolean, elapsedMs?: number} | undefined} test
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function getConnectionTestLabel(test, t) {
  if (!test) return t('Test')
  if (test.pending) return t('Testing...')
  if (test.ok) return `${t('Reachable')} ${test.elapsedMs}ms`
  return t('Unreachable')
}

/**
 * The result detail stays available as the button's tooltip.
 * @param {{pending?: boolean, ok?: boolean, error?: string, elapsedMs?: number} | undefined} test
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function getConnectionTestTitle(test, t) {
  if (!test) return ''
  if (test.pending) return t('Testing...')
  if (test.ok) return `${t('Reachable')} ${test.elapsedMs}ms`
  return test.error ? `${t('Unreachable')}: ${test.error}` : t('Unreachable')
}
