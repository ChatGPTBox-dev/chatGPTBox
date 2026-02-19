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
      active: true,
    }
  }
}

export function apiModeToModelName(apiMode) {
  if (AlwaysCustomGroups.includes(apiMode.groupName))
    return apiMode.groupName + '-' + apiMode.customName

  if (apiMode.isCustom) {
    if (apiMode.itemName === 'custom') return apiMode.groupName + '-' + apiMode.customName
    return apiMode.itemName + '-' + apiMode.customName
  }

  return apiMode.itemName
}

export function getApiModesFromConfig(config, onlyActive) {
  const stringApiModes = config.customApiModes
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
      if (modelName === 'ollama') modelName += '-' + config.ollamaModelName
      return modelNameToApiMode(modelName)
    })
    .filter((apiMode) => apiMode)
  return [
    ...originalApiModes,
    ...config.customApiModes.filter((apiMode) => (onlyActive ? apiMode.active : true)),
  ]
}

export function getApiModesStringArrayFromConfig(config, onlyActive) {
  return getApiModesFromConfig(config, onlyActive).map(apiModeToModelName)
}

export function isApiModeSelected(apiMode, configOrSession) {
  return configOrSession.apiMode
    ? JSON.stringify(configOrSession.apiMode, Object.keys(configOrSession.apiMode).sort()) ===
        JSON.stringify(apiMode, Object.keys(apiMode).sort())
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

export function isUsingReasoningModel(configOrSession) {
  const modelValue = getModelValue(configOrSession)
  if (!modelValue || typeof modelValue !== 'string') return false

  // Normalize model value to handle potential whitespace
  const normalizedModelValue = modelValue.trim().toLowerCase()

  // Match o1, o3, or o4 models with optional standard OpenAI suffixes
  // Uses word boundaries to prevent false positives like o10, o30, o40
  // Allows: o1, o1-preview, o1-mini, o3, o3-mini, o4, o4-mini, etc.
  // Prevents: o10, o30, o40, o1x, o3x, o4x, and other invalid patterns
  if (
    /^o[134](?:$|-(?:preview|mini|turbo|instruct|nano|small|medium|large))$/.test(
      normalizedModelValue,
    )
  ) {
    return true
  }

  // Match gpt-5* pattern but exclude gpt-5-chat-* variants
  // Allows: gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-preview, gpt-5-turbo
  // Prevents: gpt-5-chat-latest, gpt-5-chat, etc.
  if (normalizedModelValue.startsWith('gpt-5') && !normalizedModelValue.startsWith('gpt-5-chat')) {
    return true
  }

  return false
}
