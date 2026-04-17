// ESM loader hooks that transform .mjs files containing JSX via esbuild
// and provide CJS-to-ESM interop for packages that need it.
// Register with: module.register('./tests/setup/jsx-loader-hooks.mjs', import.meta.url)
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const JSX_RE = /<[A-Z][A-Za-z0-9]*[\s/>]/

// CJS packages that need named-export re-exporting for ESM consumers.
const CJS_REEXPORT = new Set(['countries-list'])

export async function load(url, context, nextLoad) {
  // Handle CJS packages that lack ESM named exports
  for (const pkg of CJS_REEXPORT) {
    if (url.includes(`/node_modules/${pkg}/`)) {
      const require = createRequire(url)
      const mod = require(pkg)
      const IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
      const names = Object.keys(mod).filter((k) => k !== 'default' && k !== '__esModule')
      const used = new Set()
      const toSafe = (k) => {
        let s = k.replace(/[^a-zA-Z0-9_$]/g, '_')
        if (/^[0-9]/.test(s)) s = '_' + s
        while (used.has(s)) s = '_' + s
        used.add(s)
        return s
      }
      const src = [
        `import { createRequire as _cr } from 'node:module';`,
        `const _req = _cr(${JSON.stringify(url)});`,
        `const _mod = _req(${JSON.stringify(pkg)});`,
        ...names.map((n) => {
          const id = IDENT_RE.test(n) ? n : toSafe(n)
          return `export const ${id} = _mod[${JSON.stringify(n)}];`
        }),
        `export default _mod;`,
      ].join('\n')
      return { shortCircuit: true, format: 'module', source: src }
    }
  }

  // Transform source .mjs files that contain JSX
  if (url.startsWith('file://') && url.endsWith('.mjs') && !url.includes('node_modules')) {
    const filePath = fileURLToPath(url)
    const source = await readFile(filePath, 'utf8')
    if (JSX_RE.test(source)) {
      const esbuild = await import('esbuild')
      const result = await esbuild.transform(source, {
        loader: 'jsx',
        jsx: 'automatic',
        jsxImportSource: 'preact',
      })
      return { shortCircuit: true, format: 'module', source: result.code }
    }
  }

  return nextLoad(url, context)
}
