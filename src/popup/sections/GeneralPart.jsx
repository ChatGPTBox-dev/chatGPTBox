import { useTranslation } from 'react-i18next'
import { useLayoutEffect, useRef, useState } from 'react'
import FileSaver from 'file-saver'
import { isApiModeSelected, getApiModesFromConfig } from '../../utils/index.mjs'
import {
  isUsingAzureOpenAiApiModel,
  isUsingClaudeApiModel,
  isUsingCustomModel,
  isUsingOllamaApiModel,
  isUsingGithubThirdPartyApiModel,
  isUsingMultiModeModel,
  ModelMode,
  ThemeMode,
  TriggerMode,
  Models,
} from '../../config/index.mjs'
import Browser from 'webextension-polyfill'
import { languageList } from '../../config/language.mjs'
import PropTypes from 'prop-types'
import { config as menuConfig } from '../../content-script/menu-tools'
import { PencilIcon } from '@primer/octicons-react'
import { importDataIntoStorage } from './import-data-cleanup.mjs'
import { resolveOpenAICompatibleRequest } from '../../services/apis/provider-registry.mjs'
import { getApiModeDisplayLabel } from './api-modes-provider-utils.mjs'
import {
  buildProviderOverrideFinalConfigUpdate,
  createProviderApiKeyDraftSelectionSignature,
  resolveOverrideCommitContext,
  resolveCommittedMigratedSessions,
  resolveCommittedOverrideSourceProvider,
  resolvePersistedProviderApiKeyForSelection,
  shouldResetProviderApiKeyDraftAfterPersistFailure,
} from './general-provider-override-utils.mjs'
import {
  buildSelectedModeProviderSecretOverrideUpdate,
  buildProviderSecretUpdate,
  createProviderSecretOverrideCommitSelectionSignature,
  hasSelectedModeOwnProviderSecretOverride,
  resolveProviderSecretTargetId,
  rollbackProviderSecretOverrideSessionMigration,
} from './provider-secret-utils.mjs'

GeneralPart.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
  getPersistedConfig: PropTypes.func.isRequired,
  getCommittedConfig: PropTypes.func.isRequired,
  setTabIndex: PropTypes.func.isRequired,
}

function isUsingSpecialCustomModel(configOrSession) {
  return isUsingCustomModel(configOrSession) && !configOrSession.apiMode
}

function getProviderApiKeySetupUrl(providerId) {
  switch (String(providerId || '').trim()) {
    case 'openai':
      return 'https://platform.openai.com/account/api-keys'
    case 'moonshot':
      return 'https://platform.moonshot.cn/console/api-keys'
    default:
      return ''
  }
}

function normalizeLoadedSessionsResult(stored) {
  return {
    ok: true,
    sessions: Array.isArray(stored?.sessions) ? stored.sessions : [],
  }
}

function isOverrideCommitCurrent(
  commitGeneration,
  currentGeneration,
  commitSelectionSignature,
  currentSelectionSignature,
) {
  return (
    commitGeneration === currentGeneration && commitSelectionSignature === currentSelectionSignature
  )
}

