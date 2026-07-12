import { defaultApiModeIds } from '../config/index.mjs'
import { canonicalizeModelKeyArray } from '../config/model-key-migrations.mjs'
import { isApiModeSelected } from '../utils/model-name-convert.mjs'

export const API_MODE_LIST_CONFIG_KEYS = [
  'activeApiModes',
  'customApiModes',
  'knownApiModeDefaultIds',
]

export function buildApiModeListConfigUpdate(config, nextApiModes, { selectionPatch = {} } = {}) {
  const knownApiModeDefaultIds = canonicalizeModelKeyArray([
    ...(Array.isArray(config?.knownApiModeDefaultIds) ? config.knownApiModeDefaultIds : []),
    ...defaultApiModeIds,
  ])

  return {
    ...selectionPatch,
    activeApiModes: [],
    customApiModes: Array.isArray(nextApiModes) ? nextApiModes : [],
    knownApiModeDefaultIds,
  }
}

export function getSelectionPatchWhenApiModeDisabled(apiMode, apiModes, config) {
  if (!isApiModeSelected(apiMode, config)) return {}

  const fallbackConfig = { ...config, apiMode: null }
  const hasFallback = apiModes.some((candidate) => isApiModeSelected(candidate, fallbackConfig))
  const disabledModeIsFallback = isApiModeSelected(apiMode, fallbackConfig)

  return {
    modelName: hasFallback && !disabledModeIsFallback ? config.modelName : 'customModel',
    apiMode: null,
  }
}

export function expandApiModeListConfigUpdate(currentConfig, value) {
  const nextValue = value && typeof value === 'object' ? value : {}
  if (!API_MODE_LIST_CONFIG_KEYS.some((key) => Object.hasOwn(nextValue, key))) {
    return nextValue
  }

  const includesSelectionUpdate =
    Object.hasOwn(nextValue, 'modelName') || Object.hasOwn(nextValue, 'apiMode')

  return {
    activeApiModes: currentConfig.activeApiModes,
    customApiModes: currentConfig.customApiModes,
    knownApiModeDefaultIds: currentConfig.knownApiModeDefaultIds,
    ...(includesSelectionUpdate
      ? {
          modelName: currentConfig.modelName,
          apiMode: currentConfig.apiMode,
        }
      : {}),
    ...nextValue,
  }
}
