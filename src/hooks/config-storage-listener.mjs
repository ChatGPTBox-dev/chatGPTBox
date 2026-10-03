export function createConfigStorageListener(setConfig, ignoreSession = true) {
  return (changes) => {
    const changedKeys = Object.keys(changes)
    if (ignoreSession && changedKeys.length === 1 && changedKeys[0] === 'sessions') return

    const configUpdate = Object.create(null)
    for (const key of changedKeys) {
      configUpdate[key] = changes[key].newValue
    }
    setConfig((currentConfig) => ({ ...currentConfig, ...configUpdate }))
  }
}
