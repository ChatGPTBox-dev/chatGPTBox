function normalize(value, multiline) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  return multiline ? text : text.replace(/\s*\n\s*/g, ' ')
}

function escapeMarkdown(value, multiline) {
  return normalize(value, multiline)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):(?=\/\/)/g, '$1:\u200b')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+\-.!|:~])/g, '\\$1')
}

export const serializeMarkdownHeading = (value) => escapeMarkdown(value, false)
export const serializeMarkdownInline = (value) => escapeMarkdown(value, false)
export const serializeMarkdownListItem = (value) => escapeMarkdown(value, false)
export const serializeMarkdownParagraph = (value) =>
  escapeMarkdown(value, true)
    .split('\n')
    .map((line) => line || '\\ ')
    .join('\n')