export function GeneralPart({
  config,
  updateConfig,
  getPersistedConfig,
  getCommittedConfig,
  setTabIndex,
}) {
  const { t, i18n } = useTranslation()
  const [apiModes, setApiModes] = useState([])
  const [providerApiKeyDraft, setProviderApiKeyDraft] = useState('')
  const [isOverrideProviderKeyActionPending, setIsOverrideProviderKeyActionPending] =
    useState(false)

  useLayoutEffect(() => {
    setApiModes(getApiModesFromConfig(config, true))
  }, [
    config.activeApiModes,
    config.customApiModes,
    config.azureDeploymentName,
    config.ollamaModelName,
  ])

  const selectedProviderSession =
    config.apiMode && typeof config.apiMode === 'object'
      ? { apiMode: config.apiMode }
      : { modelName: config.modelName }
  const selectedProviderRequest = resolveOpenAICompatibleRequest(config, selectedProviderSession)
  const selectedProviderId = selectedProviderRequest?.providerId || ''
  const selectedProviderSecretTargetId = resolveProviderSecretTargetId(selectedProviderRequest)
  const selectedProviderApiKey = selectedProviderRequest?.apiKey || ''
  const normalizedProviderApiKeyDraft = String(providerApiKeyDraft || '').trim()
  const normalizedSelectedProviderApiKey = String(selectedProviderApiKey || '').trim()
  const isUsingOpenAICompatibleProvider = Boolean(selectedProviderRequest)
  const isSelectedProviderKeyManagedByModeOverride = hasSelectedModeOwnProviderSecretOverride(
    config,
    selectedProviderSecretTargetId,
  )
  const selectedProviderApiKeySetupUrl = getProviderApiKeySetupUrl(selectedProviderId)
  const selectedOverrideCommitSelectionSignature =
    createProviderSecretOverrideCommitSelectionSignature(
      selectedProviderSecretTargetId,
      config.apiMode,
    )
  const providerApiKeySelectionSignature = createProviderApiKeyDraftSelectionSignature(
    selectedProviderId,
    selectedProviderSecretTargetId,
  )
  const overrideCommitGenerationRef = useRef(0)
  const overrideCommitPendingCountRef = useRef(0)
  const overrideCommitQueueRef = useRef(Promise.resolve())
  const overrideCommitSelectionSignatureRef = useRef(selectedOverrideCommitSelectionSignature)
  const providerApiKeySelectionSignatureRef = useRef(providerApiKeySelectionSignature)
  const providerApiKeyDraftRef = useRef(providerApiKeyDraft)
  const isMountedRef = useRef(false)

  useLayoutEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    overrideCommitSelectionSignatureRef.current = selectedOverrideCommitSelectionSignature
    overrideCommitGenerationRef.current += 1
  }, [selectedOverrideCommitSelectionSignature])

  useLayoutEffect(() => {
    providerApiKeySelectionSignatureRef.current = providerApiKeySelectionSignature
  }, [providerApiKeySelectionSignature])

  useLayoutEffect(() => {
    providerApiKeyDraftRef.current = providerApiKeyDraft
  }, [providerApiKeyDraft])

  useLayoutEffect(() => {
    setProviderApiKeyDraft(selectedProviderApiKey)
  }, [selectedProviderApiKey, selectedProviderId, selectedProviderSecretTargetId])

  const loadLatestSessions = async () => {
    try {
      const stored = await Browser.storage.local.get('sessions')
      return normalizeLoadedSessionsResult(stored)
    } catch {
      return { ok: false, sessions: [] }
    }
  }

  const commitSelectedModeProviderKeyOverride = async (nextApiKey) => {
    const normalizedNextApiKey = String(nextApiKey || '').trim()
    overrideCommitPendingCountRef.current += 1
    if (isMountedRef.current) {
      setIsOverrideProviderKeyActionPending(true)
    }
    const commitGeneration = ++overrideCommitGenerationRef.current
    const commitSelectionSignature = selectedOverrideCommitSelectionSignature
    const runCommit = async () => {
      try {
        const { committedConfig, existingProviders } = await resolveOverrideCommitContext(
          getCommittedConfig,
          selectedProviderId,
        )
        if (
          !isOverrideCommitCurrent(
            commitGeneration,
            overrideCommitGenerationRef.current,
            commitSelectionSignature,
            overrideCommitSelectionSignatureRef.current,
          )
        ) {
          return
        }
        const { overrideSourceProvider } = resolveCommittedOverrideSourceProvider(
          committedConfig,
          selectedProviderSecretTargetId,
        )

        if (!overrideSourceProvider) {
          console.warn('[popup] Selected provider disappeared before provider override commit')
          return
        }

        const { configUpdate, sessionMigration, cleanupCandidateProviderId } =
          buildSelectedModeProviderSecretOverrideUpdate(
            committedConfig,
            selectedProviderSecretTargetId,
            normalizedNextApiKey,
            overrideSourceProvider,
            existingProviders,
          )

        const committedSessionsResult = await resolveCommittedMigratedSessions(
          loadLatestSessions,
          sessionMigration,
        )
        if (!committedSessionsResult.ok) {
          return
        }
        const latestSessions = committedSessionsResult.sessions
        const updatedSessions = committedSessionsResult.migratedSessions
        if (
          !isOverrideCommitCurrent(
            commitGeneration,
            overrideCommitGenerationRef.current,
            commitSelectionSignature,
            overrideCommitSelectionSignatureRef.current,
          )
        ) {
          return
        }

        if (updatedSessions !== latestSessions) {
          try {
            await Browser.storage.local.set({ sessions: updatedSessions })
          } catch (error) {
            console.error(
              '[popup] Failed to persist migrated sessions for provider override',
              error,
            )
            return
          }
        }

        const rollbackMigratedSessions = async (message, error) => {
          if (updatedSessions === latestSessions || !sessionMigration) return
          if (error) {
            console.error(message, error)
          } else {
            console.error(message)
          }

          const currentSessionsResult = await loadLatestSessions()
          if (!currentSessionsResult.ok) {
            console.error(
              '[popup] Failed to reload sessions for provider override selective rollback',
            )
            return
          }
          const rolledBackSessions = rollbackProviderSecretOverrideSessionMigration(
            currentSessionsResult.sessions,
            latestSessions,
            sessionMigration,
          )
          if (rolledBackSessions === currentSessionsResult.sessions) return
          try {
            await Browser.storage.local.set({ sessions: rolledBackSessions })
          } catch (rollbackError) {
            console.error(
              '[popup] Failed to persist selective rollback for provider override sessions',
              rollbackError,
            )
          }
        }

        const shouldPreserveCurrentSelection = !isOverrideCommitCurrent(
          commitGeneration,
          overrideCommitGenerationRef.current,
          commitSelectionSignature,
          overrideCommitSelectionSignatureRef.current,
        )
        const finalConfigUpdate = buildProviderOverrideFinalConfigUpdate(
          cleanupCandidateProviderId,
          committedConfig,
          configUpdate,
          updatedSessions,
          shouldPreserveCurrentSelection,
        )
        if (Object.keys(finalConfigUpdate).length === 0) {
          await rollbackMigratedSessions(
            '[popup] Provider override produced no config update; attempting selective session rollback',
          )
          return
        }
        try {
          await updateConfig(finalConfigUpdate, { propagateError: true })
        } catch (error) {
          await rollbackMigratedSessions(
            '[popup] Failed to persist provider override config update; attempting selective session rollback',
            error,
          )
          return
        }
      } finally {
        overrideCommitPendingCountRef.current = Math.max(
          0,
          overrideCommitPendingCountRef.current - 1,
        )
        if (isMountedRef.current && overrideCommitPendingCountRef.current === 0) {
          setIsOverrideProviderKeyActionPending(false)
        }
      }
    }
    const commitPromise = overrideCommitQueueRef.current.then(runCommit)
    overrideCommitQueueRef.current = commitPromise.catch(() => {})
    await commitPromise
  }

  const commitProviderApiKeyDraft = async (nextApiKey) => {
    if (!selectedProviderId) return
    const commitSelectionSignature = providerApiKeySelectionSignature
    const commitDraft = String(nextApiKey || '')
    const commitSelectedProviderSession =
      selectedProviderSession?.apiMode && typeof selectedProviderSession.apiMode === 'object'
        ? { apiMode: { ...selectedProviderSession.apiMode } }
        : { modelName: selectedProviderSession?.modelName }
    const normalizedNextApiKey = String(nextApiKey || '').trim()
    if (normalizedNextApiKey === normalizedSelectedProviderApiKey) {
      if (nextApiKey !== selectedProviderApiKey) {
        setProviderApiKeyDraft(selectedProviderApiKey)
      }
      return
    }

    if (isSelectedProviderKeyManagedByModeOverride) {
      if (!normalizedNextApiKey) {
        overrideCommitGenerationRef.current += 1
        return
      }
      return
    }

    const result = await updateConfig(
      buildProviderSecretUpdate(config, selectedProviderSecretTargetId, normalizedNextApiKey),
    )
    if (
      !result?.ok &&
      shouldResetProviderApiKeyDraftAfterPersistFailure(
        providerApiKeySelectionSignatureRef.current,
        commitSelectionSignature,
        providerApiKeyDraftRef.current,
        commitDraft,
      )
    ) {
      const persistedProviderApiKey = resolvePersistedProviderApiKeyForSelection(
        getPersistedConfig(),
        commitSelectedProviderSession,
      )
      if (isMountedRef.current) {
        setProviderApiKeyDraft(persistedProviderApiKey)
      }
    }
  }

  const handleProviderApiKeyDraftChange = (nextApiKey) => {
    setProviderApiKeyDraft(nextApiKey)
  }

  const handleProviderOverrideActionMouseDown = (e) => {
    e.preventDefault()
  }

  const handleProviderApiKeyBlur = (e) => {
    if (isSelectedProviderKeyManagedByModeOverride) {
      if (e.relatedTarget?.closest?.('[data-provider-key-action]')) return
      if (providerApiKeyDraft !== selectedProviderApiKey) {
        setProviderApiKeyDraft(selectedProviderApiKey)
      }
      return
    }
    void commitProviderApiKeyDraft(providerApiKeyDraft)
  }

  const handleSaveProviderKeyOverride = () => {
    if (
      !selectedProviderSecretTargetId ||
      !isSelectedProviderKeyManagedByModeOverride ||
      isOverrideProviderKeyActionPending ||
      normalizedProviderApiKeyDraft.length === 0 ||
      normalizedProviderApiKeyDraft === normalizedSelectedProviderApiKey
    ) {
      return
    }
    void commitSelectedModeProviderKeyOverride(providerApiKeyDraft)
  }

  const handleUseSharedProviderKey = () => {
    if (
      !selectedProviderSecretTargetId ||
      !isSelectedProviderKeyManagedByModeOverride ||
      isOverrideProviderKeyActionPending
    )
      return
    setProviderApiKeyDraft('')
    void commitSelectedModeProviderKeyOverride('')
  }

  const handleProviderApiKeyInputKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (isSelectedProviderKeyManagedByModeOverride) {
      e.preventDefault()
      handleSaveProviderKeyOverride()
      return
    }
    e.currentTarget.blur()
  }

  return (
    <>
      <label>
        <legend>{t('Triggers')}</legend>
        <select
          required
          onChange={(e) => {
            const mode = e.target.value
            updateConfig({ triggerMode: mode })
          }}
        >
          {Object.entries(TriggerMode).map(([key, desc]) => {
            return (
              <option value={key} key={key} selected={key === config.triggerMode}>
                {t(desc)}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <legend>{t('Theme')}</legend>
        <select
          required
          onChange={(e) => {
            const mode = e.target.value
            updateConfig({ themeMode: mode })
          }}
        >
          {Object.entries(ThemeMode).map(([key, desc]) => {
            return (
              <option value={key} key={key} selected={key === config.themeMode}>
                {t(desc)}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <legend style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {t('API Mode')}
          <div
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.preventDefault()
              setTabIndex(2)
            }}
          >
            <PencilIcon />
          </div>
        </legend>
        <span style="display: flex; gap: 15px;">
          <select
            style={
              isUsingOpenAICompatibleProvider ||
              isUsingMultiModeModel(config) ||
              isUsingSpecialCustomModel(config) ||
              isUsingAzureOpenAiApiModel(config) ||
              isUsingClaudeApiModel(config)
                ? 'width: 50%;'
                : undefined
            }
            required
            onChange={(e) => {
              if (e.target.value === '-1') {
                updateConfig({ modelName: 'customModel', apiMode: null })
                return
              }
              const apiMode = apiModes[e.target.value]
              updateConfig({ apiMode: apiMode })
            }}
          >
            {apiModes.map((apiMode, index) => {
              const desc = getApiModeDisplayLabel(
                apiMode,
                t,
                Array.isArray(config.customOpenAIProviders) ? config.customOpenAIProviders : [],
              )
              if (desc) {
                return (
                  <option value={index} key={index} selected={isApiModeSelected(apiMode, config)}>
                    {desc}
                  </option>
                )
              }
            })}
            <option value={-1} selected={!config.apiMode && config.modelName === 'customModel'}>
              {t(Models.customModel.desc)}
            </option>
          </select>
          {isUsingMultiModeModel(config) && (
            <select
              style="width: 50%;"
              required
              onChange={(e) => {
                const modelMode = e.target.value
                updateConfig({ modelMode: modelMode })
              }}
            >
              {Object.entries(ModelMode).map(([key, desc]) => {
                return (
                  <option value={key} key={key} selected={key === config.modelMode}>
                    {t(desc)}
                  </option>
                )
              })}
            </select>
          )}
          {isUsingOpenAICompatibleProvider && !isUsingSpecialCustomModel(config) && (
            <span style="width: 50%; display: flex; gap: 5px;">
              <input
                type="password"
                value={providerApiKeyDraft}
                disabled={
                  isSelectedProviderKeyManagedByModeOverride && isOverrideProviderKeyActionPending
                }
                placeholder={t('API Key')}
                onChange={(e) => {
                  handleProviderApiKeyDraftChange(e.target.value)
                }}
                onBlur={handleProviderApiKeyBlur}
                onKeyDown={handleProviderApiKeyInputKeyDown}
              />
              {selectedProviderApiKeySetupUrl && normalizedProviderApiKeyDraft.length === 0 && (
                <a
                  href={selectedProviderApiKeySetupUrl}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                >
                  <button style="white-space: nowrap;" type="button">
                    {t('Get')}
                  </button>
                </a>
              )}
            </span>
          )}
          {isUsingSpecialCustomModel(config) && (
            <input
              style="width: 50%;"
              type="text"
              value={config.customModelName}
              placeholder={t('Model Name')}
              onChange={(e) => {
                const customModelName = e.target.value
                updateConfig({ customModelName: customModelName })
              }}
            />
          )}
          {isUsingAzureOpenAiApiModel(config) && (
            <input
              type="password"
              style="width: 50%;"
              value={config.azureApiKey}
              placeholder={t('Azure API Key')}
              onChange={(e) => {
                const apiKey = e.target.value
                updateConfig({ azureApiKey: apiKey })
              }}
            />
          )}
          {isUsingClaudeApiModel(config) && (
            <input
              type="password"
              style="width: 50%;"
              value={config.anthropicApiKey}
              placeholder={t('Anthropic API Key')}
              onChange={(e) => {
                const apiKey = e.target.value
                updateConfig({ anthropicApiKey: apiKey })
              }}
            />
          )}
        </span>
        {isUsingOpenAICompatibleProvider &&
          isSelectedProviderKeyManagedByModeOverride &&
          !isUsingSpecialCustomModel(config) && (
            <span style="display: inline-flex; align-items: center; gap: 8px; margin-top: 8px;">
              <small style="display: inline;">
                {t(
                  'This API key is set on the selected custom mode. Editing it here will create a dedicated provider for that mode.',
                )}
              </small>
              <button
                type="button"
                data-provider-key-action=""
                disabled={
                  isOverrideProviderKeyActionPending ||
                  normalizedProviderApiKeyDraft.length === 0 ||
                  normalizedProviderApiKeyDraft === normalizedSelectedProviderApiKey
                }
                onMouseDown={handleProviderOverrideActionMouseDown}
                onClick={handleSaveProviderKeyOverride}
              >
                {t('Save')}
              </button>
              <button
                type="button"
                data-provider-key-action=""
                disabled={isOverrideProviderKeyActionPending}
                onMouseDown={handleProviderOverrideActionMouseDown}
                onClick={handleUseSharedProviderKey}
              >
                {t('Use shared key')}
              </button>
            </span>
          )}
        {isUsingSpecialCustomModel(config) && isUsingOpenAICompatibleProvider && (
          <span style="display: flex; gap: 5px; margin-top: 15px;">
            <input
              type="password"
              value={providerApiKeyDraft}
              disabled={
                isSelectedProviderKeyManagedByModeOverride && isOverrideProviderKeyActionPending
              }
              placeholder={t('API Key')}
              onChange={(e) => {
                handleProviderApiKeyDraftChange(e.target.value)
              }}
              onBlur={handleProviderApiKeyBlur}
              onKeyDown={handleProviderApiKeyInputKeyDown}
            />
          </span>
        )}
        {isUsingSpecialCustomModel(config) &&
          isUsingOpenAICompatibleProvider &&
          isSelectedProviderKeyManagedByModeOverride && (
            <span style="display: inline-flex; align-items: center; gap: 8px; margin-top: 8px;">
              <small style="display: inline;">
                {t(
                  'This API key is set on the selected custom mode. Editing it here will create a dedicated provider for that mode.',
                )}
              </small>
              <button
                type="button"
                data-provider-key-action=""
                disabled={
                  isOverrideProviderKeyActionPending ||
                  normalizedProviderApiKeyDraft.length === 0 ||
                  normalizedProviderApiKeyDraft === normalizedSelectedProviderApiKey
                }
                onMouseDown={handleProviderOverrideActionMouseDown}
                onClick={handleSaveProviderKeyOverride}
              >
                {t('Save')}
              </button>
              <button
                type="button"
                data-provider-key-action=""
                disabled={isOverrideProviderKeyActionPending}
                onMouseDown={handleProviderOverrideActionMouseDown}
                onClick={handleUseSharedProviderKey}
              >
                {t('Use shared key')}
              </button>
            </span>
          )}
        {isUsingSpecialCustomModel(config) && (
          <input
            type="text"
            value={config.customModelApiUrl}
            placeholder={t('Custom Model API Url')}
            onChange={(e) => {
              const value = e.target.value
              updateConfig({ customModelApiUrl: value })
            }}
          />
        )}
        {isUsingOllamaApiModel(config) && (
          <div style={{ display: 'flex', gap: '10px' }}>
            {t('Keep-Alive Time') + ':'}
            <label>
              <input
                type="radio"
                name="ollamaKeepAliveTime"
                value="5m"
                checked={config.ollamaKeepAliveTime === '5m'}
                onChange={(e) => {
                  updateConfig({ ollamaKeepAliveTime: e.target.value })
                }}
              />
              {t('5m')}
            </label>
            <label>
              <input
                type="radio"
                name="ollamaKeepAliveTime"
                value="30m"
                checked={config.ollamaKeepAliveTime === '30m'}
                onChange={(e) => {
                  updateConfig({ ollamaKeepAliveTime: e.target.value })
                }}
              />
              {t('30m')}
            </label>
            <label>
              <input
                type="radio"
                name="ollamaKeepAliveTime"
                value="-1"
                checked={config.ollamaKeepAliveTime === '-1'}
                onChange={(e) => {
                  updateConfig({ ollamaKeepAliveTime: e.target.value })
                }}
              />
              {t('Forever')}
            </label>
          </div>
        )}
        {isUsingOllamaApiModel(config) && (
          <input
            type="text"
            value={config.ollamaEndpoint}
            placeholder={t('Ollama Endpoint')}
            onChange={(e) => {
              const value = e.target.value
              updateConfig({ ollamaEndpoint: value })
            }}
          />
        )}
        {isUsingAzureOpenAiApiModel(config) && (
          <input
            type="password"
            value={config.azureEndpoint}
            placeholder={t('Azure Endpoint')}
            onChange={(e) => {
              const endpoint = e.target.value
              updateConfig({ azureEndpoint: endpoint })
            }}
          />
        )}
        {isUsingGithubThirdPartyApiModel(config) && (
          <input
            type="text"
            value={config.githubThirdPartyUrl}
            placeholder={t('API Url')}
            onChange={(e) => {
              const url = e.target.value
              updateConfig({ githubThirdPartyUrl: url })
            }}
          />
        )}
      </label>
      <label>
        <legend>{t('Preferred Language')}</legend>
        <select
          required
          onChange={(e) => {
            const preferredLanguageKey = e.target.value
            updateConfig({ preferredLanguage: preferredLanguageKey })

            let lang
            if (preferredLanguageKey === 'auto') lang = config.userLanguage
            else lang = preferredLanguageKey
            i18n.changeLanguage(lang)

            Browser.tabs.query({}).then((tabs) => {
              tabs.forEach((tab) => {
                Browser.tabs
                  .sendMessage(tab.id, {
                    type: 'CHANGE_LANG',
                    data: {
                      lang,
                    },
                  })
                  .catch(() => {})
              })
            })
          }}
        >
          {Object.entries(languageList).map(([k, v]) => {
            return (
              <option value={k} key={k} selected={k === config.preferredLanguage}>
                {v.native}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <legend>{t('When Icon Clicked')}</legend>
        <select
          required
          onChange={(e) => {
            const mode = e.target.value
            updateConfig({ clickIconAction: mode })
          }}
        >
          <option value="popup" key="popup" selected={config.clickIconAction === 'popup'}>
            {t('Open Settings')}
          </option>
          {Object.entries(menuConfig).map(([k, v]) => {
            return (
              <option value={k} key={k} selected={k === config.clickIconAction}>
                {t(v.label)}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.insertAtTop}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ insertAtTop: checked })
          }}
        />
        {t('Insert ChatGPT at the top of search results')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.alwaysFloatingSidebar}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ alwaysFloatingSidebar: checked })
          }}
        />
        {t('Always display floating window, disable sidebar for all site adapters')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.allowEscToCloseAll}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ allowEscToCloseAll: checked })
          }}
        />
        {t('Allow ESC to close all floating windows')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.lockWhenAnswer}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ lockWhenAnswer: checked })
          }}
        />
        {t('Lock scrollbar while answering')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.autoRegenAfterSwitchModel}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ autoRegenAfterSwitchModel: checked })
          }}
        />
        {t('Regenerate the answer after switching model')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.selectionToolsNextToInputBox}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ selectionToolsNextToInputBox: checked })
          }}
        />
        {t('Display selection tools next to input box to avoid blocking')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.alwaysPinWindow}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ alwaysPinWindow: checked })
          }}
        />
        {t('Always pin the floating window')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.focusAfterAnswer}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ focusAfterAnswer: checked })
          }}
        />
        {t('Focus to input box after answering')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.cropText}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ cropText: checked })
          }}
        />
        {t("Crop Text to ensure the input tokens do not exceed the model's limit")}
      </label>
      <br />
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          className="secondary"
          onClick={async (e) => {
            e.preventDefault()
            const file = await new Promise((resolve) => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.json'
              input.onchange = (e) => resolve(e.target.files[0])
              input.click()
            })
            if (!file) return
            try {
              const fileContent =
                typeof file.text === 'function'
                  ? await file.text()
                  : await new Promise((resolve, reject) => {
                      const reader = new FileReader()
                      reader.onload = () => resolve(reader.result)
                      reader.onerror = () => reject(reader.error)
                      reader.readAsText(file)
                    })
              const parsedData = JSON.parse(fileContent)
              const isPlainObject =
                parsedData !== null && typeof parsedData === 'object' && !Array.isArray(parsedData)

              if (!isPlainObject) {
                throw new Error('Invalid backup file')
              }

              await importDataIntoStorage(Browser.storage.local, parsedData)
              window.location.reload()
            } catch (error) {
              console.error('[popup] Failed to import data', error)
              const rawMessage =
                error instanceof SyntaxError
                  ? 'Invalid backup file'
                  : error instanceof Error
                  ? error.message
                  : String(error ?? '')
              window.alert(rawMessage ? `${t('Error')}: ${rawMessage}` : t('Error'))
            }
          }}
        >
          {t('Import All Data')}
        </button>
        <button
          className="secondary"
          onClick={async (e) => {
            e.preventDefault()
            const blob = new Blob(
              [JSON.stringify(await Browser.storage.local.get(null), null, 2)],
              { type: 'text/json;charset=utf-8' },
            )
            FileSaver.saveAs(blob, 'chatgptbox-data.json')
          }}
        >
          {t('Export All Data')}
        </button>
      </div>
    </>
  )
}
