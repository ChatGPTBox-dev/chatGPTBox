import { memo, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import { HyperMarkdown } from '@aeven-ai/hypermarkdown'
import { createListStartNormalizer } from './list-markers.mjs'
import { escapeReasoningTags } from './special-tags.mjs'
import { createStreamDelta } from './stream-delta.mjs'
import { waitingPlaceholder } from './waiting-placeholder.mjs'
import ReasoningPanel from './ReasoningPanel.jsx'
import { ALLOWED_TAGS, COMPONENTS, CONTROLS, PLUGINS } from './renderer-config.mjs'

// This component can land in a shared chunk, whose CSS is never packaged (see build.mjs),
// so its stylesheets are imported by the content-script entry instead.

/**
 * @param {object} props
 * @param {string} props.children markdown, or the whole answer so far while streaming
 * @param {boolean} [props.done] false while the answer is still arriving
 * @param {string} [props.reasoning] thinking to show ahead of the answer
 */
export function MarkdownRender({ children, done = true, reasoning = '' }) {
  const { t } = useTranslation()
  const rendererRef = useRef(null)
  const containerRef = useRef(null)
  const deltaRef = useRef(null)
  if (deltaRef.current === null) deltaRef.current = createStreamDelta()
  const listStartsRef = useRef(null)
  if (listStartsRef.current === null) listStartsRef.current = createListStartNormalizer()
  // The card's placeholder is not answer text, so until real text arrives the thinking is
  // still the part that is streaming.
  const answerStarted = children !== '' && children !== waitingPlaceholder(t)
  // Thinking is rendered from its own field, so any reasoning tag left in ordinary content is
  // just text: it is escaped so the renderer cannot turn it into a block or strip it.
  const content = escapeReasoningTags(children)

  // Answers arrive as a growing snapshot, but the renderer takes deltas and caches the
  // blocks it has settled, so only the new text is parsed on each update.
  useLayoutEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const step = deltaRef.current.next(content, done)
    if (!step) return
    if (step.reset) renderer.reset()
    renderer.write(step.write, step.finalize)
  })

  // The renderer draws its own markers with `li::before`, but a nested bullet list inherits
  // the numbered marker of the list around it and its counter ignores `start`. The markers are
  // therefore drawn by the browser (see content-script/styles.scss), which needs the
  // `start="0"` the renderer adds to a finalized list that began at 1 cleaned up. This runs
  // after the write above, so it sees the DOM the renderer just produced.
  useLayoutEffect(() => {
    listStartsRef.current.apply(containerRef.current)
  })

  // The renderer also writes into its container on its own, outside a render of this
  // component; the observer is what catches those.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new MutationObserver(() => listStartsRef.current.apply(container))
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['start'],
    })
    return () => observer.disconnect()
  }, [])

  return (
    <div dir="auto" ref={containerRef}>
      {reasoning ? (
        <ReasoningPanel reasoning={reasoning} streaming={!done && !answerStarted} />
      ) : null}
      <HyperMarkdown
        ref={rendererRef}
        streaming
        plugins={PLUGINS}
        components={COMPONENTS}
        controls={CONTROLS}
        allowedTags={ALLOWED_TAGS}
        lineNumbers={false}
      />
    </div>
  )
}

MarkdownRender.propTypes = {
  children: PropTypes.string.isRequired,
  done: PropTypes.bool,
  reasoning: PropTypes.string,
}

export default memo(MarkdownRender)
