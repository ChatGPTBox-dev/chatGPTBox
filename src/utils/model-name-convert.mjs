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
      desc = `${t(ModelGroups[presetPart].desc)} (${customPart})`
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
    providerId: apiMode.providerId || '',
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

export function getApiModesFromConfig(config, onlyActive) {
  const normalizedCustomApiModes = (
    Array.isArray(config.customApiModes) ? config.customApiModes : []
  )
    .map((apiMode) => normalizeApiMode(apiMode))
    .filter((apiMode) => apiMode && apiMode.groupName && apiMode.itemName)

  const stringApiModes = normalizedCustomApiModes
    .map((apiMode) => {
      if (onlyActive) {
        if (apiMode.active) return apiModeToModelName(apiMode)
      } else return apiModeToModelName(apiMode)
      return false
    })
    .filter((apiMode) => apiMode)
  const originalApiModes = config.activeApiModes
    .map((modelName) => {
      // 'customModel' is always active
      if (stringApiModes.includes(modelName) || modelName === 'customModel') {
        return
      }
      if (modelName === 'azureOpenAi') modelName += '-' + config.azureDeploymentName
      if (modelName === 'ollama' || modelName === 'ollamaModel')
        modelName = 'ollamaModel-' + config.ollamaModelName
      return modelNameToApiMode(modelName)
    })
    .filter((apiMode) => apiMode)
  return [
    ...originalApiModes,
    ...normalizedCustomApiModes.filter((apiMode) => (onlyActive ? apiMode.active : true)),
  ]
}

export function getApiModesStringArrayFromConfig(config, onlyActive) {
  return getApiModesFromConfig(config, onlyActive).map(apiModeToModelName)
}

export function isApiModeSelected(apiMode, configOrSession) {
  const normalizeForCompare = (value) => {
    const normalized = normalizeApiMode(value)
    if (!normalized) return ''
    return JSON.stringify({
      groupName: normalized.groupName,
      itemName: normalized.itemName,
      isCustom: normalized.isCustom,
      customName: normalized.customName,
      providerId: normalized.providerId,
    })
  }
  return configOrSession.apiMode
    ? normalizeForCompare(configOrSession.apiMode) === normalizeForCompare(apiMode)
    : configOrSession.modelName === apiModeToModelName(apiMode)
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
