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
import { shouldHandleInputAction } from './input-action.mjs'
import {
  IMAGE_ACCEPT,
  IMAGE_FILE_ERROR,
  getDroppedFiles,
  hasDraggedFiles,
  readImageAsDataUrl,
  validateImageFiles,
} from './images.mjs'

export function InputBox({
  onSubmit,
  enabled,
  postMessage,
  reverseResizeDir,
  imagesAllowed = false,
  resetKey,
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [imageEntries, setImageEntries] = useState([])
  const [imageError, setImageError] = useState('')
  const [isReadingImages, setIsReadingImages] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)
  const imageEntriesRef = useRef([])
  const readGenerationRef = useRef(0)
  const pendingReadsRef = useRef(0)
  const imageIdRef = useRef(0)
  const mountedRef = useRef(true)
  const draftRevisionRef = useRef(0)
  const submittingRef = useRef(false)
  const resizedRef = useRef(false)
  const resizeHandleRef = useRef(null)
  const resizeStartRef = useRef(null)
  const hasTopResizeHandle = Boolean(reverseResizeDir && !isMobile())
  const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT)
  const [maxInputHeight, setMaxInputHeight] = useState(DEFAULT_INPUT_HEIGHT)

  const replaceImageEntries = (nextEntries) => {
    imageEntriesRef.current = nextEntries
    setImageEntries(nextEntries)
  }

  const bumpDraftRevision = () => {
    draftRevisionRef.current += 1
  }

  const clearFileInput = () => {
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const invalidateImageReads = () => {
    readGenerationRef.current += 1
    pendingReadsRef.current = 0
    if (mountedRef.current) setIsReadingImages(false)
  }

  const clearImages = () => {
    invalidateImageReads()
    replaceImageEntries([])
    bumpDraftRevision()
    clearFileInput()
  }

  const clearDraft = () => {
    clearImages()
    setValue('')
    setImageError('')
    submittingRef.current = false
    if (mountedRef.current) setIsSubmitting(false)
  }

  const getImageErrorMessage = (reason) => {
    switch (reason) {
      case IMAGE_FILE_ERROR.TYPE:
        return t('Images must be PNG, JPEG, WEBP, or GIF.')
      case IMAGE_FILE_ERROR.FILE_SIZE:
        return t('Each image must be 4 MiB or smaller.')
      case IMAGE_FILE_ERROR.COUNT:
        return t('You can attach up to 4 images.')
      case IMAGE_FILE_ERROR.TOTAL_SIZE:
        return t('Total image size must be 12 MiB or smaller.')
      default:
        return t('This file is not a supported image.')
    }
  }

  const isCurrentRead = (generation) =>
    mountedRef.current && readGenerationRef.current === generation

  const addImageFiles = (files) => {
    if (!files || Array.from(files).length === 0) return

    if (!imagesAllowed) {
      setImageError(t('Images require an OpenAI-compatible vision API.'))
      return
    }

    const currentEntries = imageEntriesRef.current
    const result = validateImageFiles(
      files,
      currentEntries.map((entry) => entry.file),
    )
    if (result.rejected.length > 0) {
      setImageError(getImageErrorMessage(result.rejected[0].reason))
    } else {
      setImageError('')
    }
    if (result.accepted.length === 0) return

    const generation = readGenerationRef.current
    const entries = result.accepted.map((file) => ({
      id: ++imageIdRef.current,
      file,
      dataUrl: null,
    }))
    replaceImageEntries([...currentEntries, ...entries])
    bumpDraftRevision()
    pendingReadsRef.current += entries.length
    setIsReadingImages(true)

    for (const entry of entries) {
      Promise.resolve()
        .then(() => readImageAsDataUrl(entry.file))
        .then((dataUrl) => {
          if (!isCurrentRead(generation)) return
          replaceImageEntries(
            imageEntriesRef.current.map((currentEntry) =>
              currentEntry.id === entry.id ? { ...currentEntry, dataUrl } : currentEntry,
            ),
          )
        })
        .catch(() => {
          if (!isCurrentRead(generation)) return
          replaceImageEntries(
            imageEntriesRef.current.filter((currentEntry) => currentEntry.id !== entry.id),
          )
          bumpDraftRevision()
          setImageError(t('Unable to read image.'))
        })
        .finally(() => {
          if (!isCurrentRead(generation)) return
          pendingReadsRef.current = Math.max(0, pendingReadsRef.current - 1)
          if (pendingReadsRef.current === 0) setIsReadingImages(false)
        })
    }
  }

  const removeImage = (id) => {
    if (!imageEntriesRef.current.some((entry) => entry.id === id)) return
    replaceImageEntries(imageEntriesRef.current.filter((entry) => entry.id !== id))
    bumpDraftRevision()
    setImageError('')
  }

  const handleImageInputChange = (e) => {
    addImageFiles(e.currentTarget.files)
    e.currentTarget.value = ''
  }

  const handlePaste = (e) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (files.length === 0) return

    e.preventDefault()
    addImageFiles(files)
  }

  const handleDragOver = (e) => {
    if (!hasDraggedFiles(e.dataTransfer)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = imagesAllowed ? 'copy' : 'none'
  }

  const handleDrop = (e) => {
    const files = getDroppedFiles(e.dataTransfer)
    if (files.length === 0) return
    e.preventDefault()
    addImageFiles(files)
  }

  const handleKeyDownOrClick = (e) => {
    e.stopPropagation()
    if (!shouldHandleInputAction(e)) return

    e.preventDefault()
    if (!enabled) {
      postMessage({ stop: true })
      return
    }

    if (isReadingImages || pendingReadsRef.current > 0 || submittingRef.current) return

    const submittedImages = imageEntriesRef.current
      .map((entry) => entry.dataUrl)
      .filter((dataUrl) => typeof dataUrl === 'string' && dataUrl.length > 0)
    const question = value.trim()
      ? value
      : submittedImages.length > 0
      ? t('Describe these images')
      : ''
    if (!question) return

    const submittedRevision = draftRevisionRef.current
    submittingRef.current = true
    setIsSubmitting(true)
    Promise.resolve()
      .then(() => onSubmit(question, submittedImages))
      .then(() => {
        if (!mountedRef.current || draftRevisionRef.current !== submittedRevision) return
        clearDraft()
      })
      .catch((error) => {
        if (!mountedRef.current || draftRevisionRef.current !== submittedRevision) return
        const message = error instanceof Error ? error.message : String(error || '')
        setImageError(message ? t(message) : t('Unable to send images.'))
      })
      .finally(() => {
        submittingRef.current = false
        if (mountedRef.current) setIsSubmitting(false)
      })
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      mountedRef.current = false
      readGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    clearDraft()
  }, [resetKey])

  useEffect(() => {
    if (imagesAllowed || (imageEntriesRef.current.length === 0 && pendingReadsRef.current === 0))
      return
    clearImages()
  }, [imagesAllowed])

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

  const sendDisabled = enabled && (isReadingImages || isSubmitting)

  return (
    <div
      className="input-box"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
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
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        aria-label={t('Attach images')}
        style={{ display: 'none' }}
        onChange={handleImageInputChange}
      />
      {imagesAllowed ? (
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '5px 12px',
          }}
        >
          <button
            type="button"
            className="input-image-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSubmitting}
            aria-label={t('Attach images')}
            title={t('Choose a model that supports image input.')}
            style={{ cursor: isSubmitting ? 'wait' : 'pointer' }}
          >
            {t('Attach images')}
          </button>
          <span
            title={t('Choose a model that supports image input.')}
            style={{ color: 'var(--font-color)', fontSize: '0.85em', opacity: 0.75 }}
          >
            {t('Drop images here or paste a screenshot')}
          </span>
        </div>
      ) : (
        <div
          role="status"
          style={{
            color: 'var(--font-color)',
            fontSize: '0.85em',
            opacity: 0.75,
            padding: '5px 12px',
          }}
        >
          {t('Images require an OpenAI-compatible vision API.')}
        </div>
      )}
      {imageEntries.length > 0 && (
        <div
          role="list"
          aria-label={t('Attached images')}
          style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '5px 12px' }}
        >
          {imageEntries.map((entry, index) => (
            <div
              key={entry.id}
              role="listitem"
              style={{ height: '52px', position: 'relative', width: '52px' }}
            >
              {entry.dataUrl ? (
                <img
                  src={entry.dataUrl}
                  alt={`${t('Image')} ${index + 1}`}
                  style={{
                    border: '1px solid var(--theme-border-color)',
                    borderRadius: '4px',
                    height: '52px',
                    objectFit: 'cover',
                    width: '52px',
                  }}
                />
              ) : (
                <span
                  aria-busy="true"
                  title={t('Reading image')}
                  style={{
                    alignItems: 'center',
                    backgroundColor: 'var(--theme-border-color)',
                    borderRadius: '4px',
                    display: 'flex',
                    height: '52px',
                    justifyContent: 'center',
                    width: '52px',
                  }}
                >
                  …
                </span>
              )}
              <button
                type="button"
                onClick={() => removeImage(entry.id)}
                aria-label={`${t('Remove image')} ${entry.file.name || t('Image')}`}
                title={t('Remove image')}
                style={{
                  alignItems: 'center',
                  backgroundColor: 'var(--theme-color)',
                  border: '1px solid var(--theme-border-color)',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  display: 'flex',
                  height: '18px',
                  justifyContent: 'center',
                  lineHeight: 1,
                  padding: 0,
                  position: 'absolute',
                  right: '-6px',
                  top: '-6px',
                  width: '18px',
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {imageError && (
        <div role="alert" style={{ color: '#cf222e', fontSize: '0.85em', padding: '2px 12px' }}>
          {imageError}
        </div>
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
          onChange={(e) => {
            setValue(e.target.value)
            bumpDraftRevision()
          }}
          onKeyDown={handleKeyDownOrClick}
        />
      </div>
      <button
        type="button"
        className="submit-button"
        style={{
          backgroundColor: enabled ? '#30a14e' : '#cf222e',
        }}
        disabled={sendDisabled}
        aria-busy={isReadingImages || isSubmitting}
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
  imagesAllowed: PropTypes.bool,
  resetKey: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  reverseResizeDir: PropTypes.bool,
  postMessage: PropTypes.func.isRequired,
}

export default InputBox
