import { LEGACY_API_KEY_FIELD_BY_PROVIDER_ID } from '../../config/openai-provider-mappings.mjs'
import { isApiModeSelected } from '../../utils/model-name-convert.mjs'
import { createProviderId } from './api-modes-provider-utils.mjs'

function normalizeText(value) {
  return String(value || '').trim()
}

export function getProviderSecretsRecord(config) {
  const providerSecrets = config?.providerSecrets
  if (!providerSecrets || typeof providerSecrets !== 'object' || Array.isArray(providerSecrets)) {
    return {}
  }
  const prototype = Object.getPrototypeOf(providerSecrets)
  return prototype === Object.prototype || prototype === null ? providerSecrets : {}
}

function createMaterializedProviderName(sourceProvider, selectedApiMode) {
  const baseName = normalizeText(sourceProvider?.name) || 'Custom Provider'
  const modeName = normalizeText(selectedApiMode?.customName) || 'Mode Override'
  return `${baseName} (${modeName})`
}

function buildMaterializedProvider(sourceProvider, selectedApiMode, existingProviders) {
  const providerName = createMaterializedProviderName(sourceProvider, selectedApiMode)
  const sourceProviderId =
    normalizeText(sourceProvider?.sourceProviderId) || normalizeText(sourceProvider?.id)
  return {
    id: createProviderId(providerName, existingProviders),
    name: providerName,
    baseUrl: normalizeText(sourceProvider?.baseUrl),
    chatCompletionsPath:
      normalizeText(sourceProvider?.chatCompletionsPath) || '/v1/chat/completions',
    completionsPath: normalizeText(sourceProvider?.completionsPath) || '/v1/completions',
    chatCompletionsUrl: normalizeText(sourceProvider?.chatCompletionsUrl),
    completionsUrl: normalizeText(sourceProvider?.completionsUrl),
    enabled: sourceProvider?.enabled !== false,
    allowLegacyResponseField: sourceProvider?.allowLegacyResponseField !== false,
    ...(sourceProviderId ? { sourceProviderId } : {}),
  }
}

export function createProviderSecretDraftCommitSignature({
  providerId,
  currentApiKey,
  nextApiKey,
  resolvedOpenAiApiUrl,
  hasModeOverride,
}) {
  return JSON.stringify({
    providerId: normalizeText(providerId),
    currentApiKey: normalizeText(currentApiKey),
    nextApiKey: normalizeText(nextApiKey),
    resolvedOpenAiApiUrl: normalizeText(resolvedOpenAiApiUrl).replace(/\/+$/, ''),
    hasModeOverride: Boolean(hasModeOverride),
  })
}

export function resolveProviderSecretTargetId(providerRequest) {
  return (
    normalizeText(providerRequest?.secretProviderId) || normalizeText(providerRequest?.providerId)
  )
}

export function buildSelectionPreservingConfigUpdate(
  configUpdate,
  preserveCurrentSelection = false,
) {
  const nextConfigUpdate =
    configUpdate && typeof configUpdate === 'object' ? { ...configUpdate } : {}
  if (!preserveCurrentSelection) return nextConfigUpdate
  delete nextConfigUpdate.apiMode
  return nextConfigUpdate
}

export function createProviderSecretOverrideCommitSelectionSignature(providerId, apiMode) {
  return JSON.stringify(normalizeApiModeIdentity(apiMode, providerId))
}

function normalizeApiModeIdentity(apiMode, providerId = apiMode?.providerId) {
  return {
    groupName: normalizeText(apiMode?.groupName),
    itemName: normalizeText(apiMode?.itemName),
    customName: normalizeText(apiMode?.customName),
    isCustom: Boolean(apiMode?.isCustom),
    providerId: normalizeText(providerId),
  }
}

function isSameApiModeIdentity(left, right) {
  return (
    normalizeText(left?.groupName) === normalizeText(right?.groupName) &&
    normalizeText(left?.itemName) === normalizeText(right?.itemName) &&
    normalizeText(left?.customName) === normalizeText(right?.customName) &&
    Boolean(left?.isCustom) === Boolean(right?.isCustom) &&
    normalizeText(left?.providerId) === normalizeText(right?.providerId)
  )
}

