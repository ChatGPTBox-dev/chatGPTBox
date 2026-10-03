const REASONING_TAG_PATTERN = /<\/?\s*(?:think|thinking|reasoning)\b[^>]*>/gi
const FENCE_PATTERN = /^ {0,3}(?:```+|~~~+)/

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
  let inFence = false
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const isFenceLine = FENCE_PATTERN.test(line)
      if (inFence) {
        if (isFenceLine) inFence = false
        return line
      }
      if (isFenceLine) {
        inFence = true
        return line
      }
      return escapeTagsOutsideInlineCode(line)
    })
    .join('')
}

/**
 * Show `<think>`-style tags as literal text. HyperMarkdown treats them as markup: a leading
 * one becomes a reasoning block, and any other one is stripped out of the answer. That is
 * wrong for text the user typed, and for prose or examples that merely mention a tag.
 *
 * Fenced code blocks and inline code are left alone — their content is already rendered as
 * literal text, and escaping it there would show the escape characters themselves.
 *
 * @param {string} text
 * @param {{preserveLeadingBlock?: boolean}} [options] keep a leading reasoning block intact,
 *   for providers that stream their thinking inside the answer
 * @returns {string}
 */
export function escapeReasoningTags(text, { preserveLeadingBlock = false } = {}) {
  if (typeof text !== 'string' || !text.includes('<')) return text

  let head = ''
  let body = text
  if (preserveLeadingBlock) {
    const leading =
      /^\s*<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\s*(?:think|thinking|reasoning)\s*>|$)/i.exec(
        text,
      )
    if (leading) {
      head = leading[0]
      body = text.slice(head.length)
    }
  }

  return head + escapeTagsOutsideCode(body)
}
