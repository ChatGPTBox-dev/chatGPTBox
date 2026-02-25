import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  isApiModeSelected,
  modelNameToDesc,
} from '../../utils/index.mjs'
import { PencilIcon, TrashIcon } from '@primer/octicons-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { AlwaysCustomGroups, ModelGroups } from '../../config/index.mjs'
import {
  getCustomOpenAIProviders,
  OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID,
} from '../../services/apis/provider-registry.mjs'
import {
  createProviderId,
  parseChatCompletionsEndpointUrl,
  resolveProviderChatEndpointUrl,
} from './api-modes-provider-utils.mjs'

ApiModes.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

const LEGACY_CUSTOM_PROVIDER_ID = 'legacy-custom-default'

const defaultApiMode = {
  groupName: 'chatgptWebModelKeys',
  itemName: 'chatgptFree35',
  isCustom: false,
  customName: '',
  customUrl: 'http://localhost:8000/v1/chat/completions',
  apiKey: '',
  providerId: '',
  active: true,
}

const defaultProviderDraft = {
  name: '',
  apiUrl: '',
}

const defaultProviderDraftValidation = {
  name: false,
  apiUrl: false,
}

function sanitizeApiModeForSave(apiMode) {
  const nextApiMode = { ...apiMode }
  if (nextApiMode.groupName !== 'customApiModelKeys') {
    nextApiMode.providerId = ''
    nextApiMode.apiKey = ''
    return nextApiMode
  }
  if (!nextApiMode.providerId) nextApiMode.providerId = LEGACY_CUSTOM_PROVIDER_ID
  return nextApiMode
}

