import { AlwaysCustomGroups } from '../../config/index.mjs'
import { apiModeToModelName, modelNameToDesc } from '../../utils/model-name-convert.mjs'

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeProviderId(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeProviderEndpointUrl(value) {
  return normalizeText(value).replace(/\/+$/, '')
}

function hasNativeOllamaChatApiPath(pathname) {
  return /(^|\/)api\/chat$/i.test(pathname)
}

export function shouldRenderApiModeRow(apiMode) {
  if (!apiMode || typeof apiMode !== 'object') return false
  const groupName = normalizeText(apiMode.groupName)
  if (!groupName) return false
  return Boolean(normalizeText(apiMode.itemName) || AlwaysCustomGroups.includes(groupName))
}

function ensureLeadingSlash(value, fallback) {
  const normalized = normalizeText(value)
  if (!normalized) return fallback
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function resolveProviderChatEndpointFromBaseUrl(provider) {
  const baseUrl = normalizeProviderEndpointUrl(provider?.baseUrl)
  if (!baseUrl) return ''

  const defaultChatPath = '/v1/chat/completions'
  const defaultCompletionPath = '/v1/completions'
  const chatPath = ensureLeadingSlash(provider?.chatCompletionsPath, defaultChatPath)
  const completionsPath = ensureLeadingSlash(provider?.completionsPath, defaultCompletionPath)
  const hasExplicitEndpointUrl = Boolean(
    normalizeProviderEndpointUrl(provider?.chatCompletionsUrl) ||
      normalizeProviderEndpointUrl(provider?.completionsUrl),
  )
  const usesDefaultV1Paths =
    chatPath === defaultChatPath && completionsPath === defaultCompletionPath
  if (!hasExplicitEndpointUrl && usesDefaultV1Paths && /\/v1$/i.test(baseUrl)) {
    return `${baseUrl}/chat/completions`
  }

  return `${baseUrl}${chatPath}`
}

function normalizeApiModeSignature(apiMode) {
  if (!apiMode || typeof apiMode !== 'object') return null
  return JSON.stringify({
    groupName: normalizeText(apiMode.groupName),
    itemName: normalizeText(apiMode.itemName),
    isCustom: Boolean(apiMode.isCustom),
    customName: normalizeText(apiMode.customName),
    providerId: normalizeText(apiMode.providerId),
    active: apiMode.active !== false,
  })
}

function normalizeCustomApiModeRecoverySignature(apiMode) {
  if (!apiMode || typeof apiMode !== 'object') return null
  return JSON.stringify({
    groupName: normalizeText(apiMode.groupName),
    itemName: normalizeText(apiMode.itemName),
    isCustom: Boolean(apiMode.isCustom),
    customName: normalizeText(apiMode.customName),
    providerId: normalizeProviderId(apiMode.providerId),
  })
}

export function createProviderId(providerName, existingProviders, reservedProviderIds = []) {
  const providers = Array.isArray(existingProviders) ? existingProviders : []
  const usedIds = new Set([
    ...reservedProviderIds.map((providerId) => normalizeProviderId(providerId)),
    ...providers.map((provider) => normalizeProviderId(provider.id)),
  ])

  const baseId = normalizeProviderId(providerName) || `custom-provider-${providers.length + 1}`
  let nextId = baseId
  let suffix = 2
  while (usedIds.has(nextId)) {
    nextId = `${baseId}-${suffix}`
    suffix += 1
  }
  return nextId
}

export function resolveSelectableProviderId(providerId, providers, fallbackProviderId = '') {
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return fallbackProviderId
  const normalizedLookupProviderId = normalizeProviderId(normalizedProviderId)
  const matchedProvider =
    Array.isArray(providers) &&
    providers.find(
      (provider) =>
        normalizeProviderId(provider?.id) === normalizedLookupProviderId &&
        provider?.enabled !== false,
    )
  if (!matchedProvider) return fallbackProviderId
  return normalizeText(matchedProvider?.id) || normalizedProviderId
}

export function resolveEditingProviderSelection(
  providerId,
  providers,
  legacyProviderId = 'legacy-custom-default',
) {
  const normalizedProviderId = normalizeText(providerId)
  const normalizedLegacyProviderId = normalizeText(legacyProviderId)
  if (!normalizedProviderId || normalizedProviderId === normalizedLegacyProviderId) {
    return normalizedLegacyProviderId
  }
  return resolveSelectableProviderId(normalizedProviderId, providers, '')
}

export function applyPendingProviderChanges(
  providers,
  pendingEditedProvidersById = {},
  pendingNewProvider = null,
  pendingDeletedProviderIds = [],
) {
  const baseProviders = Array.isArray(providers) ? providers : []
  const editedProviders =
    pendingEditedProvidersById && typeof pendingEditedProvidersById === 'object'
      ? pendingEditedProvidersById
      : {}
  const deletedProviderIds = new Set(
    (Array.isArray(pendingDeletedProviderIds) ? pendingDeletedProviderIds : []).map((providerId) =>
      normalizeText(providerId),
    ),
  )

  const effectiveProviders = baseProviders
    .filter((provider) => !deletedProviderIds.has(normalizeText(provider?.id)))
    .map((provider) => {
      const providerId = normalizeText(provider?.id)
      return providerId && editedProviders[providerId] ? editedProviders[providerId] : provider
    })

  if (!pendingNewProvider || typeof pendingNewProvider !== 'object') {
    return effectiveProviders
  }

  const pendingNewProviderId = normalizeText(pendingNewProvider.id)
  if (!pendingNewProviderId || deletedProviderIds.has(pendingNewProviderId)) {
    return effectiveProviders
  }

  const existingProviderIndex = effectiveProviders.findIndex(
    (provider) => normalizeText(provider?.id) === pendingNewProviderId,
  )
  if (existingProviderIndex !== -1) {
    effectiveProviders[existingProviderIndex] = pendingNewProvider
    return effectiveProviders
  }

  return [...effectiveProviders, pendingNewProvider]
}

export function getSelectableProviders(providers = []) {
  return (Array.isArray(providers) ? providers : []).filter(
    (provider) => provider && provider.enabled !== false,
  )
}

export function removePendingProviderDeletion(providerIds = [], providerId = '') {
  const normalizedProviderId = normalizeText(providerId)
  return (Array.isArray(providerIds) ? providerIds : []).filter(
    (currentProviderId) => normalizeText(currentProviderId) !== normalizedProviderId,
  )
}

export function getProviderReferenceCheckApiModes(
  apiModes = [],
  editing = false,
  editingIndex = -1,
) {
  const normalizedApiModes = Array.isArray(apiModes) ? apiModes : []
  if (!editing) return normalizedApiModes
  if (editingIndex === -1) return normalizedApiModes
  return normalizedApiModes.filter((_, index) => index !== editingIndex)
}

export function getConfiguredCustomApiModesForSessionRecovery(
  apiModes = [],
  selectedApiMode = null,
) {
  const configuredCustomApiModes = Array.isArray(apiModes)
    ? apiModes.filter((apiMode) => normalizeText(apiMode?.groupName) === 'customApiModelKeys')
    : []
  const nextConfiguredCustomApiModes = [...configuredCustomApiModes]
  if (normalizeText(selectedApiMode?.groupName) !== 'customApiModelKeys') {
    return nextConfiguredCustomApiModes
  }

  const selectedSignature = normalizeCustomApiModeRecoverySignature(selectedApiMode)
  if (!selectedSignature) return nextConfiguredCustomApiModes
  const hasMatchedSelectedApiMode = nextConfiguredCustomApiModes.some(
    (apiMode) => normalizeCustomApiModeRecoverySignature(apiMode) === selectedSignature,
  )
  if (!hasMatchedSelectedApiMode) {
    nextConfiguredCustomApiModes.push(selectedApiMode)
  }
  return nextConfiguredCustomApiModes
}

export function shouldIncludeSelectedApiModeInReferenceCheck(
  apiModes = [],
  editing = false,
  editingIndex = -1,
  selectedApiMode = null,
) {
  if (!selectedApiMode || typeof selectedApiMode !== 'object') return false
  if (!editing || editingIndex === -1) return true

  const normalizedApiModes = Array.isArray(apiModes) ? apiModes : []
  const editingApiMode = normalizedApiModes[editingIndex]
  return normalizeApiModeSignature(editingApiMode) !== normalizeApiModeSignature(selectedApiMode)
}

export function applyDeletedProviderSecrets(providerSecrets = {}, pendingDeletedProviderIds = []) {
  const nextProviderSecrets =
    providerSecrets && typeof providerSecrets === 'object' ? { ...providerSecrets } : {}

  for (const providerId of Array.isArray(pendingDeletedProviderIds)
    ? pendingDeletedProviderIds
    : []) {
    const normalizedProviderId = normalizeText(providerId)
    if (normalizedProviderId) nextProviderSecrets[normalizedProviderId] = ''
  }

  return nextProviderSecrets
}

export async function loadSavedConversationState(loadSessions) {
  try {
    const stored = await loadSessions()
    return {
      sessions: Array.isArray(stored?.sessions) ? stored.sessions : [],
      sessionsLoaded: true,
      error: null,
    }
  } catch (error) {
    return {
      sessions: [],
      sessionsLoaded: false,
      error,
    }
  }
}

export function shouldHandleSavedConversationStorageChange(changes, areaName) {
  return areaName === 'local' && Object.hasOwn(changes ?? {}, 'sessions')
}

export async function persistApiModeConfigUpdate(updateConfig, payload, onPersisted = () => {}) {
  await updateConfig(payload, { propagateError: true })
  onPersisted()
}

export function shouldPersistPendingProviderChanges(hasPendingProviderChanges) {
  return Boolean(hasPendingProviderChanges)
}

export function shouldPersistDeletedProviderChanges(pendingDeletedProviderIds = []) {
  return (Array.isArray(pendingDeletedProviderIds) ? pendingDeletedProviderIds : []).length > 0
}

export function resolveEditingProviderIdForGroupChange(
  groupName,
  currentProviderId,
  fallbackProviderId = '',
) {
  const normalizedProviderId = normalizeText(currentProviderId)
  if (normalizeText(groupName) === 'customApiModelKeys') {
    return normalizedProviderId || fallbackProviderId
  }
  return normalizedProviderId
}

export function applySelectedProviderToApiMode(
  apiMode,
  selectedProviderId,
  shouldClearProviderDerivedFields = false,
  isEndpointProviderManaged = false,
) {
  const nextApiMode = apiMode && typeof apiMode === 'object' ? { ...apiMode } : {}
  const currentProviderId = normalizeText(nextApiMode.providerId)
  const nextProviderId = normalizeText(selectedProviderId)
  nextApiMode.providerId = nextProviderId
  const shouldPreserveLegacyCustomUrl =
    !isEndpointProviderManaged &&
    !shouldClearProviderDerivedFields &&
    currentProviderId === 'legacy-custom-default' &&
    nextProviderId === 'legacy-custom-default'
  if (!shouldPreserveLegacyCustomUrl) {
    nextApiMode.customUrl = ''
  }
  if (shouldClearProviderDerivedFields) {
    nextApiMode.apiKey = ''
    delete nextApiMode.sourceProviderId
  }
  return nextApiMode
}

export function sanitizeApiModeForSave(apiMode) {
  const nextApiMode = apiMode && typeof apiMode === 'object' ? { ...apiMode } : {}
  if (normalizeText(nextApiMode.groupName) !== 'customApiModelKeys') {
    nextApiMode.providerId = ''
    nextApiMode.apiKey = ''
    nextApiMode.customUrl = ''
    delete nextApiMode.sourceProviderId
  }
  return nextApiMode
}

export function parseChatCompletionsEndpointUrl(value) {
  const normalizedUrl = normalizeProviderEndpointUrl(value)
  if (!normalizedUrl) return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }

  let parsedUrl
  try {
    parsedUrl = new URL(normalizedUrl)
  } catch {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  if (parsedUrl.username || parsedUrl.password) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  if (parsedUrl.hash) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, '') || '/'
  if (
    normalizedPathname === '/' ||
    /^\/v\d+$/i.test(normalizedPathname) ||
    hasNativeOllamaChatApiPath(normalizedPathname)
  ) {
    return { valid: false, chatCompletionsUrl: '', completionsUrl: '' }
  }

  parsedUrl.pathname = normalizedPathname
  const chatCompletionsUrl = parsedUrl.toString().replace(/\/+$/, '')
  let completionsUrl = ''
  if (/\/chat\/completions$/i.test(normalizedPathname)) {
    const parsedCompletionUrl = new URL(chatCompletionsUrl)
    parsedCompletionUrl.pathname = parsedCompletionUrl.pathname.replace(
      /\/chat\/completions$/i,
      '/completions',
    )
    completionsUrl = parsedCompletionUrl.toString().replace(/\/+$/, '')
  }
  return { valid: true, chatCompletionsUrl, completionsUrl }
}

export function validateProviderEndpointDraft(value) {
  const parsedEndpoint = parseChatCompletionsEndpointUrl(value)
  return { valid: parsedEndpoint.valid, parsedEndpoint }
}

export function resolveProviderChatEndpointUrl(provider) {
  if (!provider || typeof provider !== 'object') return ''
  const explicitUrl = normalizeProviderEndpointUrl(provider.chatCompletionsUrl)
  if (explicitUrl) return explicitUrl

  return resolveProviderChatEndpointFromBaseUrl(provider)
}

export function buildEditedProvider(
  existingProvider,
  providerId,
  providerName,
  parsedEndpoint,
  nextApiUrl,
) {
  const normalizedNextApiUrl = normalizeProviderEndpointUrl(nextApiUrl)
  const existingApiUrl = resolveProviderChatEndpointUrl(existingProvider)
  const urlChanged = normalizedNextApiUrl !== existingApiUrl

  const updatedProvider = {
    ...(existingProvider || {}),
    id: providerId,
    name: providerName,
  }

  if (!urlChanged) return updatedProvider

  updatedProvider.baseUrl = ''
  updatedProvider.chatCompletionsUrl = parsedEndpoint.chatCompletionsUrl
  updatedProvider.completionsUrl = parsedEndpoint.completionsUrl
  return updatedProvider
}

export function isProviderReferencedByApiModes(providerId, apiModes = []) {
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return false
  return (Array.isArray(apiModes) ? apiModes : []).some(
    (apiMode) =>
      normalizeText(apiMode?.groupName) === 'customApiModelKeys' &&
      normalizeText(apiMode?.providerId) === normalizedProviderId,
  )
}

export function isProviderDeleteDisabled(isProviderReferenced = false, sessionsLoaded = true) {
  return !sessionsLoaded || isProviderReferenced
}

export function getProviderDeleteDisabledReasonKey(
  isProviderReferenced = false,
  sessionsLoaded = true,
) {
  if (!sessionsLoaded) return 'Loading saved conversations…'
  if (isProviderReferenced) {
    return 'This provider is still used by other API modes or saved conversations'
  }
  return ''
}

function getProvidersMatchingLegacySessionUrl(providers = [], session = null) {
  const customUrl = normalizeProviderEndpointUrl(session?.apiMode?.customUrl)
  if (!customUrl) return []

  return (Array.isArray(providers) ? providers : []).filter((provider) => {
    if (provider?.enabled === false) return false

    const directChatCompletionsUrl = normalizeProviderEndpointUrl(provider?.chatCompletionsUrl)
    if (directChatCompletionsUrl && directChatCompletionsUrl === customUrl) return true
    if (directChatCompletionsUrl) return false

    const derivedChatCompletionsUrl = resolveProviderChatEndpointFromBaseUrl(provider)
    return normalizeProviderEndpointUrl(derivedChatCompletionsUrl) === customUrl
  })
}

function getProvidersMatchingSessionProviderId(providers = [], providerId = '') {
  const normalizedProviderId = normalizeText(providerId)
  if (!normalizedProviderId) return []

  const exactMatches = (Array.isArray(providers) ? providers : []).filter(
    (provider) =>
      provider?.enabled !== false && normalizeText(provider?.id) === normalizedProviderId,
  )
  if (exactMatches.length > 0) return exactMatches

  const migratedProviderId = normalizeProviderId(normalizedProviderId)
  if (!migratedProviderId || migratedProviderId === normalizedProviderId) return []

  return (Array.isArray(providers) ? providers : []).filter(
    (provider) => provider?.enabled !== false && normalizeText(provider?.id) === migratedProviderId,
  )
}

function isProviderReferencedBySessionsViaProviderId(providerId, sessions = [], providers = []) {
  const normalizedTargetProviderId = normalizeText(providerId)
  if (!normalizedTargetProviderId || normalizedTargetProviderId === 'legacy-custom-default') {
    return false
  }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (normalizeText(session?.apiMode?.groupName) !== 'customApiModelKeys') continue

    const sessionProviderId = normalizeText(session?.apiMode?.providerId)
    if (!sessionProviderId || sessionProviderId === 'legacy-custom-default') continue

    const matchedByProviderId = getProvidersMatchingSessionProviderId(providers, sessionProviderId)
    const matchesTargetProvider = matchedByProviderId.some(
      (provider) => normalizeText(provider?.id) === normalizedTargetProviderId,
    )
    if (matchesTargetProvider) return true
  }

  return false
}

