import { AlwaysCustomGroups, ModelGroups, ModelMode, Models } from '../config/index.mjs'

export function modelNameToDesc(modelName, t, extraCustomModelName = '') {
  if (!t) t = (x) => x
  if (modelName in Models) {
    const desc = t(Models[modelName].desc)
    if (modelName === 'customModel' && extraCustomModelName)
      return `${desc} (${extraCustomModelName})`
    return desc
  }

  let desc = modelName
  if (isCustomModelName(modelName)) {
    const presetPart = modelNameToPresetPart(modelName)
    const customPart = modelNameToCustomPart(modelName)
    if (presetPart in Models) {
      if (customPart in ModelMode)
        desc = `${t(Models[presetPart].desc)} (${t(ModelMode[customPart])})`
      else desc = `${t(Models[presetPart].desc)} (${customPart})`
    } else if (presetPart in ModelGroups) {
      const baseDesc =
        presetPart === 'azureOpenAiApiModelKeys'
          ? Models.azureOpenAi.desc
          : ModelGroups[presetPart].desc
      desc = `${t(baseDesc)} (${customPart})`
    }
  }
  return desc
}

export function modelNameToPresetPart(modelName) {
  if (isCustomModelName(modelName)) {
    return modelName.split('-')[0]
  } else {
    return modelName
  }
}

export function modelNameToCustomPart(modelName) {
  if (isCustomModelName(modelName)) {
    return modelName.substring(modelName.indexOf('-') + 1)
  } else {
    return modelName
  }
}

export function modelNameToValue(modelName) {
  if (modelName in Models) return Models[modelName].value

  return modelNameToCustomPart(modelName)
}

export function getModelValue(configOrSession) {
  let value
  if (configOrSession.apiMode) value = modelNameToValue(apiModeToModelName(configOrSession.apiMode))
  else value = modelNameToValue(configOrSession.modelName)
  return value
}

export function isCustomModelName(modelName) {
  return modelName ? modelName.includes('-') : false
}

export function modelNameToApiMode(modelName) {
  const presetPart = modelNameToPresetPart(modelName)
  const found = getModelNameGroup(presetPart)
  if (found) {
    const [groupName] = found
    const isCustom = isCustomModelName(modelName)
    let customName = ''
    if (isCustom) customName = modelNameToCustomPart(modelName)
    return {
      groupName,
      itemName: presetPart,
      isCustom,
      customName,
      customUrl: '',
      apiKey: '',
      providerId: '',
      active: true,
    }
  }
}

export function normalizeApiMode(apiMode) {
  if (!apiMode || typeof apiMode !== 'object') return null
  return {
    ...apiMode,
    groupName: apiMode.groupName || '',
    itemName: apiMode.itemName || '',
    isCustom: Boolean(apiMode.isCustom),
    customName: apiMode.customName || '',
    customUrl: apiMode.customUrl || '',
    apiKey: apiMode.apiKey || '',
    providerId: typeof apiMode.providerId === 'string' ? apiMode.providerId.trim() : '',
    active: apiMode.active !== false,
  }
}

export function apiModeToModelName(apiMode) {
  apiMode = normalizeApiMode(apiMode)
  if (!apiMode) return ''
  if (AlwaysCustomGroups.includes(apiMode.groupName))
    return apiMode.groupName + '-' + apiMode.customName

  if (apiMode.isCustom) {
    if (apiMode.itemName === 'custom') return apiMode.groupName + '-' + apiMode.customName
    return apiMode.itemName + '-' + apiMode.customName
  }

  return apiMode.itemName
}

function resolveCanonicalActiveApiModeInfo(modelName, config) {
  let normalizedModelName = modelName
  if (normalizedModelName === 'azureOpenAi' && config.azureDeploymentName)
    normalizedModelName += '-' + config.azureDeploymentName
  if (
    (normalizedModelName === 'ollama' || normalizedModelName === 'ollamaModel') &&
    config.ollamaModelName
  ) {
    normalizedModelName = 'ollamaModel-' + config.ollamaModelName
  }
  const normalizedApiMode = modelNameToApiMode(normalizedModelName)
  const canonicalModelName = normalizedApiMode
    ? apiModeToModelName(normalizedApiMode)
    : normalizedModelName
  return { normalizedApiMode, canonicalModelName }
}