function isLegacySessionApiModeIdentityMatch(sessionApiMode, migrationIdentity, fromProviderId) {
  if (!sessionApiMode || typeof sessionApiMode !== 'object') return false
  if (normalizeText(sessionApiMode.groupName) !== 'customApiModelKeys') return false
  if (normalizeText(sessionApiMode.providerId) !== fromProviderId) return false
  if (normalizeText(sessionApiMode.customName) !== normalizeText(migrationIdentity?.customName)) {
    return false
  }

  const isMissingLegacyIdentityFields =
    !Object.hasOwn(sessionApiMode, 'itemName') || !Object.hasOwn(sessionApiMode, 'isCustom')
  if (!isMissingLegacyIdentityFields) return false

  return normalizeText(migrationIdentity?.groupName) === 'customApiModelKeys'
}

function isSessionApiModeIdentityMatch(sessionApiMode, migrationIdentity, providerId) {
  if (!sessionApiMode || typeof sessionApiMode !== 'object') return false
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return false

  const sessionIdentity = normalizeApiModeIdentity(sessionApiMode, sessionApiMode.providerId)
  const normalizedMigrationIdentity = {
    ...migrationIdentity,
    providerId: normalizedProviderId,
  }
  return (
    isSameApiModeIdentity(sessionIdentity, normalizedMigrationIdentity) ||
    isLegacySessionApiModeIdentityMatch(
      sessionApiMode,
      normalizedMigrationIdentity,
      normalizedProviderId,
    )
  )
}

export function applyProviderSecretOverrideSessionMigration(sessions, migration) {
  if (!migration) return Array.isArray(sessions) ? sessions : []
  const baseSessions = Array.isArray(sessions) ? sessions : []
  const fromProviderId = normalizeText(migration.fromProviderId)
  const toProviderId = normalizeText(migration.toProviderId)
  const identity = migration.identity || {}
  if (!fromProviderId || !toProviderId) return baseSessions

  let dirty = false
  const nextSessions = baseSessions.map((session) => {
    if (!session || typeof session !== 'object') return session
    const sessionApiMode = session.apiMode
    if (!sessionApiMode || typeof sessionApiMode !== 'object') return session
    if (!isSessionApiModeIdentityMatch(sessionApiMode, identity, fromProviderId)) {
      return session
    }
    dirty = true
    const nextApiMode = {
      ...sessionApiMode,
      providerId: toProviderId,
      apiKey: '',
    }
    delete nextApiMode.sourceProviderId
    return {
      ...session,
      apiMode: nextApiMode,
    }
  })

  return dirty ? nextSessions : baseSessions
}

export function rollbackProviderSecretOverrideSessionMigration(
  sessions,
  originalSessions,
  migration,
) {
  if (!migration) return Array.isArray(sessions) ? sessions : []
  const baseSessions = Array.isArray(sessions) ? sessions : []
  const baseOriginalSessions = Array.isArray(originalSessions) ? originalSessions : []
  const fromProviderId = normalizeText(migration.fromProviderId)
  const toProviderId = normalizeText(migration.toProviderId)
  const identity = migration.identity || {}
  if (!fromProviderId || !toProviderId || baseOriginalSessions.length === 0) return baseSessions

  const originalSessionsById = new Map(
    baseOriginalSessions
      .filter(
        (session) => session && typeof session === 'object' && normalizeText(session.sessionId),
      )
      .map((session) => [normalizeText(session.sessionId), session]),
  )

  let dirty = false
  const nextSessions = baseSessions.map((session) => {
    if (!session || typeof session !== 'object') return session
    const sessionApiMode = session.apiMode
    if (!sessionApiMode || typeof sessionApiMode !== 'object') return session
    if (!isSessionApiModeIdentityMatch(sessionApiMode, identity, toProviderId)) {
      return session
    }
    const originalSession = originalSessionsById.get(normalizeText(session.sessionId))
    const originalApiMode = originalSession?.apiMode
    if (!originalApiMode || typeof originalApiMode !== 'object') return session
    dirty = true
    return {
      ...session,
      apiMode: {
        ...originalApiMode,
      },
    }
  })

  return dirty ? nextSessions : baseSessions
}

export function hasSelectedModeOwnProviderSecretOverride(config, providerId) {
  if (!providerId) return false
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return false
  const selectedApiMode =
    config.apiMode && typeof config.apiMode === 'object' ? config.apiMode : null
  if (
    !selectedApiMode ||
    selectedApiMode.groupName !== 'customApiModelKeys' ||
    String(selectedApiMode.providerId || '').trim() !== normalizedProviderId
  ) {
    return false
  }
  const selectedModeApiKey = normalizeText(selectedApiMode.apiKey)
  const sourceProviderId = normalizeText(selectedApiMode.sourceProviderId)
  if (!selectedModeApiKey) {
    return Boolean(sourceProviderId && sourceProviderId !== normalizedProviderId)
  }
  const previousProviderSecret =
    (config.providerSecrets && typeof config.providerSecrets === 'object'
      ? normalizeText(config.providerSecrets[normalizedProviderId])
      : '') || ''
  const legacyKeyField = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[normalizedProviderId]
  const legacyProviderSecret = legacyKeyField ? normalizeText(config[legacyKeyField]) : ''
  const inheritedSecretBaselines = Array.from(
    new Set([previousProviderSecret, legacyProviderSecret].filter(Boolean)),
  )
  return !inheritedSecretBaselines.includes(selectedModeApiKey)
}

