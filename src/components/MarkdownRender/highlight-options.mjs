/**
 * Shared rehype-highlight options.
 *
 * Auto-detection compiles every registered grammar the first time it runs, which costs
 * >100ms on a cold page. Scanning a curated subset keeps that near a few milliseconds.
 * Explicitly labelled code blocks are unaffected: the subset only narrows automatic
 * detection, they still use every grammar lowlight has registered.
 *
 * The subset is lowlight's registered set minus entries that only mislead detection:
 * `shell` (the Shell Session console-prompt grammar, not a `bash` alias; `bash` aliases
 * only `sh`/`zsh`), `plaintext`/`python-repl`/`php-template` (not useful for detection),
 * and `arduino`/`objectivec`/`vbnet`/`wasm` (rare in answers, and they win ambiguous `c`,
 * `cpp`, `ini` and `sql` matches away from the right language). Keep the
 * order as lowlight registers them: `highlightAuto` settles equal-relevance candidates by
 * subset order, so reordering this list changes which language an ambiguous block detects as.
 */
export const highlightOptions = {
  detect: true,
  subset: [
    'bash',
    'c',
    'cpp',
    'csharp',
    'css',
    'diff',
    'go',
    'graphql',
    'ini',
    'java',
    'javascript',
    'json',
    'kotlin',
    'less',
    'lua',
    'makefile',
    'markdown',
    'perl',
    'php',
    'python',
    'r',
    'ruby',
    'rust',
    'scss',
    'sql',
    'swift',
    'typescript',
    'xml',
    'yaml',
  ],
  ignoreMissing: true,
  plainText: ['diagnostic'],
}
