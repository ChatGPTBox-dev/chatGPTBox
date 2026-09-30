const REASONING_OPEN_REGEX = /^\s*<(think|thinking|reasoning)(?:\s[^>]*)?>/i

/**
 * Some models put their reasoning straight into the answer, wrapped in a `<think>`-style
 * tag, instead of streaming it through a reasoning field. A leading block like that is
 * split off so it can be shown as reasoning and stay out of the conversation records.
 *
 * Anything else in the answer is left untouched: prose that merely mentions a tag, and
 * code samples that happen to contain one, keep their text.
 *
 * @param {string} content the answer so far
 * @returns {{reasoning: string, answer: string}} the leading thinking and the remaining answer
 */
export function splitInlineReasoning(content) {
  const open = REASONING_OPEN_REGEX.exec(content)
  if (!open) return { reasoning: '', answer: content }

  const rest = content.slice(open[0].length)
  // The closing tag may still be on its way while the model is thinking.
  const close = new RegExp(`</\\s*${open[1]}\\s*>`, 'i').exec(rest)
  if (!close) return { reasoning: rest, answer: '' }

  return {
    reasoning: rest.slice(0, close.index),
    answer: rest.slice(close.index + close[0].length).replace(/^\s+/, ''),
  }
}
