// Loader hooks for rendering tests: resolve extensionless relative imports the way
// webpack does, and transform JSX through esbuild for the preact runtime.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const JSX_RE = /<[A-Z][A-Za-z0-9]*[\s/>]|<>/

export async function resolve(specifier, context, nextResolve) {
  if (/^\.\.?\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
    for (const extension of ['.jsx', '.mjs', '.js']) {
      try {
        return await nextResolve(specifier + extension, context)
      } catch {
        /* try the next extension */
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file://') && !url.includes('node_modules')) {
    if (url.endsWith('.jsx') || url.endsWith('.mjs')) {
      const source = await readFile(fileURLToPath(url), 'utf8')
      if (url.endsWith('.jsx') || JSX_RE.test(source)) {
        const esbuild = await import('esbuild')
        const result = await esbuild.transform(source, {
          loader: 'jsx',
          jsx: 'automatic',
          jsxImportSource: 'preact',
        })
        return { shortCircuit: true, format: 'module', source: result.code }
      }
    }
  }
  return nextLoad(url, context)
}
