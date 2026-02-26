import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'
import {
  apiModeToModelName,
  getApiModesFromConfig,
  isApiModeSelected,
  modelNameToDesc,
} from '../../utils/index.mjs'
import { PencilIcon, TrashIcon } from '@primer/octicons-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlwaysCustomGroups, ModelGroups } from '../../config/index.mjs'
import {
  getCustomOpenAIProviders,
  OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID,
} from '../../services/apis/provider-registry.mjs'
import {
  applySelectedProviderToApiMode,
  applyDeletedProviderSecrets,
  applyPendingProviderChanges,
  buildEditedProvider,
  createProviderId,
  getApiModeDisplayLabel,
  getConfiguredCustomApiModesForSessionRecovery,
  getProviderDeleteDisabledReasonKey,
  getProviderReferenceCheckApiModes,
  getReferencedCustomProviderIdsFromSessions,
  getSelectableProviders,
  isProviderEndpointRewriteBlockedBySavedConversations,
  isProviderDeleteDisabled,
  isProviderReferencedByApiModes,
  loadSavedConversationState,
  persistApiModeConfigUpdate,
  removePendingProviderDeletion,
  resolveEditingProviderSelection,
  resolveEditingProviderIdForGroupChange,
  resolveSelectableProviderId,
  resolveProviderChatEndpointUrl,
  sanitizeApiModeForSave,
  shouldHandleSavedConversationStorageChange,
  shouldIncludeSelectedApiModeInReferenceCheck,
  shouldPersistDeletedProviderChanges,
  shouldPersistPendingProviderChanges,
  shouldRenderApiModeRow,
  validateProviderEndpointDraft,
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
  savedConversations: false,
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
  const [pendingEditedProvidersById, setPendingEditedProvidersById] = useState({})
  const [pendingDeletedProviderIds, setPendingDeletedProviderIds] = useState([])
  const [pendingDeletedProviderSecretIds, setPendingDeletedProviderSecretIds] = useState([])
  const [sessions, setSessions] = useState([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [providerSelector, setProviderSelector] = useState(LEGACY_CUSTOM_PROVIDER_ID)
  const [isProviderEditorOpen, setIsProviderEditorOpen] = useState(false)
  const [providerEditingId, setProviderEditingId] = useState('')
  const [providerDraft, setProviderDraft] = useState(defaultProviderDraft)
  const [providerDraftValidation, setProviderDraftValidation] = useState(
    defaultProviderDraftValidation,
  )
  const [providerSelectionValidation, setProviderSelectionValidation] = useState(false)
  const providerNameInputRef = useRef(null)
  const providerBaseUrlInputRef = useRef(null)
  const providerSelectorRef = useRef(null)

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

  useEffect(() => {
    let isMounted = true

    const updateSessions = (nextSessions) => {
      if (!isMounted) return
      setSessions(Array.isArray(nextSessions) ? nextSessions : [])
      setSessionsLoaded(true)
    }

    loadSavedConversationState(() => Browser.storage.local.get('sessions')).then(
      ({ sessions, sessionsLoaded, error }) => {
        if (!isMounted) return
        if (error) {
          console.error('[popup] Failed to load saved conversations for provider checks', error)
        }
        setSessions(Array.isArray(sessions) ? sessions : [])
        setSessionsLoaded(sessionsLoaded)
      },
    )

    const listener = (changes, areaName) => {
      if (!shouldHandleSavedConversationStorageChange(changes, areaName)) return
      updateSessions(changes.sessions?.newValue)
    }
    Browser.storage.onChanged.addListener(listener)
    return () => {
      isMounted = false
      Browser.storage.onChanged.removeListener(listener)
    }
  }, [])

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
  const effectiveProviders = useMemo(
    () =>
      applyPendingProviderChanges(
        customProviders,
        pendingEditedProvidersById,
        pendingNewProvider,
        pendingDeletedProviderIds,
      ),
    [customProviders, pendingEditedProvidersById, pendingNewProvider, pendingDeletedProviderIds],
  )
  const selectedCustomProvider = effectiveProviders.find(
    (provider) => provider.id === providerSelector,
  )
  const hasPendingProviderChanges =
    Boolean(pendingNewProvider) ||
    Object.keys(pendingEditedProvidersById).length > 0 ||
    pendingDeletedProviderIds.length > 0

  const apiModesForProviderReferenceCheck = useMemo(() => {
    const referenceCheckApiModes = getProviderReferenceCheckApiModes(
      apiModes,
      editing,
      editingIndex,
    )
    if (
      shouldIncludeSelectedApiModeInReferenceCheck(apiModes, editing, editingIndex, config.apiMode)
    ) {
      return [...referenceCheckApiModes, config.apiMode]
    }
    return referenceCheckApiModes
  }, [apiModes, editing, editingIndex, config.apiMode])

  const configuredCustomApiModesForSessionRecovery = useMemo(() => {
    const recoveryApiModes = getProviderReferenceCheckApiModes(apiModes, editing, editingIndex)
    const recoverySelectedApiMode = shouldIncludeSelectedApiModeInReferenceCheck(
      apiModes,
      editing,
      editingIndex,
      config.apiMode,
    )
      ? config.apiMode
      : editingApiMode

    return getConfiguredCustomApiModesForSessionRecovery(recoveryApiModes, recoverySelectedApiMode)
  }, [apiModes, config.apiMode, editing, editingApiMode, editingIndex])

  const configuredCustomApiModesForSaveGuard = useMemo(() => {
    let nextApiModes = apiModes
    if (editing && editingIndex !== -1) {
      nextApiModes = apiModes.map((apiMode, index) =>
        index === editingIndex ? editingApiMode : apiMode,
      )
    } else if (
      editing &&
      editingIndex === -1 &&
      editingApiMode.groupName === 'customApiModelKeys'
    ) {
      nextApiModes = [...apiModes, editingApiMode]
    }
    const nextSelectedApiMode =
      editing && editingIndex !== -1 && isApiModeSelected(apiModes[editingIndex], config)
        ? editingApiMode
        : config.apiMode

    return getConfiguredCustomApiModesForSessionRecovery(nextApiModes, nextSelectedApiMode)
  }, [apiModes, config, editing, editingApiMode, editingIndex])

  const sessionReferencedProviderIds = useMemo(
    () =>
      getReferencedCustomProviderIdsFromSessions(
        sessions,
        customProviders,
        configuredCustomApiModesForSessionRecovery,
      ),
    [sessions, customProviders, configuredCustomApiModesForSessionRecovery],
  )

  const isEditedProviderReferenced =
    Boolean(providerEditingId) &&
    (isProviderReferencedByApiModes(providerEditingId, apiModesForProviderReferenceCheck) ||
      sessionReferencedProviderIds.includes(providerEditingId))
  const isDeleteProviderDisabled = isProviderDeleteDisabled(
    isEditedProviderReferenced,
    sessionsLoaded,
  )
  const providerDeleteDisabledReasonKey = getProviderDeleteDisabledReasonKey(
    isEditedProviderReferenced,
    sessionsLoaded,
  )

  const clearPendingProviderChanges = () => {
    setPendingNewProvider(null)
    setPendingEditedProvidersById({})
    setPendingDeletedProviderIds([])
    setPendingDeletedProviderSecretIds([])
  }

  const persistApiMode = async (nextApiMode) => {
    const payload = {
      activeApiModes: [],
      customApiModes:
        editingIndex === -1
          ? [...apiModes, nextApiMode]
          : apiModes.map((apiMode, index) => (index === editingIndex ? nextApiMode : apiMode)),
    }
    if (
      shouldPersistPendingProviderChanges(hasPendingProviderChanges) ||
      shouldPersistDeletedProviderChanges(pendingDeletedProviderIds)
    ) {
      payload.customOpenAIProviders = effectiveProviders
      if (pendingDeletedProviderSecretIds.length > 0) {
        payload.providerSecrets = applyDeletedProviderSecrets(
          config.providerSecrets,
          pendingDeletedProviderSecretIds,
        )
      }
    }
    if (editingIndex !== -1 && isApiModeSelected(apiModes[editingIndex], config)) {
      payload.apiMode = nextApiMode
    }
    await persistApiModeConfigUpdate(updateConfig, payload, clearPendingProviderChanges)
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
    const existingProvider =
      pendingNewProvider && pendingNewProvider.id === providerEditingId
        ? pendingNewProvider
        : selectedCustomProvider || {}
    const persistedProvider = customProviders.find((provider) => provider.id === providerEditingId)
    const endpointDraft = validateProviderEndpointDraft(providerDraft.apiUrl)
    const parsedEndpoint = endpointDraft.parsedEndpoint
    const providerEndpointChanged =
      Boolean(providerEditingId) &&
      Boolean(persistedProvider) &&
      parsedEndpoint.valid &&
      parsedEndpoint.chatCompletionsUrl !== resolveProviderChatEndpointUrl(persistedProvider)
    const effectiveProviderSecrets =
      pendingDeletedProviderSecretIds.length > 0
        ? applyDeletedProviderSecrets(config.providerSecrets, pendingDeletedProviderSecretIds)
        : config.providerSecrets
    const nextProviderDraftValidation = {
      name: !providerName,
      apiUrl: !endpointDraft.valid,
      savedConversations:
        providerEndpointChanged &&
        isProviderEndpointRewriteBlockedBySavedConversations(
          providerEditingId,
          sessionsLoaded,
          sessions,
          effectiveProviders,
          configuredCustomApiModesForSaveGuard,
          effectiveProviderSecrets,
        ),
    }
    if (
      nextProviderDraftValidation.name ||
      nextProviderDraftValidation.apiUrl ||
      nextProviderDraftValidation.savedConversations
    ) {
      setProviderDraftValidation(nextProviderDraftValidation)
      if (nextProviderDraftValidation.name) {
        providerNameInputRef.current?.focus()
      } else {
        providerBaseUrlInputRef.current?.focus()
      }
      return
    }
    setProviderDraftValidation(defaultProviderDraftValidation)
    const editedProvider = providerEditingId
      ? buildEditedProvider(
          existingProvider,
          providerEditingId,
          providerName,
          parsedEndpoint,
          providerDraft.apiUrl,
        )
      : null

    if (providerEditingId) {
      if (pendingNewProvider && pendingNewProvider.id === providerEditingId) {
        setPendingNewProvider(editedProvider)
      } else {
        setPendingEditedProvidersById((currentProviders) => ({
          ...currentProviders,
          [providerEditingId]: editedProvider,
        }))
      }
      closeProviderEditor()
      return
    }

    const providerId = createProviderId(providerName, effectiveProviders, [
      ...Object.values(OPENAI_COMPATIBLE_GROUP_TO_PROVIDER_ID),
      ...pendingDeletedProviderIds,
    ])
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
    setProviderSelectionValidation(false)
    setEditingApiMode({ ...editingApiMode, providerId })
    closeProviderEditor()
  }

  const onDeleteProviderEditing = (event) => {
    event.preventDefault()
    if (!providerEditingId || isDeleteProviderDisabled) return
    const isDeletingPersistedProvider = customProviders.some(
      (provider) => provider.id === providerEditingId,
    )

    if (pendingNewProvider && pendingNewProvider.id === providerEditingId) {
      setPendingNewProvider(null)
    }
    setPendingEditedProvidersById((currentProviders) => {
      if (!currentProviders[providerEditingId]) return currentProviders
      const nextProviders = { ...currentProviders }
      delete nextProviders[providerEditingId]
      return nextProviders
    })
    if (isDeletingPersistedProvider) {
      setPendingDeletedProviderIds((currentProviderIds) => [
        ...removePendingProviderDeletion(currentProviderIds, providerEditingId),
        providerEditingId,
      ])
      setPendingDeletedProviderSecretIds((currentProviderIds) => [
        ...removePendingProviderDeletion(currentProviderIds, providerEditingId),
        providerEditingId,
      ])
    } else {
      setPendingDeletedProviderIds((currentProviderIds) =>
        removePendingProviderDeletion(currentProviderIds, providerEditingId),
      )
      setPendingDeletedProviderSecretIds((currentProviderIds) =>
        removePendingProviderDeletion(currentProviderIds, providerEditingId),
      )
    }

    if (providerSelector === providerEditingId) {
      setProviderSelector('')
      setProviderSelectionValidation(true)
    }
    if (editingApiMode.providerId === providerEditingId) {
      setEditingApiMode({
        ...editingApiMode,
        providerId: '',
      })
    }
    closeProviderEditor()
  }

  const onSaveEditing = async (event) => {
    event.preventDefault()
    let nextApiMode = { ...editingApiMode }
    const previousProviderId =
      editingIndex === -1 ? '' : apiModes[editingIndex]?.providerId || LEGACY_CUSTOM_PROVIDER_ID

    if (shouldEditProvider) {
      const selectedProviderId =
        providerSelector === LEGACY_CUSTOM_PROVIDER_ID
          ? LEGACY_CUSTOM_PROVIDER_ID
          : resolveSelectableProviderId(providerSelector, effectiveProviders, '')
      if (!selectedProviderId) {
        setProviderSelectionValidation(true)
        providerSelectorRef.current?.focus()
        return
      }
      const shouldClearProviderDerivedFields =
        editingIndex !== -1 && selectedProviderId !== previousProviderId
      const isEndpointProviderManaged = editingIndex === -1
      nextApiMode = applySelectedProviderToApiMode(
        nextApiMode,
        selectedProviderId,
        shouldClearProviderDerivedFields,
        isEndpointProviderManaged,
      )
    }

    try {
      await persistApiMode(sanitizeApiModeForSave(nextApiMode))
      setEditing(false)
      closeProviderEditor()
    } catch (error) {
      console.error('[popup] Failed to persist API mode changes', error)
    }
  }

  const editingComponent = (
    <div style={{ display: 'flex', flexDirection: 'column', '--spacing': '4px' }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          onClick={(e) => {
            e.preventDefault()
            setEditing(false)
            clearPendingProviderChanges()
            closeProviderEditor()
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
            const providerId = resolveEditingProviderIdForGroupChange(
              groupName,
              editingApiMode.providerId,
              LEGACY_CUSTOM_PROVIDER_ID,
            )
            setProviderSelectionValidation(false)
            setEditingApiMode({ ...editingApiMode, groupName, itemName, isCustom, providerId })
            if (groupName === 'customApiModelKeys') {
              setProviderSelector(providerId)
            } else {
              setProviderSelector(LEGACY_CUSTOM_PROVIDER_ID)
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
            ref={providerSelectorRef}
            value={providerSelector}
            onChange={(e) => {
              const value = e.target.value
              setProviderSelector(value)
              setProviderSelectionValidation(false)
              setEditingApiMode({ ...editingApiMode, providerId: value })
              if (isProviderEditorOpen) {
                closeProviderEditor()
              }
              setProviderDraftValidation(defaultProviderDraftValidation)
            }}
            aria-invalid={providerSelectionValidation}
            style={providerSelectionValidation ? { borderColor: 'red' } : undefined}
          >
            <option value="">{t('Select a provider')}</option>
            <option value={LEGACY_CUSTOM_PROVIDER_ID}>{t('Custom Provider')}</option>
            {getSelectableProviders(effectiveProviders).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          <button onClick={openCreateProviderEditor}>{t('New')}</button>
          <button onClick={openEditProviderEditor} disabled={!selectedCustomProvider}>
            {t('Edit')}
          </button>
        </div>
      )}
      {shouldEditProvider && providerSelectionValidation && (
        <div style={{ color: 'red' }}>{t('Please select a provider')}</div>
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
              if (providerDraftValidation.name || providerDraftValidation.savedConversations) {
                setProviderDraftValidation({
                  ...providerDraftValidation,
                  name: false,
                  savedConversations: false,
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
              if (providerDraftValidation.apiUrl || providerDraftValidation.savedConversations) {
                setProviderDraftValidation({
                  ...providerDraftValidation,
                  apiUrl: false,
                  savedConversations: false,
                })
              }
            }}
            aria-invalid={providerDraftValidation.apiUrl}
            style={providerDraftValidation.apiUrl ? { borderColor: 'red' } : undefined}
          />
          {providerDraftValidation.apiUrl && (
            <div style={{ color: 'red' }}>{t('Please enter a full Chat Completions URL')}</div>
          )}
          {providerDraftValidation.savedConversations && (
            <div style={{ color: 'red' }}>
              {t(
                sessionsLoaded
                  ? 'This provider endpoint is still needed by saved conversations'
                  : 'Loading saved conversations…',
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: '12px' }}>
            <button type="button" onClick={closeProviderEditor}>
              {t('Cancel')}
            </button>
            <button type="button" onClick={onSaveProviderEditing}>
              {t('Save')}
            </button>
            {providerEditingId && (
              <span
                title={providerDeleteDisabledReasonKey ? t(providerDeleteDisabledReasonKey) : ''}
                style={{ display: 'inline-block' }}
              >
                <button
                  type="button"
                  onClick={onDeleteProviderEditing}
                  disabled={isDeleteProviderDisabled}
                >
                  {t('Delete')}
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )

  return (
    <>
      {apiModes.map(
        (apiMode, index) =>
          shouldRenderApiModeRow(apiMode) &&
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
              {getApiModeDisplayLabel(apiMode, t, effectiveProviders)}
              <div style={{ flexGrow: 1 }} />
              <div style={{ display: 'flex', gap: '12px' }}>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.preventDefault()
                    setEditing(true)
                    const isCustomApiMode = apiMode.groupName === 'customApiModelKeys'
                    const providerId = isCustomApiMode
                      ? resolveEditingProviderSelection(
                          apiMode.providerId,
                          effectiveProviders,
                          LEGACY_CUSTOM_PROVIDER_ID,
                        )
                      : ''
                    setEditingApiMode({
                      ...defaultApiMode,
                      ...apiMode,
                      providerId,
                    })
                    setProviderSelector(isCustomApiMode ? providerId : LEGACY_CUSTOM_PROVIDER_ID)
                    setProviderSelectionValidation(isCustomApiMode && !providerId)
                    setProviderDraft(defaultProviderDraft)
                    setProviderDraftValidation(defaultProviderDraftValidation)
                    setIsProviderEditorOpen(false)
                    setProviderEditingId('')
                    clearPendingProviderChanges()
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
            setProviderSelectionValidation(false)
            setProviderDraft(defaultProviderDraft)
            setProviderDraftValidation(defaultProviderDraftValidation)
            setIsProviderEditorOpen(false)
            setProviderEditingId('')
            clearPendingProviderChanges()
            setEditingIndex(-1)
          }}
        >
          {t('New')}
        </button>
      )}
    </>
  )
}
