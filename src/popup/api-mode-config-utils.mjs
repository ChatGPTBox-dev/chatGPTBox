import { defaultApiModeIds } from '../config/index.mjs'
import { canonicalizeModelKeyArray } from '../config/model-key-migrations.mjs'
import {
  getUniquelySelectedApiModeIndex,
  isApiModeSelected,
  modelNameToPresetPart,
  normalizeApiMode,
} from '../utils/model-name-convert.mjs'

const GEMINI_WEB_DEFAULT_MODEL = 'bardWebFree'

export const API_MODE_LIST_CONFIG_KEYS = [
  'activeApiModes',
  'customApiModes',
  'knownApiModeDefaultIds',
]

export function buildApiModeListConfigUpdate(config, nextApiModes, { selectionPatch = {} } = {}) {
  const implicitDefaultIds = Object.hasOwn(config ?? {}, 'geminiWebModel')
    ? [GEMINI_WEB_DEFAULT_MODEL]
    : []
  const knownApiModeDefaultIds = canonicalizeModelKeyArray([
    ...(Array.isArray(config?.knownApiModeDefaultIds) ? config.knownApiModeDefaultIds : []),
    ...defaultApiModeIds,
    ...implicitDefaultIds,
  ])

  return {
    ...selectionPatch,
    activeApiModes: [],
    customApiModes: Array.isArray(nextApiModes) ? nextApiModes : [],
    knownApiModeDefaultIds,
  }
}

export function getSelectionPatchWhenApiModeDisabled(apiMode, nextApiModes, config) {
  if (!isApiModeSelected(apiMode, config)) return {}

  const activeModes = nextApiModes.filter((candidate) => candidate.active !== false)
  if (config.apiMode?.groupName === 'bardWebModelKeys') {
    const selectedIndex = getUniquelySelectedApiModeIndex(activeModes, config)
    if (selectedIndex !== -1) {
      const selected = normalizeApiMode(config.apiMode)
      const remaining = activeModes[selectedIndex]
      const normalized = normalizeApiMode(remaining)
      if (
        normalized.isCustom === selected.isCustom &&
        normalized.customName === selected.customName
      ) {
        return {}
      }
      return { apiMode: remaining }
    }
  }

  if (
    !config.apiMode &&
    modelNameToPresetPart(config.modelName) === GEMINI_WEB_DEFAULT_MODEL &&
    activeModes.some((candidate) => isApiModeSelected(candidate, config))
  )
    return {}

  const fallbackConfig = { ...config, apiMode: null }
  const hasFallback = activeModes.some((candidate) => isApiModeSelected(candidate, fallbackConfig))
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
