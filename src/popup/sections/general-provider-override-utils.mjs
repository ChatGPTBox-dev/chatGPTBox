import {
  getProviderById,
  resolveOpenAICompatibleRequest,
} from '../../services/apis/provider-registry.mjs'
import {
  getConfiguredCustomApiModesForSessionRecovery,
  getReferencedCustomProviderIdsFromSessions,
} from './api-modes-provider-utils.mjs'
import {
  applyProviderSecretOverrideSessionMigration,
  buildSelectionPreservingConfigUpdate,
  getProviderSecretsRecord,
} from './provider-secret-utils.mjs'

function normalizeText(value) {
  return String(value || '').trim()
}

export function createProviderApiKeyDraftSelectionSignature(providerId, secretTargetId) {
  return JSON.stringify({
    providerId: normalizeText(providerId),
    secretTargetId: normalizeText(secretTargetId),
  })
}

export function shouldResetProviderApiKeyDraftAfterPersistFailure(
  currentSelectionSignature,
  commitSelectionSignature,
  currentDraft,
  commitDraft,
) {
  return (
    normalizeText(currentSelectionSignature) === normalizeText(commitSelectionSignature) &&
    String(currentDraft || '') === String(commitDraft || '')
  )
}

export function resolvePersistedProviderApiKeyForSelection(persistedConfig, selectionSession) {
  const baseConfig = persistedConfig && typeof persistedConfig === 'object' ? persistedConfig : {}
  const baseSession =
    selectionSession && typeof selectionSession === 'object' ? selectionSession : {}
  const persistedSelectionSession =
    baseSession.apiMode && typeof baseSession.apiMode === 'object'
      ? {
          ...baseSession,
          apiMode: {
            ...baseSession.apiMode,
            apiKey: '',
          },
        }
      : baseSession
  return resolveOpenAICompatibleRequest(baseConfig, persistedSelectionSession)?.apiKey || ''
}

function buildCleanupConfigUpdate(
  cleanupCandidateProviderId,
  baseConfig,
  currentConfigUpdate,
  sessionsForCleanup,
) {
  const normalizedCandidateId = normalizeText(cleanupCandidateProviderId)
  if (!normalizedCandidateId) return currentConfigUpdate
  if (!Array.isArray(sessionsForCleanup)) return currentConfigUpdate

  const nextConfig = { ...baseConfig, ...currentConfigUpdate }
  const nextProviders = Array.isArray(nextConfig.customOpenAIProviders)
    ? nextConfig.customOpenAIProviders
    : []
  const nextApiModes = getConfiguredCustomApiModesForSessionRecovery(
    nextConfig.customApiModes,
    nextConfig.apiMode,
  )
  const sessionReferencedProviderIds = getReferencedCustomProviderIdsFromSessions(
    sessionsForCleanup,
    nextProviders,
    nextApiModes,
  )
  const hasModeReference = nextApiModes.some(
    (apiMode) =>
      apiMode &&
      typeof apiMode === 'object' &&
      normalizeText(apiMode.providerId) === normalizedCandidateId,
  )
  if (hasModeReference || sessionReferencedProviderIds.includes(normalizedCandidateId)) {
    return currentConfigUpdate
  }

  const nextProviderSecrets = { ...getProviderSecretsRecord(nextConfig) }
  delete nextProviderSecrets[normalizedCandidateId]

  return {
    ...currentConfigUpdate,
    providerSecrets: nextProviderSecrets,
    customOpenAIProviders: nextProviders.filter(
      (provider) => normalizeText(provider?.id) !== normalizedCandidateId,
    ),
  }
}

export async function resolveOverrideCommitContext(getCommittedConfig, selectedProviderId) {
  const latestConfig = typeof getCommittedConfig === 'function' ? await getCommittedConfig() : null
  const committedConfig = latestConfig && typeof latestConfig === 'object' ? latestConfig : {}
  const existingProviders = Array.isArray(committedConfig?.customOpenAIProviders)
    ? committedConfig.customOpenAIProviders
    : []
  const committedSelectedProvider = getProviderById(committedConfig, selectedProviderId)
  return {
    committedConfig,
    existingProviders,
    committedSelectedProvider,
  }
}

export async function resolveCommittedMigratedSessions(loadLatestSessions, sessionMigration) {
  const latestSessionsResult =
    typeof loadLatestSessions === 'function'
      ? await loadLatestSessions()
      : { ok: false, sessions: [] }
  if (!latestSessionsResult?.ok) {
    return {
      ok: false,
      sessions: [],
      migratedSessions: [],
    }
  }

  const sessions = Array.isArray(latestSessionsResult.sessions) ? latestSessionsResult.sessions : []
  return {
    ok: true,
    sessions,
    migratedSessions: applyProviderSecretOverrideSessionMigration(sessions, sessionMigration),
  }
}

export function buildProviderOverrideFinalConfigUpdate(
  cleanupCandidateProviderId,
  baseConfig,
  configUpdate,
  sessionsForCleanup,
  preserveCurrentSelection = false,
) {
  const selectionPreservedConfigUpdate = buildSelectionPreservingConfigUpdate(
    configUpdate,
    preserveCurrentSelection,
  )
  if (preserveCurrentSelection) {
    return selectionPreservedConfigUpdate
  }
  return buildCleanupConfigUpdate(
    cleanupCandidateProviderId,
    baseConfig,
    selectionPreservedConfigUpdate,
    sessionsForCleanup,
  )
}

export function resolveCommittedOverrideSourceProvider(
  committedConfig,
  selectedProviderSecretTargetId,
) {
  const selectedProviderSession =
    committedConfig?.apiMode && typeof committedConfig.apiMode === 'object'
      ? { apiMode: committedConfig.apiMode }
      : { modelName: committedConfig?.modelName }
  const committedSelectedProviderRequest = resolveOpenAICompatibleRequest(
    committedConfig,
    selectedProviderSession,
  )
  const committedSelectedProvider = committedSelectedProviderRequest
    ? getProviderById(committedConfig, committedSelectedProviderRequest.providerId)
    : null
  const normalizedSecretTargetId = normalizeText(selectedProviderSecretTargetId)
  const recoveredEndpointUrl = normalizeText(committedSelectedProviderRequest?.requestUrl)
  const overrideSourceProvider =
    normalizeText(committedSelectedProviderRequest?.providerId) === 'legacy-custom-default' &&
    normalizedSecretTargetId &&
    normalizedSecretTargetId !== normalizeText(committedSelectedProviderRequest?.providerId) &&
    recoveredEndpointUrl &&
    committedSelectedProvider
      ? {
          ...committedSelectedProvider,
          id: normalizedSecretTargetId,
          sourceProviderId: normalizedSecretTargetId,
          chatCompletionsUrl: recoveredEndpointUrl,
          baseUrl: '',
          chatCompletionsPath: '',
          completionsUrl: '',
          completionsPath: '',
        }
      : committedSelectedProvider

  return {
    committedSelectedProviderRequest,
    committedSelectedProvider,
    overrideSourceProvider,
  }
}
