import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import { HyperMarkdown } from '@aeven-ai/hypermarkdown'
import { ChevronDownIcon } from '@primer/octicons-react'
import { createStreamDelta } from './stream-delta.mjs'
import { escapeReasoningTags } from './special-tags.mjs'
import { ALLOWED_TAGS, COMPONENTS, CONTROLS, PLUGINS } from './renderer-config.mjs'

/**
 * The collapsible block that shows a model's thinking.
 *
 * Whether it exists is decided by the reasoning field alone. The thinking reaches its own
 * renderer as plain markdown, so nothing written in the answer or the question -- a literal
 * `<think>`, a code fence, an escaped tag -- can open, close or reshape the block. The answer
 * streams through a separate renderer for the same reason.
 *
 * The markup mirrors the renderer's own reasoning block (`.reasoning-*`, styled by
 * hypermarkdown.css) so that stylesheet keeps working unchanged. The timer behaves the same
 * way: it runs while the thinking is still arriving, then freezes and folds the block away
 * unless the reader has taken over by toggling it.
 *
 * @param {object} props
 * @param {string} props.reasoning the thinking so far
 * @param {boolean} props.streaming whether more thinking is still on its way
 */
export function ReasoningPanel({ reasoning, streaming }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const [seconds, setSeconds] = useState(0)
  const startedRef = useRef(null)
  const toggledRef = useRef(false)
  const deltaRef = useRef(null)
  const rendererRef = useRef(null)
  if (startedRef.current === null) startedRef.current = Date.now()
  if (deltaRef.current === null) deltaRef.current = createStreamDelta()

  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    // The thinking has stopped: freeze the timer and fold the block away, unless the reader
    // has taken over by opening or closing it.
    if (streaming || toggledRef.current) return
    setSeconds(Math.round((Date.now() - startedRef.current) / 1000))
    setOpen(false)
  }, [streaming])

  useLayoutEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    // The thinking is text from the model too, so a reasoning tag written inside it stays
    // literal rather than opening another block.
    const step = deltaRef.current.next(escapeReasoningTags(reasoning), !streaming)
    if (!step) return
    if (step.reset) renderer.reset()
    renderer.write(step.write, step.finalize)
  })

  const title = streaming
    ? t('Thinking Content')
    : t('Thought for {seconds}s').replace('{seconds}', String(seconds))

  return (
    <div className="hypermarkdown">
      <div
        className={
          'reasoning-wrapper' +
          (streaming ? ' stream-active' : '') +
          (open ? ' open' : ' collapsed')
        }
      >
        <div className="reasoning-container">
          <button
            type="button"
            className="reasoning-header"
            aria-expanded={open}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              toggledRef.current = true
              // Reopening remounts the renderer, so its stream starts over from the top.
              if (!open) deltaRef.current = createStreamDelta()
              setOpen(!open)
            }}
          >
            <span className="reasoning-title">{title}</span>
            <span className="reasoning-chevron">
              <ChevronDownIcon size={16} />
            </span>
          </button>
          {open ? (
            <div className="reasoning-content">
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
          ) : null}
        </div>
      </div>
    </div>
  )
}

ReasoningPanel.propTypes = {
  reasoning: PropTypes.string.isRequired,
  streaming: PropTypes.bool.isRequired,
}

export default memo(ReasoningPanel)
