import { escapeReasoningTags } from './special-tags.mjs'

// The card shows its "waiting for response" placeholder until the first answer chunk
// arrives. That placeholder is not an answer, so a still-thinking model must not be
// treated as if the answer had already started.
const ANSWER_PLACEHOLDER_CLASS = 'gpt-loading'

/**
 * Build the document handed to the streaming renderer.
 *
 * HyperMarkdown keeps a reasoning block streamed — expanded, extended in place, with its
 * elapsed timer running — only while the closing tag is missing, and collapses it (freezing
 * the timer) once the tag arrives. So the tag is added when the thinking has actually
 * stopped: the answer has started arriving, or the stream has ended.
 *
 * The reasoning is wrapped in synthetic tags, so any of those tags inside it are escaped
 * first; otherwise a literal delimiter would close the block early and push the rest of
 * the thinking into the answer.
 * @param {string} children the answer so far, or the card's loading placeholder
 * @param {string} reasoning the thinking so far
 * @param {boolean} done whether the response stream has finished
 * @returns {string}
 */
export function buildStreamedContent(children, reasoning, done) {
  if (!reasoning) return children
  const answer = children.includes(ANSWER_PLACEHOLDER_CLASS) ? '' : children
  const thinking = escapeReasoningTags(reasoning)
  const reasoningFinished = done || Boolean(answer)
  if (!reasoningFinished) return `<think>\n${thinking}`
  return `<think>\n${thinking}\n</think>\n\n${answer}`
}