function getProviderIdsMatchingSessionLabel(session = null, providers = [], apiModes = []) {
  if (normalizeText(session?.apiMode?.groupName) !== 'customApiModelKeys') return []

  const normalizedSessionLabel = {
    groupName: normalizeText(session?.apiMode?.groupName),
    itemName: normalizeText(session?.apiMode?.itemName),
    isCustom: Boolean(session?.apiMode?.isCustom),
    customName: normalizeText(session?.apiMode?.customName),
  }
  if (!normalizedSessionLabel.customName) return []

  const allCandidates = (Array.isArray(apiModes) ? apiModes : []).filter((apiMode) => {
    if (!apiMode || typeof apiMode !== 'object') return false
    return (
      normalizeText(apiMode.groupName) === normalizedSessionLabel.groupName &&
      normalizeText(apiMode.customName) === normalizedSessionLabel.customName
    )
  })
  const exactCandidates = allCandidates.filter(
    (apiMode) =>
      normalizeText(apiMode?.itemName) === normalizedSessionLabel.itemName &&
      Boolean(apiMode?.isCustom) === normalizedSessionLabel.isCustom,
  )
  const matchedApiModes = exactCandidates.length === 1 ? exactCandidates : []
  const isLegacyCustomShape = !normalizedSessionLabel.itemName
  const fallbackApiModes =
    matchedApiModes.length === 0 && isLegacyCustomShape && allCandidates.length === 1
      ? allCandidates
      : matchedApiModes

  return fallbackApiModes
    .map((apiMode) => normalizeProviderId(apiMode?.providerId))
    .filter((providerId) => providerId && providerId !== 'legacy-custom-default')
    .filter((providerId, index, providerIds) => providerIds.indexOf(providerId) === index)
    .filter((providerId) =>
      (Array.isArray(providers) ? providers : []).some(
        (provider) => provider?.enabled !== false && normalizeText(provider?.id) === providerId,
      ),
    )
}

