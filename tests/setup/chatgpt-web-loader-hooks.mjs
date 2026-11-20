// Expose the CommonJS hash through its default export for the Node test runtime.
// Webpack already handles the named import used by the browser bundle.
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== 'js-sha3') return nextResolve(specifier, context)

  const resolved = await nextResolve(specifier, context)
  const source = `import sha3 from ${JSON.stringify(resolved.url)}
export const sha3_512 = sha3.sha3_512`
  return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
}
