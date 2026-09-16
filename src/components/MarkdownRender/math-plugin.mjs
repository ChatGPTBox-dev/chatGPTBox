import { katexPlugin } from '@aeven-ai/hypermarkdown/plugins/math'

/** The minimal build swaps this module for math-plugin-without-katex.mjs; see build.mjs. */
export const mathPlugin = katexPlugin