export function ApiModes({ config, updateConfig }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editingApiMode, setEditingApiMode] = useState(defaultApiMode)
  const [editingIndex, setEditingIndex] = useState(-1)
  const [apiModes, setApiModes] = useState([])
  const [apiModeStringArray, setApiModeStringArray] = useState([])
  const [customProviders, setCustomProviders] = useState([])
  const [pendingNewProvider, setPendingNewProvider] = useState(null)
  const [providerSelector, setProviderSelector] = useState(LEGACY_CUSTOM_PROVIDER_ID)
  const [isProviderEditorOpen, setIsProviderEditorOpen] = useState(false)
  const [providerEditingId, setProviderEditingId] = useState('')
  const [providerDraft, setProviderDraft] = useState(defaultProviderDraft)
  const [providerDraftValidation, setProviderDraftValidation] = useState(
    defaultProviderDraftValidation,
  )
  const providerNameInputRef = useRef(null)
  const providerBaseUrlInputRef = useRef(null)

  useLayoutEffect(() => {
    const nextApiModes = getApiModesFromConfig(config)
    setApiModes(nextApiModes)
    setApiModeStringArray(nextApiModes.map(apiModeToModelName))
    setCustomProviders(getCustomOpenAIProviders(config))
  }, [
    config.activeApiModes,
    config.customApiModes,
    config.customOpenAIProviders,
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

  const shouldEditProvider = editingApiMode.groupName === 'customApiModelKeys'
  const effectiveProviders = pendingNewProvider
    ? [...customProviders, pendingNewProvider]
    : customProviders
  const selectedCustomProvider = effectiveProviders.find(
    (provider) => provider.id === providerSelector,
  )

  const persistApiMode = (nextApiMode) => {
    const payload = {
      activeApiModes: [],
      customApiModes:
        editingIndex === -1
          ? [...apiModes, nextApiMode]
          : apiModes.map((apiMode, index) => (index === editingIndex ? nextApiMode : apiMode)),
    }
    if (pendingNewProvider) {
      payload.customOpenAIProviders = [...customProviders, pendingNewProvider]
    }
    if (editingIndex !== -1 && isApiModeSelected(apiModes[editingIndex], config)) {
      payload.apiMode = nextApiMode
    }
    updateConfig(payload)
    setPendingNewProvider(null)
  }

  const closeProviderEditor = () => {
    setIsProviderEditorOpen(false)
    setProviderEditingId('')
    setProviderDraft(defaultProviderDraft)
    setProviderDraftValidation(defaultProviderDraftValidation)
  }

  const openCreateProviderEditor = (event) => {
    event.preventDefault()
    setProviderEditingId('')
    setProviderDraft(defaultProviderDraft)
    setProviderDraftValidation(defaultProviderDraftValidation)
    setIsProviderEditorOpen(true)
  }

  const openEditProviderEditor = (event) => {
    event.preventDefault()
    if (!selectedCustomProvider) return
    setProviderEditingId(selectedCustomProvider.id)
    setProviderDraft({
      name: selectedCustomProvider.name || '',
      apiUrl: resolveProviderChatEndpointUrl(selectedCustomProvider),
    })
    setProviderDraftValidation(defaultProviderDraftValidation)
    setIsProviderEditorOpen(true)
  }

  const onSaveProviderEditing = (event) => {
    event.preventDefault()
    const providerName = providerDraft.name.trim()
    const parsedEndpoint = parseChatCompletionsEndpointUrl(providerDraft.apiUrl)
    const nextProviderDraftValidation = {
      name: !providerName,
      apiUrl: !parsedEndpoint.valid,
    }
    if (nextProviderDraftValidation.name || nextProviderDraftValidation.apiUrl) {
      setProviderDraftValidation(nextProviderDraftValidation)
      if (nextProviderDraftValidation.name) {
        providerNameInputRef.current?.focus()
      } else {
        providerBaseUrlInputRef.current?.focus()
      }
      return
    }
    setProviderDraftValidation(defaultProviderDraftValidation)

    if (providerEditingId) {
      if (pendingNewProvider && pendingNewProvider.id === providerEditingId) {
        setPendingNewProvider({
          ...pendingNewProvider,
          name: providerName,
          baseUrl: '',
          chatCompletionsUrl: parsedEndpoint.chatCompletionsUrl,
          completionsUrl: parsedEndpoint.completionsUrl,
        })
      } else {
        const nextCustomProviders = customProviders.map((provider) =>
          provider.id === providerEditingId
            ? {
                ...provider,
                name: providerName,
                baseUrl: '',
                chatCompletionsUrl: parsedEndpoint.chatCompletionsUrl,
                completionsUrl: parsedEndpoint.completionsUrl,
              }
            : provider,
        )
        updateConfig({ customOpenAIProviders: nextCustomProviders })
      }
      closeProviderEditor()
      return
    }

    const providerId = createProviderId(
      providerName,
      effectiveProviders,
      Object.values(OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID),
    )
    const createdProvider = {
      id: providerId,
      name: providerName,
      baseUrl: '',
      chatCompletionsPath: '/v1/chat/completions',
      completionsPath: '/v1/completions',
      chatCompletionsUrl: parsedEndpoint.chatCompletionsUrl,
      completionsUrl: parsedEndpoint.completionsUrl,
      enabled: true,
      allowLegacyResponseField: true,
    }
    setPendingNewProvider(createdProvider)
    setProviderSelector(providerId)
    setEditingApiMode({ ...editingApiMode, providerId })
    closeProviderEditor()
  }

  const onSaveEditing = (event) => {
    event.preventDefault()
    let nextApiMode = { ...editingApiMode }
    const previousProviderId =
      editingIndex === -1 ? '' : apiModes[editingIndex]?.providerId || LEGACY_CUSTOM_PROVIDER_ID

    if (shouldEditProvider) {
      const selectedProviderId = providerSelector || LEGACY_CUSTOM_PROVIDER_ID
      const shouldClearApiKey = editingIndex !== -1 && selectedProviderId !== previousProviderId
      nextApiMode = {
        ...nextApiMode,
        providerId: selectedProviderId,
        customUrl: '',
        apiKey: shouldClearApiKey ? '' : nextApiMode.apiKey,
      }
    }

    persistApiMode(sanitizeApiModeForSave(nextApiMode))
    setEditing(false)
    closeProviderEditor()
  }

  const editingComponent = (
    <div style={{ display: 'flex', flexDirection: 'column', '--spacing': '4px' }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          onClick={(e) => {
            e.preventDefault()
            setEditing(false)
            setPendingNewProvider(null)
          }}
        >
          {t('Cancel')}
        </button>
        <button onClick={onSaveEditing}>{t('Save')}</button>
      </div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'nowrap' }}>
        {t('Type')}
        <select
          value={editingApiMode.groupName}
          onChange={(e) => {
            const groupName = e.target.value
            let itemName = ModelGroups[groupName].value[0]
            const isCustom =
              editingApiMode.itemName === 'custom' && !AlwaysCustomGroups.includes(groupName)
            if (isCustom) itemName = 'custom'
            const providerId =
              groupName === 'customApiModelKeys'
                ? editingApiMode.providerId || LEGACY_CUSTOM_PROVIDER_ID
                : ''
            setEditingApiMode({ ...editingApiMode, groupName, itemName, isCustom, providerId })
            if (groupName === 'customApiModelKeys') {
              setProviderSelector(providerId)
            } else {
              setProviderSelector(LEGACY_CUSTOM_PROVIDER_ID)
              setPendingNewProvider(null)
              closeProviderEditor()
            }
          }}
        >
          {Object.entries(ModelGroups).map(([groupName, { desc }]) => (
            <option key={groupName} value={groupName}>
              {t(desc)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'nowrap' }}>
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
      {shouldEditProvider && (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'nowrap' }}>
          {t('Provider')}
          <select
            value={providerSelector}
            onChange={(e) => {
              const value = e.target.value
              setProviderSelector(value)
              setEditingApiMode({ ...editingApiMode, providerId: value })
              if (isProviderEditorOpen) {
                closeProviderEditor()
              }
              setProviderDraftValidation(defaultProviderDraftValidation)
            }}
          >
            <option value={LEGACY_CUSTOM_PROVIDER_ID}>{t('Custom')}</option>
            {effectiveProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          <button onClick={openCreateProviderEditor}>{t('New')}</button>
          <button onClick={openEditProviderEditor} disabled={!selectedCustomProvider}>
            <PencilIcon />
          </button>
        </div>
      )}
      {shouldEditProvider && isProviderEditorOpen && (
        <>
          <input
            type="text"
            ref={providerNameInputRef}
            value={providerDraft.name}
            placeholder={t('Provider')}
            onChange={(e) => {
              setProviderDraft({ ...providerDraft, name: e.target.value })
              if (providerDraftValidation.name) {
                setProviderDraftValidation({
                  ...providerDraftValidation,
                  name: false,
                })
              }
            }}
            aria-invalid={providerDraftValidation.name}
            style={providerDraftValidation.name ? { borderColor: 'red' } : undefined}
          />
          <input
            type="text"
            ref={providerBaseUrlInputRef}
            value={providerDraft.apiUrl}
            placeholder="https://api.example.com/v1/chat/completions"
            title={t('API Url')}
            onChange={(e) => {
              setProviderDraft({ ...providerDraft, apiUrl: e.target.value })
              if (providerDraftValidation.apiUrl) {
                setProviderDraftValidation({
                  ...providerDraftValidation,
                  apiUrl: false,
                })
              }
            }}
            aria-invalid={providerDraftValidation.apiUrl}
            style={providerDraftValidation.apiUrl ? { borderColor: 'red' } : undefined}
          />
          {providerDraftValidation.apiUrl && (
            <div style={{ color: 'red' }}>{t('Please enter a full Chat Completions URL')}</div>
          )}
          <div style={{ display: 'flex', gap: '12px' }}>
            <button type="button" onClick={closeProviderEditor}>
              {t('Cancel')}
            </button>
            <button type="button" onClick={onSaveProviderEditing}>
              {t('Save')}
            </button>
          </div>
        </>
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
                    const isCustomApiMode = apiMode.groupName === 'customApiModelKeys'
                    const providerId = isCustomApiMode
                      ? apiMode.providerId || LEGACY_CUSTOM_PROVIDER_ID
                      : ''
                    setEditingApiMode({
                      ...defaultApiMode,
                      ...apiMode,
                      providerId,
                    })
                    setProviderSelector(providerId || LEGACY_CUSTOM_PROVIDER_ID)
                    setProviderDraft(defaultProviderDraft)
                    setProviderDraftValidation(defaultProviderDraftValidation)
                    setIsProviderEditorOpen(false)
                    setProviderEditingId('')
                    setPendingNewProvider(null)
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
            setProviderSelector(LEGACY_CUSTOM_PROVIDER_ID)
            setProviderDraft(defaultProviderDraft)
            setProviderDraftValidation(defaultProviderDraftValidation)
            setIsProviderEditorOpen(false)
            setProviderEditingId('')
            setPendingNewProvider(null)
            setEditingIndex(-1)
          }}
        >
          {t('New')}
        </button>
      )}
    </>
  )
}
