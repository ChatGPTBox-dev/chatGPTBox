import { useTranslation } from 'react-i18next'
import { config as toolsConfig } from '../../content-script/selection-tools/index.mjs'
import PropTypes from 'prop-types'
import { useState } from 'react'
import { defaultConfig } from '../../config/index.mjs'
import { PencilIcon, TrashIcon } from '@primer/octicons-react'
import Browser from 'webextension-polyfill'

SelectionTools.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

const defaultTool = {
  name: '',
  iconKey: 'explain',
  prompt: 'Explain this: {{selection}}',
  active: true,
}

// Helper function to refresh context menu
const refreshContextMenu = () => {
  Browser.runtime.sendMessage({
    type: 'REFRESH_MENU',
  })
}

export function SelectionTools({ config, updateConfig }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [editingTool, setEditingTool] = useState(defaultTool)
  const [editingIndex, setEditingIndex] = useState(-1)

  const editingComponent = (
    <div style={{ display: 'flex', flexDirection: 'column', '--spacing': '4px' }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          onClick={(e) => {
            e.preventDefault()
            setEditing(false)
          }}
        >
          {t('Cancel')}
        </button>
        <button
          onClick={async (e) => {
            e.preventDefault()
            if (!editingTool.name) {
              setErrorMessage(t('Name is required'))
              return
            }
            if (!editingTool.prompt.includes('{{selection}}')) {
              setErrorMessage(t('Prompt template should include {{selection}}'))
              return
            }
            if (editingIndex === -1) {
              await updateConfig({
                customSelectionTools: [...config.customSelectionTools, editingTool],
              })
            } else {
              const customSelectionTools = [...config.customSelectionTools]
              customSelectionTools[editingIndex] = editingTool
              await updateConfig({ customSelectionTools })
            }
            refreshContextMenu()
            setEditing(false)
          }}
        >
          {t('Save')}
        </button>
      </div>
      {errorMessage && <div style={{ color: 'red' }}>{errorMessage}</div>}
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'noWrap' }}>
        {t('Name')}
        <input
          type="text"
          value={editingTool.name}
          onChange={(e) => setEditingTool({ ...editingTool, name: e.target.value })}
        />
        {t('Icon')}
        <select
          value={editingTool.iconKey}
          onChange={(e) => setEditingTool({ ...editingTool, iconKey: e.target.value })}
        >
          {defaultConfig.selectionTools.map((key) => (
            <option key={key} value={key}>
              {t(toolsConfig[key].label)}
            </option>
          ))}
        </select>
      </div>
      {t('Prompt Template')}
      <textarea
        type="text"
        placeholder={t('Explain this: {{selection}}')}
        style={{
          resize: 'vertical',
          minHeight: '80px',
        }}
        value={editingTool.prompt}
        onChange={(e) => setEditingTool({ ...editingTool, prompt: e.target.value })}
      />
    </div>
  )

  return (
    <>
      {config.selectionTools.map((key) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={config.activeSelectionTools.includes(key)}
            onChange={async (e) => {
              const checked = e.target.checked
              const activeSelectionTools = config.activeSelectionTools.filter((i) => i !== key)
              if (checked) activeSelectionTools.push(key)
              await updateConfig({ activeSelectionTools })
              refreshContextMenu()
            }}
          />
          {t(toolsConfig[key].label)}
        </label>
      ))}
      {config.customSelectionTools.map(
        (tool, index) =>
          tool.name &&
          (editing && editingIndex === index ? (
            editingComponent
          ) : (
            <label key={index} style={{ display: 'flex', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={tool.active}
                onChange={async (e) => {
                  const customSelectionTools = [...config.customSelectionTools]
                  customSelectionTools[index] = { ...tool, active: e.target.checked }
                  await updateConfig({ customSelectionTools })
                  refreshContextMenu()
                }}
              />
              {tool.name}
              <div style={{ flexGrow: 1 }} />
              <div style={{ display: 'flex', gap: '12px' }}>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.preventDefault()
                    setEditing(true)
                    setEditingTool(tool)
                    setEditingIndex(index)
                    setErrorMessage('')
                  }}
                >
                  <PencilIcon />
                </div>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={async (e) => {
                    e.preventDefault()
                    const customSelectionTools = [...config.customSelectionTools]
                    customSelectionTools.splice(index, 1)
                    await updateConfig({ customSelectionTools })
                    refreshContextMenu()
                  }}
                >
                  <TrashIcon />
                </div>
              </div>
            </label>
          )),
      )}
      <div style={{ height: '30px' }} />
      {editing ? (
        editingIndex === -1 ? (
          editingComponent
        ) : undefined
      ) : (
        <button
          onClick={(e) => {
            e.preventDefault()
            setEditing(true)
            setEditingTool(defaultTool)
            setEditingIndex(-1)
            setErrorMessage('')
          }}
        >
          {t('New')}
        </button>
      )}
    </>
  )
}
