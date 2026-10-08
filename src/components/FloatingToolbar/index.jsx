import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { unmountComponentAtNode } from 'react-dom'
import ConversationCard from '../ConversationCard'
import PropTypes from 'prop-types'
import { config as toolsConfig } from '../../content-script/selection-tools'
import { getClientPosition, isMobile, setElementPositionInViewport } from '../../utils'
import { DraggableCore } from 'react-draggable'
import { useClampWindowSize } from '../../hooks/use-clamp-window-size'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../../hooks/use-config.mjs'

// const logo = Browser.runtime.getURL('logo.png')

function FloatingToolbar(props) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState(props.selection)
  const [prompt, setPrompt] = useState(props.prompt)
  const [triggered, setTriggered] = useState(props.triggered)
  const [render, setRender] = useState(false)
  const [closeable, setCloseable] = useState(props.closeable)
  const [position, setPosition] = useState(getClientPosition(props.container))
  const [virtualPosition, setVirtualPosition] = useState({ x: 0, y: 0 })
  const mountedRef = useRef(true)
  const positionRef = useRef(position)
  const positionTimerRef = useRef(null)
  const virtualPositionRef = useRef(virtualPosition)
  const isDraggingRef = useRef(false)
  const draggableCoreRef = useRef(null)
  const lastDragEventRef = useRef(null)
  const activeTouchIdentifierRef = useRef(null)
  const toolRequestVersionRef = useRef(0)
  const windowSize = useClampWindowSize([750, 1500], [0, Infinity])
  const config = useConfig(() => {
    if (!mountedRef.current) return
    setRender(true)
    if (!triggered && selection) {
      props.container.style.position = 'absolute'
      if (positionTimerRef.current !== null) clearTimeout(positionTimerRef.current)
      positionTimerRef.current = setTimeout(() => {
        positionTimerRef.current = null
        if (!mountedRef.current) return
        const left = Math.min(
          Math.max(0, window.innerWidth - props.container.offsetWidth - 30),
          Math.max(0, position.x),
        )
        props.container.style.left = left + 'px'
      })
    }
  })

  const showConversation = Boolean(triggered || (prompt && !selection))
  const updatePosition = useCallback(() => {
    const currentPosition = positionRef.current
    const newPosition = setElementPositionInViewport(
      props.container,
      currentPosition.x,
      currentPosition.y,
    )
    if (currentPosition.x !== newPosition.x || currentPosition.y !== newPosition.y) {
      positionRef.current = newPosition
      setPosition(newPosition)
    }
  }, [props.container])
  const finishDrag = useCallback(() => {
    if (!isDraggingRef.current) return

    const currentPosition = positionRef.current
    const offset = virtualPositionRef.current
    const nextPosition = {
      x: currentPosition.x + offset.x,
      y: currentPosition.y + offset.y,
    }
    const resetVirtualPosition = { x: 0, y: 0 }

    isDraggingRef.current = false
    lastDragEventRef.current = null
    activeTouchIdentifierRef.current = null
    positionRef.current = nextPosition
    virtualPositionRef.current = resetVirtualPosition
    setPosition(nextPosition)
    setVirtualPosition(resetVirtualPosition)
  }, [])

  useLayoutEffect(() => {
    positionRef.current = position
    virtualPositionRef.current = virtualPosition

    if (
      !render ||
      !showConversation ||
      isDraggingRef.current ||
      virtualPosition.x !== 0 ||
      virtualPosition.y !== 0
    ) {
      return
    }
    updatePosition()
  }, [position, virtualPosition, render, showConversation, updatePosition, windowSize])

  useEffect(() => {
    if (!render || !showConversation || typeof window.ResizeObserver !== 'function') return

    const observer = new window.ResizeObserver(() => {
      if (!mountedRef.current || isDraggingRef.current) return
      updatePosition()
    })
    observer.observe(props.container)
    return () => observer.disconnect()
  }, [render, showConversation, props.container, updatePosition])

  useEffect(() => {
    if (!showConversation) return

    const ownerDocument = props.container.ownerDocument
    const ownerWindow = ownerDocument.defaultView ?? window
    const handleBlur = () => {
      const lastDragEvent = lastDragEventRef.current
      if (isDraggingRef.current && lastDragEvent) {
        draggableCoreRef.current?.handleDragStop?.(lastDragEvent)
      }
      finishDrag()
    }
    const handleTouchCancel = (event) => {
      if (!isDraggingRef.current) return

      const activeIdentifier = activeTouchIdentifierRef.current
      const canceledTouches = event.changedTouches
      let activeTouchCanceled = false
      if (activeIdentifier !== null && canceledTouches) {
        for (let i = 0; i < canceledTouches.length; i += 1) {
          if (canceledTouches[i]?.identifier === activeIdentifier) {
            activeTouchCanceled = true
            break
          }
        }
      }
      if (!activeTouchCanceled) return

      draggableCoreRef.current?.handleDragStop?.(event)
      finishDrag()
    }

    ownerWindow.addEventListener('blur', handleBlur)
    ownerDocument.addEventListener('touchcancel', handleTouchCancel)
    return () => {
      ownerWindow.removeEventListener('blur', handleBlur)
      ownerDocument.removeEventListener('touchcancel', handleTouchCancel)
    }
  }, [showConversation, props.container, finishDrag])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      toolRequestVersionRef.current += 1
      if (positionTimerRef.current !== null) {
        clearTimeout(positionTimerRef.current)
        positionTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (isMobile()) {
      const selectionListener = () => {
        const currentSelection = window.getSelection()?.toString()
        if (currentSelection) setSelection(currentSelection)
      }
      document.addEventListener('selectionchange', selectionListener)
      return () => {
        document.removeEventListener('selectionchange', selectionListener)
      }
    }
  }, [])

  if (!render) return <div />

  if (showConversation) {
    const dragEvent = {
      onStart: (e) => {
        isDraggingRef.current = true
        lastDragEventRef.current = e
        activeTouchIdentifierRef.current =
          e?.type === 'touchstart'
            ? e.targetTouches?.[0]?.identifier ?? e.changedTouches?.[0]?.identifier ?? null
            : null
      },
      onDrag: (e, ui) => {
        if (!isDraggingRef.current) return false
        lastDragEventRef.current = e
        if (e?.type === 'mousemove' && e.buttons === 0) {
          finishDrag()
          return false
        }

        const currentVirtualPosition = virtualPositionRef.current
        const nextVirtualPosition = {
          x: currentVirtualPosition.x + ui.deltaX,
          y: currentVirtualPosition.y + ui.deltaY,
        }
        virtualPositionRef.current = nextVirtualPosition
        setVirtualPosition(nextVirtualPosition)
      },
      onStop: finishDrag,
    }

    const onClose = useCallback(() => {
      unmountComponentAtNode(props.container)
      props.container.remove()
    }, [])

    const onDock = useCallback(() => {
      props.container.className = 'chatgptbox-toolbar-container-not-queryable'
      setCloseable(true)
    }, [])

    const onUpdate = useCallback(() => {
      if (isDraggingRef.current) return
      updatePosition()
    }, [updatePosition])

    if (config.alwaysPinWindow) onDock()

    return (
      <div data-theme={config.themeMode}>
        <DraggableCore
          ref={draggableCoreRef}
          handle=".draggable"
          onStart={dragEvent.onStart}
          onDrag={dragEvent.onDrag}
          onStop={dragEvent.onStop}
        >
          <div
            className="chatgptbox-selection-window"
            style={{
              width: windowSize[0] * 0.4 + 'px',
              transform: `translate(${virtualPosition.x}px, ${virtualPosition.y}px)`,
            }}
          >
            <div className="chatgptbox-container">
              <ConversationCard
                session={props.session}
                question={prompt}
                draggable={true}
                closeable={closeable}
                onClose={onClose}
                dockable={props.dockable}
                onDock={onDock}
                onUpdate={onUpdate}
                waitForTrigger={prompt && !triggered && !selection}
              />
            </div>
          </div>
        </DraggableCore>
      </div>
    )
  } else {
    if (
      config.activeSelectionTools.length === 0 &&
      config.customSelectionTools.reduce((count, tool) => count + (tool.active ? 1 : 0), 0) === 0
    )
      return <div />

    const tools = []
    const pushTool = (iconKey, name, genPrompt) => {
      tools.push(
        cloneElement(toolsConfig[iconKey].icon, {
          size: 24,
          className: 'chatgptbox-selection-toolbar-button',
          title: name,
          onClick: async () => {
            const requestVersion = ++toolRequestVersionRef.current
            if (positionTimerRef.current !== null) {
              clearTimeout(positionTimerRef.current)
              positionTimerRef.current = null
            }
            const p = getClientPosition(props.container)
            props.container.style.position = 'fixed'
            setPosition(p)
            try {
              const nextPrompt = await genPrompt(selection)
              if (!mountedRef.current || requestVersion !== toolRequestVersionRef.current) return
              setPrompt(nextPrompt)
              setTriggered(true)
            } catch (error) {
              if (!mountedRef.current || requestVersion !== toolRequestVersionRef.current) return
              console.error('[FloatingToolbar] Failed to generate selection tool prompt:', error)
            }
          },
        }),
      )
    }

    for (const key in toolsConfig) {
      if (config.activeSelectionTools.includes(key)) {
        const toolConfig = toolsConfig[key]
        pushTool(key, t(toolConfig.label), toolConfig.genPrompt)
      }
    }
    for (const tool of config.customSelectionTools) {
      if (tool.active) {
        pushTool(tool.iconKey, tool.name, async (selection) => {
          return tool.prompt.replace('{{selection}}', selection)
        })
      }
    }

    return (
      <div data-theme={config.themeMode}>
        <div className="chatgptbox-selection-toolbar">{tools}</div>
      </div>
    )
  }
}

FloatingToolbar.propTypes = {
  session: PropTypes.object.isRequired,
  selection: PropTypes.string.isRequired,
  container: PropTypes.object.isRequired,
  triggered: PropTypes.bool,
  closeable: PropTypes.bool,
  dockable: PropTypes.bool,
  prompt: PropTypes.string,
}

export default FloatingToolbar
