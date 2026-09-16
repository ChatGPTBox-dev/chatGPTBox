/**
 * Shared rehype-highlight options.
 *
 * Auto-detection compiles every registered grammar the first time it runs, which costs
 * >100ms on a cold page. Scanning only common languages keeps that near 3ms. Explicitly
 * labelled code blocks are unaffected: the subset only narrows automatic detection, they
 * still use every grammar lowlight has registered.
 */
export const highlightOptions = {
  detect: true,
  subset: [
    'bash',
    'c',
    'cpp',
    'csharp',
    'css',
    'go',
    'java',
    'javascript',
    'json',
    'kotlin',
    'php',
    'python',
    'ruby',
    'rust',
    'sql',
    'swift',
    'typescript',
    'xml',
    'yaml',
  ],
  ignoreMissing: true,
  plainText: ['diagnostic'],
}
