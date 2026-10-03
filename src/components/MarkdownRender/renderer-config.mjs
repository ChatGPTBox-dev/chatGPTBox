import { highlightPlugin } from '@aeven-ai/hypermarkdown/plugins/code'
import { Hyperlink } from './Hyperlink'
import { highlightOptions } from './highlight-options.mjs'
import { mathPlugin } from './math-plugin.mjs'

// The answer and the thinking share one pipeline, so both renderers parse the same way.
// rehype-react keys elements by component identity, so these maps and plugin instances have
// to stay stable across renders or every block remounts.
export const PLUGINS = { math: mathPlugin(), code: highlightPlugin(highlightOptions) }
export const COMPONENTS = { a: Hyperlink }
// Fullscreen and the HTML preview expect the host to hide its own chrome around them, which
// this card does not do; the copy button is the part that works on its own.
export const CONTROLS = {
  code: { fullscreen: false, preview: false },
  table: { fullscreen: false },
}
// The loading placeholder is injected as HTML and styled through this class.
export const ALLOWED_TAGS = { p: ['className'] }
