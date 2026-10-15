import path from 'node:path'

const nativeExecuteScriptModules = new Set([path.resolve('src/background/youtube-page-data.mjs')])

export function excludeFromBabel(resourcePath) {
  return (
    resourcePath.includes(`${path.sep}node_modules${path.sep}`) ||
    nativeExecuteScriptModules.has(resourcePath)
  )
}