function canSessionRecoverViaLegacyLabelFallback(session = null, apiModes = []) {
  if (normalizeText(session?.apiMode?.groupName) !== 'customApiModelKeys') return false

  const normalizedSessionLabel = {
    groupName: normalizeText(session?.apiMode?.groupName),
    itemName: normalizeText(session?.apiMode?.itemName),
    isCustom: Boolean(session?.apiMode?.isCustom),
    customName: normalizeText(session?.apiMode?.customName),
  }
  if (!normalizedSessionLabel.customName) return false

  const allCandidates = (Array.isArray(apiModes) ? apiModes : []).filter((apiMode) => {
    if (!apiMode || typeof apiMode !== 'object') return false
    return (
      normalizeText(apiMode.groupName) === normalizedSessionLabel.groupName &&
      normalizeText(apiMode.customName) === normalizedSessionLabel.customName
    )
  })
  const exactCandidates = allCandidates.filter(
    (apiMode) =>
      normalizeText(apiMode?.itemName) === normalizedSessionLabel.itemName &&
      Boolean(apiMode?.isCustom) === normalizedSessionLabel.isCustom,
  )
  const matchedApiModes = exactCandidates.length === 1 ? exactCandidates : []
  const isLegacyCustomShape = !normalizedSessionLabel.itemName
  const fallbackApiModes =
    matchedApiModes.length === 0 && isLegacyCustomShape && allCandidates.length === 1
      ? allCandidates
      : matchedApiModes

  return fallbackApiModes
    .map((apiMode) => normalizeProviderId(apiMode?.providerId))
    .filter((providerId, index, providerIds) => providerIds.indexOf(providerId) === index)
    .includes('legacy-custom-default')
}

