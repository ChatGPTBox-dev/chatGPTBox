function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function anyText(items, fields) {
  return (Array.isArray(items) ? items : []).some((item) =>
    fields.some((field) => hasText(typeof item === 'string' ? item : item?.[field])),
  )
}

function validate({ meaningful, finishReason }) {
  if (finishReason === 'length') return { valid: false, reason: 'MODEL_OUTPUT_INCOMPLETE' }
  if (!meaningful) return { valid: false, reason: 'MODEL_OUTPUT_EMPTY' }
  return { valid: true, reason: null }
}

export function validateChunkSummaryOutput({ parsed, finishReason }) {
  return validate({
    meaningful:
      hasText(parsed?.localSummary) ||
      anyText(parsed?.keyPoints, ['point']) ||
      anyText(parsed?.candidates, ['text']),
    finishReason,
  })
}

export function validateFinalSummaryOutput({ parsed, finishReason }) {
  return validate({
    meaningful:
      hasText(parsed?.overview) ||
      anyText(parsed?.chapters, ['title', 'summary']) ||
      anyText(parsed?.keyMoments, ['point']),
    finishReason,
  })
}