export function buildProviderSecretUpdate(config, providerId, apiKey) {
  if (!providerId) return {}
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return {}
  const normalizedNextApiKey = normalizeText(apiKey)
  const providerSecrets = getProviderSecretsRecord(config)
  const previousProviderSecret = normalizeText(providerSecrets[normalizedProviderId])
  const payload = {
    providerSecrets: {
      ...providerSecrets,
      [normalizedProviderId]: normalizedNextApiKey,
    },
  }
  const legacyKeyField = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[normalizedProviderId]
  if (legacyKeyField) payload[legacyKeyField] = normalizedNextApiKey
  const legacyProviderSecret = legacyKeyField ? normalizeText(config[legacyKeyField]) : ''
  const inheritedSecretBaselines = Array.from(
    new Set([previousProviderSecret, legacyProviderSecret].filter(Boolean)),
  )

  if (Array.isArray(config.customApiModes)) {
    let customApiModesDirty = false
    const nextCustomApiModes = config.customApiModes.map((apiMode) => {
      if (!apiMode || typeof apiMode !== 'object') return apiMode
      const modeApiKey = normalizeText(apiMode.apiKey)
      const isMatchedCustomProviderMode =
        apiMode.groupName === 'customApiModelKeys' &&
        normalizeText(apiMode.providerId) === normalizedProviderId
      const shouldClearModeKey =
        isMatchedCustomProviderMode &&
        modeApiKey &&
        (inheritedSecretBaselines.includes(modeApiKey) || isApiModeSelected(apiMode, config))
      if (!shouldClearModeKey) return apiMode
      customApiModesDirty = true
      return {
        ...apiMode,
        apiKey: '',
      }
    })
    if (customApiModesDirty) payload.customApiModes = nextCustomApiModes
  }

  if (config.apiMode && typeof config.apiMode === 'object') {
    const selectedApiMode = config.apiMode
    const selectedModeApiKey = normalizeText(selectedApiMode.apiKey)
    const isMatchedSelectedCustomProviderMode =
      selectedApiMode.groupName === 'customApiModelKeys' &&
      normalizeText(selectedApiMode.providerId) === normalizedProviderId
    const shouldClearSelectedModeKey = isMatchedSelectedCustomProviderMode && selectedModeApiKey
    if (shouldClearSelectedModeKey) {
      payload.apiMode = {
        ...selectedApiMode,
        apiKey: '',
      }
    }
  }
  return payload
}