export function getReferencedCustomProviderIdsFromSessions(
  sessions = [],
  providers = [],
  apiModes = [],
) {
  const referencedProviderIds = new Set()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (normalizeText(session?.apiMode?.groupName) !== 'customApiModelKeys') continue
    const providerId = normalizeText(session?.apiMode?.providerId)
    if (providerId && providerId !== 'legacy-custom-default') {
      const matchedProviders = getProvidersMatchingSessionProviderId(providers, providerId)
      if (matchedProviders.length > 0) {
        for (const provider of matchedProviders) {
          const matchedProviderId = normalizeText(provider?.id)
          if (matchedProviderId && matchedProviderId !== 'legacy-custom-default') {
            referencedProviderIds.add(matchedProviderId)
          }
        }
        continue
      }
      if (!(Array.isArray(providers) ? providers : []).length) {
        referencedProviderIds.add(providerId)
        continue
      }
    }

    const matchedByCustomUrl = getProvidersMatchingLegacySessionUrl(providers, session)
    if (matchedByCustomUrl.length > 0) {
      for (const provider of matchedByCustomUrl) {
        const matchedProviderId = normalizeText(provider?.id)
        if (matchedProviderId && matchedProviderId !== 'legacy-custom-default') {
          referencedProviderIds.add(matchedProviderId)
        }
      }
      continue
    }

    for (const matchedProviderId of getProviderIdsMatchingSessionLabel(
      session,
      providers,
      apiModes,
    )) {
      if (matchedProviderId && matchedProviderId !== 'legacy-custom-default') {
        referencedProviderIds.add(matchedProviderId)
      }
    }
  }
  return Array.from(referencedProviderIds)
}

