const passthroughErrorMessages = new Set(['CLOUDFLARE', 'UNAUTHORIZED'])
const formattedErrorTextPattern = /(?:^|\n)(`{3,})(?:diagnostic|json)?\n[\s\S]*?\n\1(?=\n|$)/
const richErrorTextPattern = /[<>{}[\]()`*_~#|]/

function formatFencedErrorText(value, language) {
  const text = String(value)
  const backtickRuns = text.match(/`+/g) ?? []
  const delimiterLength =
    backtickRuns.reduce((longest, run) => Math.max(longest, run.length), 2) + 1
  const delimiter = '`'.repeat(delimiterLength)
  return `${delimiter}${language}\n${text}\n${delimiter}`
}

export function formatErrorText(value) {
  const text = String(value)
  if (passthroughErrorMessages.has(text)) return text

  return formatFencedErrorText(text, 'diagnostic')
}

export function formatErrorMessage(value) {
  const text = String(value)
  if (passthroughErrorMessages.has(text)) return text

  if (/^\s*[{[]/.test(text)) {
    try {
      return formatFencedErrorText(JSON.stringify(JSON.parse(text), null, 2), 'json')
    } catch {
      // Fall through and format malformed data based on its contents.
    }
  }

  return richErrorTextPattern.test(text) ? formatErrorText(text) : text
}

export function getDisplayErrorText(value, translate) {
  const text = String(value)
  return formattedErrorTextPattern.test(text) ? text : translate(text)
}
