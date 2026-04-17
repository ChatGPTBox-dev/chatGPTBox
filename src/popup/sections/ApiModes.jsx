import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  isApiModeSelected,
  modelNameToDesc,
} from '../../utils/index.mjs'
import { PencilIcon, TrashIcon } from '@primer/octicons-react'
import { useLayoutEffect, useState } from 'react'
import {
  AlwaysCustomGroups,
  CustomApiKeyGroups,
  CustomUrlGroups,
  ModelGroups,
} from '../../config/index.mjs'

ApiModes.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

const defaultApiMode = {
  groupName: 'chatgptWebModelKeys',
  itemName: 'chatgptFree35',
  isCustom: false,
  customName: '',
  customUrl: 'http://localhost:8000/v1/chat/completions',
  apiKey: '',
  active: true,
}

export function ApiModes({ config, updateConfig }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editingApiMode, setEditingApiMode] = useState(defaultApiMode)
  const [editingIndex, setEditingIndex] = useState(-1)
  const [apiModes, setApiModes] = useState([])
  const [apiModeStringArray, setApiModeStringArray] = useState([])

  useLayoutEffect(() => {
    const apiModes = getApiModesFromConfig(config)
    setApiModes(apiModes)
    setApiModeStringArray(apiModes.map(apiModeToModelName))
  }, [
    config.activeApiModes,
    config.customApiModes,
    config.azureDeploymentName,
    config.ollamaModelName,
  ])

  const updateWhenApiModeDisabled = (apiMode) => {
    if (isApiModeSelected(apiMode, config))
      updateConfig({
        modelName:
          apiModeStringArray.includes(config.modelName) &&
          config.modelName !== apiModeToModelName(apiMode)
            ? config.modelName
            : 'customModel',
        apiMode: null,
      })
  }

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
          onClick={(e) => {
            e.preventDefault()
            if (editingIndex === -1) {
              updateConfig({
                activeApiModes: [],
                customApiModes: [...apiModes, editingApiMode],
              })
            } else {
              const apiMode = apiModes[editingIndex]
              if (isApiModeSelected(apiMode, config)) updateConfig({ apiMode: editingApiMode })
              const customApiModes = [...apiModes]
              customApiModes[editingIndex] = editingApiMode
              updateConfig({ activeApiModes: [], customApiModes })
            }
            setEditing(false)
          }}
        >
          {t('Save')}
        </button>
      </div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'noWrap' }}>
        {t('Type')}
        <select
          value={editingApiMode.groupName}
          onChange={(e) => {
            const groupName = e.target.value
            let itemName = ModelGroups[groupName].value[0]
            const isCustom =
              editingApiMode.itemName === 'custom' && !AlwaysCustomGroups.includes(groupName)
            if (isCustom) itemName = 'custom'
            setEditingApiMode({ ...editingApiMode, groupName, itemName, isCustom })
          }}
        >
          {Object.entries(ModelGroups).map(([groupName, { desc }]) => (
            <option key={groupName} value={groupName}>
              {t(desc)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'noWrap' }}>
        {t('Mode')}
        <select
          value={editingApiMode.itemName}
          onChange={(e) => {
            const itemName = e.target.value
            const isCustom = itemName === 'custom'
            setEditingApiMode({ ...editingApiMode, itemName, isCustom })
          }}
        >
          {ModelGroups[editingApiMode.groupName].value.map((itemName) => (
            <option key={itemName} value={itemName}>
              {modelNameToDesc(itemName, t)}
            </option>
          ))}
          {!AlwaysCustomGroups.includes(editingApiMode.groupName) && (
            <option value="custom">{t('Custom')}</option>
          )}
        </select>
        {(editingApiMode.isCustom || AlwaysCustomGroups.includes(editingApiMode.groupName)) && (
          <input
            type="text"
            value={editingApiMode.customName}
            placeholder={t('Model Name')}
            onChange={(e) => setEditingApiMode({ ...editingApiMode, customName: e.target.value })}
          />
        )}
      </div>
      {CustomUrlGroups.includes(editingApiMode.groupName) &&
        (editingApiMode.isCustom || AlwaysCustomGroups.includes(editingApiMode.groupName)) && (
          <input
            type="text"
            value={editingApiMode.customUrl}
            placeholder={t('API Url')}
            onChange={(e) => setEditingApiMode({ ...editingApiMode, customUrl: e.target.value })}
          />
        )}
      {CustomApiKeyGroups.includes(editingApiMode.groupName) &&
        (editingApiMode.isCustom || AlwaysCustomGroups.includes(editingApiMode.groupName)) && (
          <input
            type="password"
            value={editingApiMode.apiKey}
            placeholder={t('API Key')}
            onChange={(e) => setEditingApiMode({ ...editingApiMode, apiKey: e.target.value })}
          />
        )}
    </div>
  )

  return (
    <>
      {apiModes.map(
        (apiMode, index) =>
          apiMode.groupName &&
          apiMode.itemName &&
          (editing && editingIndex === index ? (
            editingComponent
          ) : (
            <label key={index} style={{ display: 'flex', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={apiMode.active}
                onChange={(e) => {
                  if (!e.target.checked) updateWhenApiModeDisabled(apiMode)
                  const customApiModes = [...apiModes]
                  customApiModes[index] = { ...apiMode, active: e.target.checked }
                  updateConfig({ activeApiModes: [], customApiModes })
                }}
              />
              {modelNameToDesc(apiModeToModelName(apiMode), t)}
              <div style={{ flexGrow: 1 }} />
              <div style={{ display: 'flex', gap: '12px' }}>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.preventDefault()
                    setEditing(true)
                    setEditingApiMode(apiMode)
                    setEditingIndex(index)
                  }}
                >
                  <PencilIcon />
                </div>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.preventDefault()
                    updateWhenApiModeDisabled(apiMode)
                    const customApiModes = [...apiModes]
                    customApiModes.splice(index, 1)
                    updateConfig({ activeApiModes: [], customApiModes })
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
            setEditingApiMode(defaultApiMode)
            setEditingIndex(-1)
          }}
        >
          {t('New')}
        </button>
      )}
    </>
  )
}
