const MODELS_WITHOUT_CUSTOM_TEMPERATURE = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-5',
])

function normalizeModelId(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:anthropic|google)\//, '')
    .replace(/\./g, '-')
}

function matchesModelFamily(model, baseModel) {
  return (
    model === baseModel || model.startsWith(`${baseModel}-`) || model.startsWith(`${baseModel}:`)
  )
}

function isKnownModelWithoutCustomTemperature(model) {
  return [...MODELS_WITHOUT_CUSTOM_TEMPERATURE].some((baseModel) =>
    matchesModelFamily(model, baseModel),
  )
}

function isGeminiWithoutCustomTemperature(model) {
  const match = /^gemini-(\d+)(?:-(\d+))?(?=$|[-:])/.exec(model)
  if (!match) return false

  const major = Number(match[1])
  const minor = Number(match[2] || 0)
  if (major > 3) return true
  if (major !== 3) return false

  const isGemini35FlashLite = minor === 5 && matchesModelFamily(model, 'gemini-3-5-flash-lite')
  return minor >= 6 || isGemini35FlashLite
}

export function canApplyTemperatureOverride(model) {
  const normalizedModel = normalizeModelId(model)
  return (
    !isKnownModelWithoutCustomTemperature(normalizedModel) &&
    !isGeminiWithoutCustomTemperature(normalizedModel)
  )
}

export function getTemperatureParams(config, model) {
  if (config?.temperatureOverrideEnabled !== true) return {}
  if (!Number.isFinite(config?.temperature)) return {}
  if (!canApplyTemperatureOverride(model)) return {}
  return { temperature: config.temperature }
}