export function getApiModesFromConfig(config, onlyActive) {
  const normalizedCustomApiModes = (
    Array.isArray(config.customApiModes) ? config.customApiModes : []
  )
    .map((apiMode) => normalizeApiMode(apiMode))
    .filter((apiMode) => {
      if (!apiMode || !apiMode.groupName) return false
      if (AlwaysCustomGroups.includes(apiMode.groupName)) {
        return Boolean(apiMode.customName && apiMode.customName.trim())
      }
      return Boolean(apiMode.itemName)
    })
  const activeApiModes = Array.isArray(config.activeApiModes) ? config.activeApiModes : []
  const customApiModeIndexesByCanonicalModelName = normalizedCustomApiModes.reduce(
    (result, apiMode, index) => {
      const canonicalModelName = apiModeToModelName(apiMode)
      if (!canonicalModelName) return result
      const currentIndexes = result.get(canonicalModelName) || []
      currentIndexes.push(index)
      result.set(canonicalModelName, currentIndexes)
      return result
    },
    new Map(),
  )
  const mergedCustomApiModes = normalizedCustomApiModes.map((apiMode) => ({ ...apiMode }))
  const applyCanonicalLegacyItemName = (index, normalizedApiMode) => {
    const apiMode = mergedCustomApiModes[index]
    if (
      !apiMode ||
      apiMode.itemName ||
      !normalizedApiMode?.itemName ||
      apiMode.groupName !== normalizedApiMode.groupName
    ) {
      return
    }
    if (
      normalizedApiMode.itemName !== 'azureOpenAi' &&
      normalizedApiMode.itemName !== 'ollamaModel'
    )
      return
    mergedCustomApiModes[index] = { ...apiMode, itemName: normalizedApiMode.itemName }
  }
  const canonicalActiveApiModeNamesRepresentedByCustomRows = new Set()
  activeApiModes.forEach((modelName) => {
    const { normalizedApiMode, canonicalModelName } = resolveCanonicalActiveApiModeInfo(
      modelName,
      config,
    )
    if (!canonicalModelName) return
    const matchingCustomApiModeIndexes =
      customApiModeIndexesByCanonicalModelName.get(canonicalModelName) || []
    if (matchingCustomApiModeIndexes.length === 0) return
    if (matchingCustomApiModeIndexes.length === 1) {
      mergedCustomApiModes[matchingCustomApiModeIndexes[0]].active = true
      applyCanonicalLegacyItemName(matchingCustomApiModeIndexes[0], normalizedApiMode)
      canonicalActiveApiModeNamesRepresentedByCustomRows.add(canonicalModelName)
      return
    }
    const activeMatchingCustomApiModeIndexes = matchingCustomApiModeIndexes.filter(
      (index) => mergedCustomApiModes[index].active,
    )
    if (activeMatchingCustomApiModeIndexes.length > 0) {
      activeMatchingCustomApiModeIndexes.forEach((index) => {
        applyCanonicalLegacyItemName(index, normalizedApiMode)
      })
      canonicalActiveApiModeNamesRepresentedByCustomRows.add(canonicalModelName)
    }
  })

  const originalApiModes = activeApiModes
    .map((modelName) => {
      const { normalizedApiMode, canonicalModelName } = resolveCanonicalActiveApiModeInfo(
        modelName,
        config,
      )
      // 'customModel' is always active
      if (
        canonicalActiveApiModeNamesRepresentedByCustomRows.has(canonicalModelName) ||
        modelName === 'customModel'
      ) {
        return
      }
      return normalizedApiMode
    })
    .filter((apiMode) => apiMode)
  return [
    ...originalApiModes,
    ...mergedCustomApiModes.filter((apiMode) => (onlyActive ? apiMode.active : true)),
  ]
}

export function getApiModesStringArrayFromConfig(config, onlyActive) {
  return getApiModesFromConfig(config, onlyActive).map(apiModeToModelName)
}

