// The renderer treats all three names as reasoning tags, so one source keeps the pattern in
// sync.
const REASONING_TAG_NAME = 'think|thinking|reasoning'
const REASONING_TAG_PATTERN = new RegExp(`</?\\s*(?:${REASONING_TAG_NAME})\\b[^>]*>`, 'gi')
// A fence line: any indentation, any blockquote markers, then three or more backticks or
// tildes and whatever follows them. The renderer has no indented-code block, so a fence does
// not have to be at the left margin -- inside a list item or a quote it is still a fence.
const FENCE_PATTERN = /^[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})([^\n]*)/

function escapeTags(text) {
  // Only the leading angle bracket is escaped, so the tag still reads as "<think>".
  return text.replace(REASONING_TAG_PATTERN, (tag) => `&lt;${tag.slice(1)}`)
}

function escapeTagsOutsideInlineCode(line) {
  let result = ''
  let index = 0
  while (index < line.length) {
    const tickIndex = line.indexOf('`', index)
    if (tickIndex === -1) {
      result += escapeTags(line.slice(index))
      break
    }
    const ticks = /^`+/.exec(line.slice(tickIndex))[0]
    const closeIndex = line.indexOf(ticks, tickIndex + ticks.length)
    if (closeIndex === -1) {
      result += escapeTags(line.slice(index))
      break
    }
    result += escapeTags(line.slice(index, tickIndex))
    result += line.slice(tickIndex, closeIndex + ticks.length)
    index = closeIndex + ticks.length
  }
  return result
}

function escapeTagsOutsideCode(text) {
  // Markdown matches the closing fence by character and requires it to be at least as long as
  // the opening one, so ```` ``` ```` stays open through a line of ``` and a nested example
  // survives. Wrapping the state in an object keeps the per-line closure honest.
  const state = { fence: null }
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const fenceLine = FENCE_PATTERN.exec(line)
      if (state.fence !== null) {
        if (
          fenceLine &&
          fenceLine[1][0] === state.fence[0] &&
          fenceLine[1].length >= state.fence.length &&
          // A closing fence carries no info string.
          fenceLine[2].trim() === ''
        ) {
          state.fence = null
        }
        return line
      }
      if (fenceLine) {
        state.fence = fenceLine[1]
        return line
      }
      return escapeTagsOutsideInlineCode(line)
    })
    .join('')
}

/**
 * Show `<think>`-style tags as literal text.
 *
 * HyperMarkdown treats them as markup: a leading one becomes a reasoning block, and any other
 * one is stripped out of the answer. That is wrong for text the user typed, and for prose that
 * merely mentions a tag.
 *
 * A reasoning model's thinking never reaches this: it is rendered from its own field, so this
 * only has to neutralise tags left in ordinary content. Fenced code and inline code are left
 * alone -- their content is literal text already, and the streaming renderer does not look for
 * a reasoning tag inside them.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeReasoningTags(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text
  return escapeTagsOutsideCode(text)
}
