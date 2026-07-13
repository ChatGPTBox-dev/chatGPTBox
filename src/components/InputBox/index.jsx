import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { isMobile, updateRefHeight } from '../../utils'
import { useTranslation } from 'react-i18next'
import { getUserConfig } from '../../config/index.mjs'
import {
  clampInputHeight,
  DEFAULT_INPUT_HEIGHT,
  getKeyboardInputHeight,
  getPointerInputHeight,
  MIN_CONVERSATION_HEIGHT,
  MIN_INPUT_HEIGHT,
} from './resize.mjs'

export function InputBox({ onSubmit, enabled, postMessage, reverseResizeDir }) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  const resizedRef = useRef(false)
  const resizeHandleRef = useRef(null)
  const resizeStartRef = useRef(null)
  const hasTopResizeHandle = Boolean(reverseResizeDir && !isMobile())
  const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT)
  const [maxInputHeight, setMaxInputHeight] = useState(DEFAULT_INPUT_HEIGHT)

  useEffect(() => {
    inputRef.current.focus()
  }, [])

  useEffect(() => {
    if (hasTopResizeHandle) return

    const input = inputRef.current
    const onResizeY = () => {
      if (input.h !== input.offsetHeight) {
        input.h = input.offsetHeight
        if (!resizedRef.current) {
          resizedRef.current = true
          input.style.maxHeight = ''
        }
      }
    }
    input.h = input.offsetHeight
    input.addEventListener('mousemove', onResizeY)
    return () => input.removeEventListener('mousemove', onResizeY)
  }, [hasTopResizeHandle])

  useEffect(() => {
    if (!resizedRef.current && !hasTopResizeHandle) {
      updateRefHeight(inputRef)
      inputRef.current.h = inputRef.current.offsetHeight
      inputRef.current.style.maxHeight = `${DEFAULT_INPUT_HEIGHT}px`
    }
  })

  const getMaxInputHeight = () => {
    const container = inputRef.current?.closest('.gpt-inner')
    const conversation = container?.querySelector('.markdown-body')
    const resizeHandle = resizeHandleRef.current

    if (!container || !conversation || !resizeHandle) return DEFAULT_INPUT_HEIGHT

    return Math.max(
      MIN_INPUT_HEIGHT,
      container.clientHeight -
        conversation.offsetTop -
        resizeHandle.offsetHeight -
        MIN_CONVERSATION_HEIGHT,
    )
  }

  useLayoutEffect(() => {
    if (!hasTopResizeHandle) return

    const updateResizeBounds = () => {
      const maxHeight = getMaxInputHeight()
      if (resizeStartRef.current) resizeStartRef.current.maxHeight = maxHeight
      setMaxInputHeight(maxHeight)
      setInputHeight((height) => clampInputHeight(height, maxHeight))
    }

    updateResizeBounds()
    window.addEventListener('resize', updateResizeBounds)
    return () => window.removeEventListener('resize', updateResizeBounds)
  }, [hasTopResizeHandle])

  useEffect(() => {
    if (enabled)
      getUserConfig().then((config) => {
        if (config.focusAfterAnswer) inputRef.current?.focus()
      })
  }, [enabled])

  const handleKeyDownOrClick = (e) => {
    e.stopPropagation()
    if (e.type === 'click' || (e.keyCode === 13 && e.shiftKey === false)) {
      e.preventDefault()
      if (enabled) {
        if (!value) return
        onSubmit(value)
        setValue('')
      } else {
        postMessage({ stop: true })
      }
    }
  }

  const handleResizePointerDown = (e) => {
    if (!e.isPrimary || e.button !== 0) return

    e.currentTarget.focus()
    e.preventDefault()
    const maxHeight = getMaxInputHeight()
    setMaxInputHeight(maxHeight)
    resizeStartRef.current = {
      pointerId: e.pointerId,
      height: inputRef.current.offsetHeight,
      y: e.clientY,
      maxHeight,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handleResizePointerMove = (e) => {
    const resizeStart = resizeStartRef.current
    if (!resizeStart || resizeStart.pointerId !== e.pointerId) return

    e.preventDefault()
    setInputHeight(
      getPointerInputHeight(resizeStart.height, resizeStart.y, e.clientY, resizeStart.maxHeight),
    )
  }

  const stopResizing = (e) => {
    if (resizeStartRef.current?.pointerId !== e.pointerId) return

    const restoreInputFocus = document.activeElement === e.currentTarget
    resizeStartRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (restoreInputFocus) inputRef.current.focus()
  }

  const handleResizeKeyDown = (e) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return

    const maxHeight = getMaxInputHeight()
    e.preventDefault()
    setMaxInputHeight(maxHeight)
    setInputHeight(
      (height) => getKeyboardInputHeight(height, e.key, maxHeight, e.shiftKey) ?? height,
    )
  }

  return (
    <div className="input-box">
      {hasTopResizeHandle && (
        <div
          ref={resizeHandleRef}
          className="input-resize-handle"
          role="separator"
          aria-controls="chatgptbox-independent-input"
          aria-label={t('Resize input box')}
          aria-orientation="horizontal"
          aria-valuemax={maxInputHeight}
          aria-valuemin={MIN_INPUT_HEIGHT}
          aria-valuenow={inputHeight}
          tabIndex={0}
          onKeyDown={handleResizeKeyDown}
          onLostPointerCapture={stopResizing}
          onPointerCancel={stopResizing}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={stopResizing}
        />
      )}
      <div
        className={hasTopResizeHandle ? 'input-resize-content' : undefined}
        style={hasTopResizeHandle ? { height: `${inputHeight}px` } : undefined}
      >
        <textarea
          id={hasTopResizeHandle ? 'chatgptbox-independent-input' : undefined}
          dir="auto"
          ref={inputRef}
          disabled={false}
          className="interact-input"
          style={{
            resize: hasTopResizeHandle ? 'none' : 'vertical',
            minHeight: `${MIN_INPUT_HEIGHT}px`,
          }}
          placeholder={
            enabled
              ? t('Type your question here\nEnter to send, shift + enter to break line')
              : t('Type your question here\nEnter to stop generating\nShift + enter to break line')
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDownOrClick}
        />
      </div>
      <button
        className="submit-button"
        style={{
          backgroundColor: enabled ? '#30a14e' : '#cf222e',
        }}
        onClick={handleKeyDownOrClick}
      >
        {enabled ? t('Ask') : t('Stop')}
      </button>
    </div>
  )
}

InputBox.propTypes = {
  onSubmit: PropTypes.func.isRequired,
  enabled: PropTypes.bool.isRequired,
  reverseResizeDir: PropTypes.bool,
  postMessage: PropTypes.func.isRequired,
}

export default InputBox
