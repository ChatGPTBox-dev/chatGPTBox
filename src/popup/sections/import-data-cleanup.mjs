import {
  canonicalizeApiMode,
  canonicalizeModelKey,
  canonicalizeModelKeyArray,
  canonicalizeSessionModelFields,
} from '../../config/model-key-migrations.mjs'
import { LEGACY_API_KEY_FIELD_BY_PROVIDER_ID } from '../../config/openai-provider-mappings.mjs'

const conflictingKeyPairs = [
  ['claudeApiKey', 'anthropicApiKey'],
  ['customClaudeApiUrl', 'customAnthropicApiUrl'],
]

const apiModeListKeys = ['activeApiModes', 'customApiModes', 'knownApiModeDefaultIds']
const apiModeSelectionKeys = ['modelName', 'apiMode']

function normalizeProviderId(value) {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    : ''
}

async function preserveExistingBuiltinSecrets(storageArea, data, normalizedData) {
  if (
    !Object.hasOwn(data, 'customOpenAIProviders') ||
    Object.hasOwn(data, 'providerSecrets') ||
    !Array.isArray(data.customOpenAIProviders) ||
    typeof storageArea.get !== 'function'
  ) {
    return
  }

  const importedProviderIds = new Set(
    data.customOpenAIProviders.map((provider) => normalizeProviderId(provider?.id)).filter(Boolean),
  )
  const relevantProviderIds = [...importedProviderIds].filter((providerId) =>
    Object.hasOwn(LEGACY_API_KEY_FIELD_BY_PROVIDER_ID, providerId),
  )
  if (relevantProviderIds.length === 0) return

  const legacyKeys = relevantProviderIds.map(
    (providerId) => LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[providerId],
  )
  const stored = await storageArea.get([
    'completedBuiltinProviderIdMigrations',
    'customOpenAIProviders',
    'providerSecrets',
    ...legacyKeys,
  ])
  const completedMigrations = new Set(
    Array.isArray(stored.completedBuiltinProviderIdMigrations)
      ? stored.completedBuiltinProviderIdMigrations.map(normalizeProviderId).filter(Boolean)
      : [],
  )
  const existingProviderIds = new Set(
    (Array.isArray(stored.customOpenAIProviders) ? stored.customOpenAIProviders : [])
      .map((provider) => normalizeProviderId(provider?.id))
      .filter(Boolean),
  )
  const existingProviderSecrets =
    stored.providerSecrets && typeof stored.providerSecrets === 'object'
      ? stored.providerSecrets
      : {}

  for (const providerId of relevantProviderIds) {
    const legacyKey = LEGACY_API_KEY_FIELD_BY_PROVIDER_ID[providerId]
    if (
      completedMigrations.has(providerId) &&
      !existingProviderIds.has(providerId) &&
      Object.hasOwn(existingProviderSecrets, providerId)
    ) {
      normalizedData[legacyKey] = existingProviderSecrets[providerId]
    }
  }
}

export function prepareImportData(data) {
  const normalizedData = { ...data }
  const keysToRemove = []
  const importsCompleteProviderState =
    Object.hasOwn(data, 'customOpenAIProviders') && Object.hasOwn(data, 'providerSecrets')

  if (
    importsCompleteProviderState &&
    !Object.hasOwn(data, 'completedBuiltinProviderIdMigrations')
  ) {
    normalizedData.completedBuiltinProviderIdMigrations = []
  }

  if (apiModeListKeys.some((key) => Object.hasOwn(data, key))) {
    for (const key of apiModeListKeys) {
      if (!Object.hasOwn(data, key)) normalizedData[key] = null
    }
    for (const key of apiModeSelectionKeys) {
      if (!Object.hasOwn(data, key)) keysToRemove.push(key)
    }
  }

  for (const [legacyKey, anthropicKey] of conflictingKeyPairs) {
    const hasLegacyKey = Object.hasOwn(data, legacyKey)
    const hasAnthropicKey = Object.hasOwn(data, anthropicKey)

    if (hasLegacyKey && !hasAnthropicKey) {
      normalizedData[anthropicKey] = data[legacyKey]
      keysToRemove.push(legacyKey)
    } else if (hasAnthropicKey && !hasLegacyKey) {
      normalizedData[legacyKey] = data[anthropicKey]
      keysToRemove.push(legacyKey)
    }
  }

  if (Object.hasOwn(normalizedData, 'modelName')) {
    normalizedData.modelName = canonicalizeModelKey(normalizedData.modelName)
  }
  if (Object.hasOwn(normalizedData, 'apiMode')) {
    normalizedData.apiMode = canonicalizeApiMode(normalizedData.apiMode)
  }
  if (Array.isArray(normalizedData.customApiModes)) {
    normalizedData.customApiModes = normalizedData.customApiModes.map(canonicalizeApiMode)
  }
  if (Array.isArray(normalizedData.activeApiModes)) {
    normalizedData.activeApiModes = canonicalizeModelKeyArray(normalizedData.activeApiModes)
  }
  if (Array.isArray(normalizedData.knownApiModeDefaultIds)) {
    normalizedData.knownApiModeDefaultIds = canonicalizeModelKeyArray(
      normalizedData.knownApiModeDefaultIds
        .filter((modelName) => typeof modelName === 'string')
        .map((modelName) => modelName.trim())
        .filter(Boolean),
    )
  }
  if (Array.isArray(normalizedData.sessions)) {
    normalizedData.sessions = normalizedData.sessions.map(canonicalizeSessionModelFields)
  }

  return { normalizedData, keysToRemove }
}

export async function importDataIntoStorage(storageArea, data) {
  const { normalizedData, keysToRemove } = prepareImportData(data)

  await preserveExistingBuiltinSecrets(storageArea, data, normalizedData)

  await storageArea.set(normalizedData)

  if (keysToRemove.length > 0) {
    await storageArea.remove(keysToRemove)
  }
}
