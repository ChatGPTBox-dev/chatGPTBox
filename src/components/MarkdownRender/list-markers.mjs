/**
 * HyperMarkdown tags a list that begins at 1 with `start="0"` while it streams. Browsers
 * honour that literally and number the list from zero, so the attribute has to go before
 * the native markers are drawn. Lists that genuinely resume at another number keep theirs.
 * @param {ParentNode | null | undefined} container
 * @returns {number} how many lists were corrected
 */
export function normalizeListStarts(container) {
  const lists = container?.querySelectorAll?.('ol[start="0"]')
  if (!lists) return 0
  for (const list of lists) list.removeAttribute('start')
  return lists.length
}
