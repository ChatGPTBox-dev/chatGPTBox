import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import { HyperMarkdown } from '@aeven-ai/hypermarkdown'
import { highlightPlugin } from '@aeven-ai/hypermarkdown/plugins/code'
import { Hyperlink } from './Hyperlink'
import { highlightOptions } from './highlight-options.mjs'
import { mathPlugin } from './math-plugin.mjs'
import { normalizeListStarts } from './list-markers.mjs'
import { createStreamDelta } from './stream-delta.mjs'

// This component can land in a shared chunk, whose CSS is never packaged (see build.mjs),
// so its stylesheets are imported by the content-script entry instead.

// rehype-react keys elements by component identity, so these maps have to stay stable
// across renders or every block remounts.
const PLUGINS = { math: mathPlugin(), code: highlightPlugin(highlightOptions) }
const COMPONENTS = { a: Hyperlink }
// Fullscreen and the HTML preview expect the host to hide its own chrome around them,
// which this card does not do; the copy button is the part that works on its own.
const CONTROLS = { code: { fullscreen: false, preview: false }, table: { fullscreen: false } }
// The loading placeholder is injected as HTML and styled through this class.
const ALLOWED_TAGS = { p: ['className'] }

/**
 * @param {object} props
 * @param {string} props.children markdown, or the whole answer so far while streaming
 * @param {boolean} [props.done] false while the answer is still arriving
 */
export function MarkdownRender({ children, done = true }) {
  const { t } = useTranslation()
  const rendererRef = useRef(null)
  const containerRef = useRef(null)
  const deltaRef = useRef(null)
  if (deltaRef.current === null) deltaRef.current = createStreamDelta()

  // The renderer draws its own markers with `li::before`, but a nested bullet list inherits
  // the numbered marker of the list around it and its counter ignores `start`. The markers
  // are therefore drawn by the browser (see content-script/styles.scss), which needs the
  // streaming-only `start="0"` cleaned up.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const correctStarts = () => normalizeListStarts(container)
    correctStarts()
    const observer = new MutationObserver(correctStarts)
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['start'],
    })
    return () => observer.disconnect()
  }, [])

  // Answers arrive as a growing snapshot, but the renderer takes deltas and caches the
  // blocks it has settled, so only the new text is parsed on each update.
  useLayoutEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const step = deltaRef.current.next(children, done)
    if (!step) return
    if (step.reset) renderer.reset()
    renderer.write(step.write, step.finalize)
  })

  // `{seconds}` is filled in by the renderer, and is not i18next interpolation syntax.
  const translations = useMemo(
    () => ({ thinking: t('Thinking Content'), thoughtFor: t('Thought for {seconds}s') }),
    [t],
  )

  return (
    <div dir="auto" ref={containerRef}>
      <HyperMarkdown
        ref={rendererRef}
        streaming
        plugins={PLUGINS}
        components={COMPONENTS}
        controls={CONTROLS}
        translations={translations}
        allowedTags={ALLOWED_TAGS}
        lineNumbers={false}
      />
    </div>
  )
}

MarkdownRender.propTypes = {
  children: PropTypes.string.isRequired,
  done: PropTypes.bool,
}

export default memo(MarkdownRender)
