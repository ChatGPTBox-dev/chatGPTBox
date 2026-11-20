// Menu registration does not need the page-content prompt implementations.
export async function resolve(specifier, context, nextResolve) {
  if (
    context.parentURL?.endsWith('/src/background/menus.mjs') &&
    specifier === '../content-script/menu-tools/index.mjs'
  ) {
    return { url: 'data:text/javascript,export const config = {}', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
