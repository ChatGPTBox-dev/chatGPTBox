export function mergeConfigUpdate(currentConfig, value) {
  return { ...currentConfig, ...value }
}

export function queueConfigWrite(currentQueue, writeOperation) {
  const baseQueue = currentQueue instanceof Promise ? currentQueue : Promise.resolve()
  const writePromise = baseQueue.then(writeOperation)
  return {
    writePromise,
    nextQueue: writePromise.catch(() => {}),
  }
}

export function buildConfigRollbackPatch(
  persistedConfig,
  value,
  latestTouchedRequestByKey = {},
  requestId = 0,
) {
  const baseConfig = persistedConfig && typeof persistedConfig === 'object' ? persistedConfig : {}
  const nextValue = value && typeof value === 'object' ? value : {}
  const keyOwners =
    latestTouchedRequestByKey && typeof latestTouchedRequestByKey === 'object'
      ? latestTouchedRequestByKey
      : {}
  return Object.fromEntries(
    Object.keys(nextValue)
      .filter((key) => keyOwners[key] === requestId)
      .map((key) => [key, baseConfig[key]]),
  )
}
