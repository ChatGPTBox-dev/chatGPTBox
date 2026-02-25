import { LEGACY_API_KEY_FIELD_BY_PROVIDER_ID } from '../../config/openai-provider-mappings.mjs'
import { isApiModeSelected } from '../../utils/model-name-convert.mjs'

export function buildProviderSecretUpdate(config, providerId, apiKey) {
  if (!providerId) return {}
  const normalizedProviderId = String(providerId).trim()
  const normalizedNextApiKey = String(apiKey || '').trim()
  const previousProviderSecret =
    (config.providerSecrets && typeof config.providerSecrets === 'object'
      ? String(config.providerSecrets[normalizedProviderId] || '').trim()
      : '') || ''
  const payload = {
    providerSecrets: {
      ...(config.providerSecrets || {}),
      [normalizedProviderId]: normalizedNextApiKey,
    },
  }
  const legacyKeyField = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[normalizedProviderId]
  if (legacyKeyField) payload[legacyKeyField] = normalizedNextApiKey
  const legacyProviderSecret = legacyKeyField ? String(config[legacyKeyField] || '').trim() : ''
  const inheritedSecretBaselines = Array.from(
    new Set([previousProviderSecret, legacyProviderSecret].filter(Boolean)),
  )

  if (Array.isArray(config.customApiModes)) {
    let customApiModesDirty = false
    const nextCustomApiModes = config.customApiModes.map((apiMode) => {
      if (!apiMode || typeof apiMode !== 'object') return apiMode
      const modeApiKey = String(apiMode.apiKey || '').trim()
      const isMatchedCustomProviderMode =
        apiMode.groupName === 'customApiModelKeys' &&
        String(apiMode.providerId || '').trim() === normalizedProviderId
      const shouldClearInheritedModeKey = inheritedSecretBaselines.includes(modeApiKey)
      const shouldSyncSelectedModeKey =
        isApiModeSelected(apiMode, config) &&
        modeApiKey &&
        !shouldClearInheritedModeKey &&
        modeApiKey !== normalizedNextApiKey
      if (
        !isMatchedCustomProviderMode ||
        !modeApiKey ||
        (!shouldClearInheritedModeKey && !shouldSyncSelectedModeKey)
      )
        return apiMode
      customApiModesDirty = true
      return {
        ...apiMode,
        apiKey: shouldClearInheritedModeKey ? '' : normalizedNextApiKey,
      }
    })
    if (customApiModesDirty) payload.customApiModes = nextCustomApiModes
  }

  if (config.apiMode && typeof config.apiMode === 'object') {
    const selectedApiMode = config.apiMode
    const selectedModeApiKey = String(selectedApiMode.apiKey || '').trim()
    const isMatchedSelectedCustomProviderMode =
      selectedApiMode.groupName === 'customApiModelKeys' &&
      String(selectedApiMode.providerId || '').trim() === normalizedProviderId
    const shouldClearSelectedInheritedModeKey =
      inheritedSecretBaselines.includes(selectedModeApiKey)
    const shouldSyncSelectedModeKey =
      selectedModeApiKey &&
      !shouldClearSelectedInheritedModeKey &&
      selectedModeApiKey !== normalizedNextApiKey
    if (
      isMatchedSelectedCustomProviderMode &&
      selectedModeApiKey &&
      (shouldClearSelectedInheritedModeKey || shouldSyncSelectedModeKey)
    ) {
      payload.apiMode = {
        ...selectedApiMode,
        apiKey: shouldClearSelectedInheritedModeKey ? '' : normalizedNextApiKey,
      }
    }
  }
  return payload
}