export function isProviderReferencedBySessionsViaUrl(
  providerId,
  sessions = [],
  providers = [],
  apiModes = [],
  providerSecrets = {},
) {
  const normalizedTargetProviderId = normalizeText(providerId)
  if (!normalizedTargetProviderId || normalizedTargetProviderId === 'legacy-custom-default') {
    return false
  }

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (normalizeText(session?.apiMode?.groupName) !== 'customApiModelKeys') continue

    const matchedByProviderId = getProvidersMatchingSessionProviderId(
      providers,
      session?.apiMode?.providerId,
    )
    if (matchedByProviderId.length > 0) continue

    const matchedByCustomUrl = getProvidersMatchingLegacySessionUrl(providers, session)
    const matchesTargetByCustomUrl = matchedByCustomUrl.some(
      (provider) => normalizeText(provider?.id) === normalizedTargetProviderId,
    )
    if (!matchesTargetByCustomUrl) continue
    const sessionApiKey =
      session?.apiMode &&
      typeof session.apiMode === 'object' &&
      typeof session.apiMode.apiKey === 'string'
        ? session.apiMode.apiKey.trim()
        : ''
    if (matchedByCustomUrl.length > 1 && sessionApiKey) {
      const matchedBySessionKey = matchedByCustomUrl.filter((provider) => {
        if (!provider || typeof provider !== 'object') return false
        const providerSecretValue =
          providerSecrets && typeof providerSecrets === 'object' ? providerSecrets[provider.id] : ''
        return String(providerSecretValue || '').trim() === sessionApiKey
      })
      if (
        matchedBySessionKey.length === 1 &&
        normalizeText(matchedBySessionKey[0]?.id) !== normalizedTargetProviderId
      ) {
        continue
      }
    }

    const matchedByLabel = getProviderIdsMatchingSessionLabel(session, providers, apiModes)
    if (matchedByLabel.length > 0) continue
    if (canSessionRecoverViaLegacyLabelFallback(session, apiModes)) continue

    return true
  }

  return false
}

