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
  const hasStoredModel = GEMINI_WEB_MODELS.includes(apiMode?.geminiWebModel)
  const hasStoredThinking = hasOwn(apiMode, 'geminiWebExtendedThinking')
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

  if (!model && GEMINI_WEB_MODELS.includes(fallbackConfig.geminiWebModel)) {
    model = fallbackConfig.geminiWebModel
    source = 'fallback'
    if (!hasStoredThinking) {
      extendedThinking = fallbackConfig.geminiWebExtendedThinking === true
    }
  }

  model ||= 'auto'
  return {
    model,
    extendedThinking: !['auto', 'thinking'].includes(model) && extendedThinking,
    source,
  }
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
