const TOKEN_USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
]

function toTokenCount(value) {
  if (typeof value === 'string' && value.trim()) value = Number(value)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

function firstTokenCount(...values) {
  for (const value of values) {
    const tokenCount = toTokenCount(value)
    if (tokenCount !== undefined) return tokenCount
  }
  return undefined
}

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function compactUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const compacted = {}
  for (const key of TOKEN_USAGE_KEYS) {
    const value = toTokenCount(usage[key])
    if (value !== undefined) compacted[key] = value
  }
  if (
    compacted.totalTokens === undefined &&
    compacted.inputTokens !== undefined &&
    compacted.outputTokens !== undefined
  ) {
    compacted.totalTokens = compacted.inputTokens + compacted.outputTokens
  }
  return Object.keys(compacted).length > 0 ? compacted : null
}

export function mergeResponseMetadata(currentMetadata, nextMetadata) {
  const current = currentMetadata && typeof currentMetadata === 'object' ? currentMetadata : {}
  const next = nextMetadata && typeof nextMetadata === 'object' ? nextMetadata : {}
  const merged = {}

  const selectedModel =
    toNonEmptyString(next.selectedModel) || toNonEmptyString(current.selectedModel)
  const reportedModel =
    toNonEmptyString(next.reportedModel) || toNonEmptyString(current.reportedModel)
  if (selectedModel) merged.selectedModel = selectedModel
  if (reportedModel) merged.reportedModel = reportedModel

  const currentUsage = compactUsage(current.usage)
  const nextUsage = compactUsage(next.usage)
  const mergedUsage = { ...(currentUsage || {}), ...(nextUsage || {}) }
  if (
    nextUsage &&
    nextUsage.totalTokens === undefined &&
    (nextUsage.inputTokens !== undefined || nextUsage.outputTokens !== undefined)
  ) {
    delete mergedUsage.totalTokens
  }
  const usage = compactUsage(mergedUsage)
  if (usage) merged.usage = usage

  return Object.keys(merged).length > 0 ? merged : null
}

export function mergeOpenAIResponseMetadata(currentMetadata, data, selectedModel) {
  const usage = data?.usage
  const promptDetails = usage?.prompt_tokens_details
  const inputDetails = usage?.input_tokens_details
  const normalizedUsage = usage
    ? compactUsage({
        inputTokens: firstTokenCount(usage.prompt_tokens, usage.input_tokens),
        outputTokens: firstTokenCount(usage.completion_tokens, usage.output_tokens),
        totalTokens: firstTokenCount(usage.total_tokens),
        cacheReadInputTokens: firstTokenCount(
          promptDetails?.cached_tokens,
          inputDetails?.cached_tokens,
          usage.cache_read_input_tokens,
          usage.cache_read_tokens,
          usage.cached_tokens,
        ),
        cacheWriteInputTokens: firstTokenCount(
          promptDetails?.cache_write_tokens,
          inputDetails?.cache_write_tokens,
          usage.cache_creation_input_tokens,
          usage.cache_write_input_tokens,
          usage.cache_write_tokens,
        ),
      })
    : null

  const hasResponseMetadata = toNonEmptyString(data?.model) || normalizedUsage
  if (!hasResponseMetadata) return currentMetadata || null
  return mergeResponseMetadata(currentMetadata, {
    selectedModel,
    reportedModel: data?.model,
    usage: normalizedUsage,
  })
}

export function mergeClaudeResponseMetadata(currentMetadata, data, selectedModel) {
  const usage = data?.message?.usage || data?.usage
  const uncachedInputTokens = firstTokenCount(usage?.input_tokens)
  const cacheReadInputTokens = firstTokenCount(usage?.cache_read_input_tokens)
  const cacheWriteInputTokens = firstTokenCount(usage?.cache_creation_input_tokens)
  const inputParts = [uncachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens].filter(
    (value) => value !== undefined,
  )
  const currentInputTokens = toTokenCount(currentMetadata?.usage?.inputTokens)
  const hasInputUsage =
    Boolean(data?.message?.usage) ||
    (currentInputTokens === undefined &&
      (cacheReadInputTokens !== undefined ||
        cacheWriteInputTokens !== undefined ||
        (uncachedInputTokens !== undefined && uncachedInputTokens > 0)))
  const normalizedUsage = usage
    ? compactUsage({
        inputTokens:
          hasInputUsage && inputParts.length > 0
            ? inputParts.reduce((total, value) => total + value, 0)
            : undefined,
        outputTokens: firstTokenCount(usage.output_tokens),
        cacheReadInputTokens,
        cacheWriteInputTokens,
      })
    : null

  const reportedModel = data?.message?.model
  const hasResponseMetadata = toNonEmptyString(reportedModel) || normalizedUsage
  if (!hasResponseMetadata) return currentMetadata || null
  return mergeResponseMetadata(currentMetadata, {
    selectedModel,
    reportedModel,
    usage: normalizedUsage,
  })
}

export function createRecordMetadata(session, metadata) {
  return mergeResponseMetadata(metadata, {
    selectedModel: metadata?.selectedModel || session?.aiName,
  })
}

export function getRecordModel(metadata, fallbackModel = '') {
  return (
    toNonEmptyString(metadata?.reportedModel) ||
    toNonEmptyString(metadata?.selectedModel) ||
    toNonEmptyString(fallbackModel) ||
    ''
  )
}

export function formatTokenCount(value) {
  const tokenCount = toTokenCount(value)
  return tokenCount === undefined ? '' : tokenCount.toLocaleString()
}

export function summarizeConversationUsage(records) {
  const conversationRecords = Array.isArray(records) ? records : []
  const modelCounts = new Map()
  const summary = {
    totalTurns: conversationRecords.length,
    reportedTurns: 0,
    inputReportedTurns: 0,
    outputReportedTurns: 0,
    totalReportedTurns: 0,
    cacheReadReportedTurns: 0,
    cacheWriteReportedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    models: [],
  }

  for (const record of conversationRecords) {
    const model = getRecordModel(record?.meta)
    if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1)

    const usage = compactUsage(record?.meta?.usage)
    if (!usage) continue
    summary.reportedTurns += 1
    if (usage.inputTokens !== undefined) {
      summary.inputReportedTurns += 1
      summary.inputTokens += usage.inputTokens
    }
    if (usage.outputTokens !== undefined) {
      summary.outputReportedTurns += 1
      summary.outputTokens += usage.outputTokens
    }
    if (usage.totalTokens !== undefined) {
      summary.totalReportedTurns += 1
      summary.totalTokens += usage.totalTokens
    }
    if (usage.cacheReadInputTokens !== undefined) {
      summary.cacheReadReportedTurns += 1
      summary.cacheReadInputTokens += usage.cacheReadInputTokens
    }
    if (usage.cacheWriteInputTokens !== undefined) {
      summary.cacheWriteReportedTurns += 1
      summary.cacheWriteInputTokens += usage.cacheWriteInputTokens
    }
  }

  summary.models = Array.from(modelCounts, ([name, turns]) => ({ name, turns }))
  return summary
}
