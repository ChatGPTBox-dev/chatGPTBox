/**
 * HyperMarkdown omits `start` on an ordered list that begins at 1 while the list streams, then
 * adds `start="0"` when the block is finalized. Browsers honour that literally and number the
 * list from zero, so the attribute has to go before the native markers are drawn. A list that
 * genuinely begins at 0 wears the same attribute, though, so the value alone does not say which
 * one this is.
 *
 * The two are told apart by what the list wore when it was first seen: a list that appeared
 * without a `start` and then grew one was numbered by the renderer, where a list that already
 * carried `start="0"` was written that way. Only the first is corrected, and only while the
 * element is still the one that was seen.
 *
 * @returns {{apply: (container: ParentNode | null | undefined) => number}}
 */
export function createListStartNormalizer() {
  const startWhenFirstSeen = new WeakMap()

  return {
    /**
     * Correct the renderer's numbering, if this container's lists need it.
     * @param {ParentNode | null | undefined} container
     * @returns {number} how many lists were corrected
     */
    apply(container) {
      const lists = container?.querySelectorAll?.('ol')
      if (!lists) return 0
      let corrected = 0
      for (const list of lists) {
        const start = list.getAttribute('start')
        if (!startWhenFirstSeen.has(list)) {
          startWhenFirstSeen.set(list, start)
          continue
        }
        if (startWhenFirstSeen.get(list) === null && start === '0') {
          list.removeAttribute('start')
          corrected += 1
        }
      }
      return corrected
    },
  }
}