export function buildSelectedModeProviderSecretOverrideUpdate(
  config,
  providerId,
  apiKey,
  sourceProvider,
  existingProviders = [],
) {
  if (!providerId) return {}
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId)
    return { configUpdate: {}, sessionMigration: null, cleanupCandidateProviderId: '' }
  const selectedApiMode =
    config.apiMode && typeof config.apiMode === 'object' ? config.apiMode : null
  if (
    !selectedApiMode ||
    selectedApiMode.groupName !== 'customApiModelKeys' ||
    normalizeText(selectedApiMode.providerId) !== normalizedProviderId
  ) {
    return {
      configUpdate: buildProviderSecretUpdate(config, normalizedProviderId, apiKey),
      sessionMigration: null,
      cleanupCandidateProviderId: '',
    }
  }

  const normalizedNextApiKey = normalizeText(apiKey)
  const sourceProviderId = normalizeText(selectedApiMode.sourceProviderId)
  const materializedOverrideSourceProviderId = sourceProviderId || normalizedProviderId
  const providerSecrets = getProviderSecretsRecord(config)
  const previousProviderSecret = normalizeText(providerSecrets[normalizedProviderId])
  const legacyKeyField = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[normalizedProviderId]
  const legacyProviderSecret = legacyKeyField ? normalizeText(config[legacyKeyField]) : ''
  const isRecoveredProxySource =
    normalizeText(sourceProvider?.id) === normalizedProviderId &&
    normalizeText(sourceProvider?.sourceProviderId) === normalizedProviderId &&
    normalizeText(sourceProvider?.chatCompletionsUrl) &&
    !normalizeText(sourceProvider?.baseUrl)
  const isMaterializedOverride =
    !normalizeText(selectedApiMode.apiKey) &&
    sourceProviderId &&
    sourceProviderId !== normalizedProviderId
  const inheritedSecretBaselines = isMaterializedOverride
    ? Array.from(
        new Set(
          [
            normalizeText(providerSecrets[materializedOverrideSourceProviderId]),
            (() => {
              const sourceLegacyKeyField =
                LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[materializedOverrideSourceProviderId]
              return sourceLegacyKeyField ? normalizeText(config[sourceLegacyKeyField]) : ''
            })(),
          ].filter(Boolean),
        ),
      )
    : Array.from(
        new Set(
          [previousProviderSecret, isRecoveredProxySource ? '' : legacyProviderSecret].filter(
            Boolean,
          ),
        ),
      )
  const shouldClearOverride =
    !normalizedNextApiKey || inheritedSecretBaselines.includes(normalizedNextApiKey)

  const payload = {}
  const selectedModeIdentity = normalizeApiModeIdentity(selectedApiMode, normalizedProviderId)
  const baseProviders = Array.isArray(existingProviders) ? existingProviders : []
  const source =
    (sourceProvider && typeof sourceProvider === 'object' ? sourceProvider : null) ||
    baseProviders.find((provider) => normalizeText(provider?.id) === normalizedProviderId) ||
    null
  const revertProviderId = sourceProviderId || normalizedProviderId
  const nextProviderId = shouldClearOverride
    ? revertProviderId
    : isMaterializedOverride
    ? normalizedProviderId
    : buildMaterializedProvider(source, selectedApiMode, baseProviders).id

  if (Array.isArray(config.customApiModes)) {
    let customApiModesDirty = false
    const nextCustomApiModes = config.customApiModes.map((apiMode) => {
      if (!apiMode || typeof apiMode !== 'object' || !isApiModeSelected(apiMode, config)) {
        return apiMode
      }
      customApiModesDirty = true
      const nextApiMode = {
        ...apiMode,
        providerId: nextProviderId,
        apiKey: '',
      }
      if (shouldClearOverride) {
        delete nextApiMode.sourceProviderId
      } else if (!isMaterializedOverride) {
        nextApiMode.sourceProviderId = normalizedProviderId
      }
      return nextApiMode
    })
    if (customApiModesDirty) payload.customApiModes = nextCustomApiModes
  }

  if (shouldClearOverride) {
    if (
      selectedApiMode.apiKey ||
      normalizeText(selectedApiMode.providerId) !== nextProviderId ||
      sourceProviderId
    ) {
      const nextSelectedApiMode = {
        ...selectedApiMode,
        providerId: nextProviderId,
        apiKey: '',
      }
      delete nextSelectedApiMode.sourceProviderId
      payload.apiMode = {
        ...nextSelectedApiMode,
      }
    }
    return {
      configUpdate: payload,
      sessionMigration:
        isMaterializedOverride || normalizeText(selectedApiMode.apiKey)
          ? {
              identity: selectedModeIdentity,
              fromProviderId: normalizedProviderId,
              toProviderId: nextProviderId,
            }
          : null,
      cleanupCandidateProviderId: isMaterializedOverride ? normalizedProviderId : '',
    }
  }

  payload.providerSecrets = {
    ...providerSecrets,
    [nextProviderId]: normalizedNextApiKey,
  }
  if (isMaterializedOverride) {
    payload.apiMode = {
      ...selectedApiMode,
      providerId: nextProviderId,
      apiKey: '',
      sourceProviderId,
    }
    return {
      configUpdate: payload,
      sessionMigration: null,
      cleanupCandidateProviderId: '',
    }
  }

  const materializedProvider = {
    ...buildMaterializedProvider(source, selectedApiMode, baseProviders),
    id: nextProviderId,
  }
  payload.customOpenAIProviders = [...baseProviders, materializedProvider]
  payload.apiMode = {
    ...selectedApiMode,
    providerId: materializedProvider.id,
    apiKey: '',
    sourceProviderId: normalizedProviderId,
  }
  return {
    configUpdate: payload,
    sessionMigration: {
      identity: selectedModeIdentity,
      fromProviderId: normalizedProviderId,
      toProviderId: materializedProvider.id,
    },
    cleanupCandidateProviderId: '',
  }
}