export function isProviderEndpointRewriteBlockedBySavedConversations(
  providerId,
  sessionsLoaded = true,
  sessions = [],
  providers = [],
  apiModes = [],
  providerSecrets = {},
) {
  if (!sessionsLoaded) return true

  const normalizedTargetProviderId = normalizeProviderId(providerId)
  const isProviderReferencedBySessionsViaLabel = () => {
    if (!normalizedTargetProviderId || normalizedTargetProviderId === 'legacy-custom-default') {
      return false
    }

    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (normalizeText(session?.apiMode?.groupName) !== 'customApiModelKeys') continue
      if (
        getProvidersMatchingSessionProviderId(providers, session?.apiMode?.providerId).length > 0
      ) {
        continue
      }
      if (getProvidersMatchingLegacySessionUrl(providers, session).length > 0) {
        continue
      }
      if (
        getProviderIdsMatchingSessionLabel(session, providers, apiModes).includes(
          normalizedTargetProviderId,
        )
      ) {
        return true
      }
    }

    return false
  }

  return (
    isProviderReferencedBySessionsViaProviderId(providerId, sessions, providers) ||
    isProviderReferencedBySessionsViaUrl(
      providerId,
      sessions,
      providers,
      apiModes,
      providerSecrets,
    ) ||
    isProviderReferencedBySessionsViaLabel()
  )
}

