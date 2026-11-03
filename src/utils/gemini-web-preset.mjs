export const GEMINI_WEB_MODELS = ['auto', 'flash-lite', 'flash', 'thinking', 'pro']

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key)
}

function inferGeminiWebModel(customName) {
  if (customName.includes('flash-lite')) return 'flash-lite'
  if (/(^|\s)flash(\s|$)/.test(customName)) return 'flash'
  if (/(^|\s)pro(\s|$)/.test(customName)) return 'pro'
  if (customName.includes('thinking') && !customName.includes('flash')) return 'thinking'
  if (customName === 'auto') return 'auto'
  return undefined
}

export function resolveGeminiWebPreset(apiMode, fallbackConfig = {}) {
  const hasStoredModelField = hasOwn(apiMode, 'geminiWebModel')
  const hasStoredModel = GEMINI_WEB_MODELS.includes(apiMode?.geminiWebModel)
  const hasStoredThinking = hasOwn(apiMode, 'geminiWebExtendedThinking')
  if (hasStoredModelField && !hasStoredModel) {
    return {
      model: apiMode?.geminiWebModel,
      extendedThinking: false,
      source: 'invalid',
    }
  }

  let model = hasStoredModel ? apiMode.geminiWebModel : undefined
  let extendedThinking = hasStoredThinking ? apiMode.geminiWebExtendedThinking === true : false
  let source = hasStoredModel ? 'stored' : 'default'
  const customName = String(apiMode?.customName || '').toLowerCase()

  if (!model) {
    model = inferGeminiWebModel(customName)
    if (model) source = 'legacy-name'
    if (
      model !== 'thinking' &&
      !hasStoredThinking &&
      (customName.includes('thinking') ||
        customName.includes('延伸思考') ||
        customName.includes('🧠'))
    ) {
      extendedThinking = true
    }
  }

  if (!model && hasOwn(fallbackConfig, 'geminiWebModel')) {
    if (!GEMINI_WEB_MODELS.includes(fallbackConfig?.geminiWebModel)) {
      return {
        model: fallbackConfig?.geminiWebModel,
        extendedThinking: false,
        source: 'invalid',
      }
    }
    model = fallbackConfig.geminiWebModel
    source = 'fallback'
    if (!hasStoredThinking) {
      extendedThinking = fallbackConfig.geminiWebExtendedThinking === true
    }
  }

  model ||= 'flash'
  return {
    model,
    extendedThinking: !['auto', 'thinking'].includes(model) && extendedThinking,
    source,
  }
}

export function hasDuplicateGeminiWebPreset(
  apiModes,
  candidate,
  editingIndex = -1,
  fallbackConfig = {},
) {
  if (candidate?.groupName !== 'bardWebModelKeys') return false

  const candidatePreset = resolveGeminiWebPreset(candidate, fallbackConfig)
  if (candidatePreset.source === 'invalid') return false

  return (Array.isArray(apiModes) ? apiModes : []).some((apiMode, index) => {
    if (index === editingIndex || apiMode?.groupName !== 'bardWebModelKeys') return false
    const preset = resolveGeminiWebPreset(apiMode, fallbackConfig)
    return (
      preset.source !== 'invalid' &&
      preset.model === candidatePreset.model &&
      preset.extendedThinking === candidatePreset.extendedThinking
    )
  })
}

export function getGeminiWebModelLabel(model, autoLabel = 'Auto') {
  switch (model) {
    case 'flash-lite':
      return 'Flash-Lite'
    case 'flash':
      return 'Flash'
    case 'thinking':
      return 'Thinking'
    case 'pro':
      return 'Pro'
    default:
      return autoLabel
  }
}