export function isApiModeSelected(apiMode, configOrSession, { sessionCompat = false } = {}) {
  const normalizeForCompare = (value, { includeProviderState = true } = {}) => {
    const normalized = normalizeApiMode(value)
    if (!normalized) return null
    const normalizedForCompare = {
      groupName: normalized.groupName,
      itemName: normalized.itemName,
      isCustom: normalized.isCustom,
      customName: normalized.customName,
    }
    if (includeProviderState) {
      normalizedForCompare.providerId = normalized.providerId
      normalizedForCompare.active = normalized.active
    }
    return JSON.stringify(normalizedForCompare)
  }

  const matchesModelName = (targetApiMode) => {
    const targetModelName = apiModeToModelName(targetApiMode)
    if (!configOrSession?.modelName || !targetModelName) return false
    if (configOrSession.modelName === targetModelName) return true
    if (!targetApiMode?.active) return false
    const { canonicalModelName } = resolveCanonicalActiveApiModeInfo(
      configOrSession.modelName,
      configOrSession,
    )
    return canonicalModelName === targetModelName
  }

  const isLegacyCompatibleSessionMatch = (targetApiMode, selectedApiMode, rawSelectedApiMode) => {
    if (!targetApiMode || !selectedApiMode || !rawSelectedApiMode) return false
    if (selectedApiMode.groupName !== targetApiMode.groupName) return false

    const isLegacyCustomSession =
      selectedApiMode.groupName === 'customApiModelKeys' &&
      (!Object.hasOwn(rawSelectedApiMode, 'itemName') ||
        !Object.hasOwn(rawSelectedApiMode, 'isCustom'))

    if (isLegacyCustomSession) {
      if (targetApiMode.groupName !== 'customApiModelKeys') return false
      if (selectedApiMode.customName !== targetApiMode.customName) return false
    } else if (
      selectedApiMode.itemName !== targetApiMode.itemName ||
      selectedApiMode.isCustom !== targetApiMode.isCustom ||
      selectedApiMode.customName !== targetApiMode.customName
    ) {
      return false
    }

    if (!selectedApiMode.providerId) return true
    if (selectedApiMode.providerId === targetApiMode.providerId) return true
    if (!targetApiMode.providerId) return isLegacyCustomSession
    return isLegacyCustomSession
  }

  const targetApiMode = normalizeApiMode(apiMode)
  if (!targetApiMode) return false

  if (!configOrSession?.apiMode) {
    return matchesModelName(targetApiMode)
  }

  const rawSelectedApiMode = configOrSession.apiMode
  const selectedApiMode = normalizeApiMode(rawSelectedApiMode)
  if (!selectedApiMode) {
    return sessionCompat ? matchesModelName(targetApiMode) : false
  }

  if (selectedApiMode) {
    const selectedApiModeForCompare = normalizeForCompare(selectedApiMode)
    const targetApiModeForCompare = normalizeForCompare(targetApiMode)
    if (selectedApiModeForCompare && targetApiModeForCompare) {
      if (selectedApiModeForCompare === targetApiModeForCompare) return true
      if (
        sessionCompat &&
        // Historical sessions may carry stale providerId/active values after config migration.
        isLegacyCompatibleSessionMatch(targetApiMode, selectedApiMode, rawSelectedApiMode)
      ) {
        return true
      }
    }
  }

  return false
}

export function getUniquelySelectedApiModeIndex(
  apiModes,
  configOrSession,
  { sessionCompat = false } = {},
) {
  if (!Array.isArray(apiModes) || apiModes.length === 0) return -1

  let selectedIndex = -1
  for (const [index, apiMode] of apiModes.entries()) {
    if (!isApiModeSelected(apiMode, configOrSession, { sessionCompat })) continue
    if (selectedIndex !== -1) return -1
    selectedIndex = index
  }

  return selectedIndex
}

// also match custom modelName, e.g. when modelName is bingFree4, configOrSession model is bingFree4-fast, it returns true
export function isUsingModelName(modelName, configOrSession) {
  let configOrSessionModelName = configOrSession.apiMode
    ? apiModeToModelName(configOrSession.apiMode)
    : configOrSession.modelName
  if (modelName === configOrSessionModelName) {
    return true
  }

  if (isCustomModelName(configOrSessionModelName)) {
    const presetPart = modelNameToPresetPart(configOrSessionModelName)
    if (presetPart in Models) configOrSessionModelName = presetPart
    else if (presetPart in ModelGroups) configOrSessionModelName = ModelGroups[presetPart].value[0]
  }
  return configOrSessionModelName === modelName
}

export function getModelNameGroup(modelName) {
  const presetPart = modelNameToPresetPart(modelName)
  return (
    Object.entries(ModelGroups).find(([k]) => presetPart === k) ||
    Object.entries(ModelGroups).find(([, g]) => g.value.includes(presetPart))
  )
}

export function getApiModeGroup(apiMode) {
  return getModelNameGroup(apiModeToModelName(apiMode))
}

export function isInApiModeGroup(apiModeGroup, configOrSession) {
  let foundGroup
  if (configOrSession.apiMode) foundGroup = getApiModeGroup(configOrSession.apiMode)
  else foundGroup = getModelNameGroup(configOrSession.modelName)

  if (!foundGroup) return false
  const [, { value: groupValue }] = foundGroup
  return groupValue === apiModeGroup
}