export function getApiModeDisplayLabel(apiMode, t, providers = []) {
  const modelName = apiModeToModelName(apiMode)
  const fallbackLabel = modelNameToDesc(modelName, t)

  if (normalizeText(apiMode?.groupName) !== 'customApiModelKeys') {
    return fallbackLabel
  }

  const providerId = normalizeProviderId(apiMode?.providerId)
  const customModelName = normalizeText(apiMode?.customName)
  if (!providerId || providerId === 'legacy-custom-default') {
    return fallbackLabel
  }

  const provider = (Array.isArray(providers) ? providers : []).find(
    (item) => normalizeProviderId(item?.id) === providerId,
  )
  const providerName = normalizeText(provider?.name)
  if (!providerName) return fallbackLabel
  if (!customModelName) return providerName
  return `${providerName} (${customModelName})`
}

export function getConversationAiName(session, t, providers = []) {
  const apiMode = session?.apiMode
  let providerAwareName = apiMode ? getApiModeDisplayLabel(apiMode, t, providers) : ''
  const hasMissingCustomProvider =
    normalizeText(apiMode?.groupName) === 'customApiModelKeys' &&
    normalizeProviderId(apiMode?.providerId) &&
    normalizeProviderId(apiMode?.providerId) !== 'legacy-custom-default' &&
    !(Array.isArray(providers) ? providers : []).some(
      (provider) => normalizeProviderId(provider?.id) === normalizeProviderId(apiMode?.providerId),
    )

  if (hasMissingCustomProvider) {
    providerAwareName = ''
  }

  return providerAwareName || session?.aiName || modelNameToDesc(session?.modelName, t)
}
