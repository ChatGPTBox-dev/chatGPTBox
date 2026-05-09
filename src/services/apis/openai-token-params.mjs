const OPENAI_MAX_COMPLETION_TOKENS_MODEL_PATTERN = /^(?:gpt-5(?:[.-]|$)|chat-latest$)/

function shouldUseMaxCompletionTokens(provider, model) {
  const normalizedProvider = String(provider || '').toLowerCase()
  const normalizedModel = String(model || '').toLowerCase()

  switch (true) {
    case normalizedProvider === 'openai' &&
      OPENAI_MAX_COMPLETION_TOKENS_MODEL_PATTERN.test(normalizedModel):
      return true
    default:
      return false
  }
}

export function getChatCompletionsTokenParams(provider, model, maxResponseTokenLength) {
  if (shouldUseMaxCompletionTokens(provider, model))
    return { max_completion_tokens: maxResponseTokenLength }

  return { max_tokens: maxResponseTokenLength }
}
