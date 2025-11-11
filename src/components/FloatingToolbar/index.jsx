import { cloneElement, useCallback, useEffect, useState } from 'react'
import ConversationCard from '../ConversationCard'
import PropTypes from 'prop-types'
import { config as toolsConfig } from '../../content-script/selection-tools'
import { getClientPosition, isMobile, setElementPositionInViewport } from '../../utils'
import Draggable from 'react-draggable'
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
  const config = useConfig(() => {
    setRender(true)
    if (!triggered && selection) {
      props.container.style.position = 'absolute'
      setTimeout(() => {
        const left = Math.min(
          Math.max(0, window.innerWidth - props.container.offsetWidth - 30),
          Math.max(0, position.x),
        )
        props.container.style.left = left + 'px'
      })
    }
  })

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

  if (triggered || (prompt && !selection)) {
    const updatePosition = () => {
      const newPosition = setElementPositionInViewport(props.container, position.x, position.y)
      if (position.x !== newPosition.x || position.y !== newPosition.y) setPosition(newPosition) // clear extra virtual position offset
    }

    const dragEvent = {
      onDrag: (e, ui) => {
        setVirtualPosition({ x: virtualPosition.x + ui.deltaX, y: virtualPosition.y + ui.deltaY })
      },
      onStop: () => {
        setPosition({ x: position.x + virtualPosition.x, y: position.y + virtualPosition.y })
        setVirtualPosition({ x: 0, y: 0 })
      },
    }

    if (virtualPosition.x === 0 && virtualPosition.y === 0) {
      updatePosition() // avoid jitter
    }

    const onClose = useCallback(() => {
      props.container.remove()
    }, [])

    const onDock = useCallback(() => {
      props.container.className = 'chatgptbox-toolbar-container-not-queryable'
      setCloseable(true)
    }, [])

    const onUpdate = useCallback(() => {
      updatePosition()
    }, [position])

    if (config.alwaysPinWindow) onDock()

    return (
      <div data-theme={config.themeMode}>
        <Draggable
          handle=".draggable"
          onDrag={dragEvent.onDrag}
          onStop={dragEvent.onStop}
          position={virtualPosition}
        >
          <div className="chatgptbox-selection-window">
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
        </Draggable>
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
            const p = getClientPosition(props.container)
            props.container.style.position = 'fixed'
            setPosition(p)
            setPrompt(await genPrompt(selection))
            setTriggered(true)
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
