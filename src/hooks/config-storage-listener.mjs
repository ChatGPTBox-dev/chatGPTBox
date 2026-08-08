export function createConfigStorageListener(setConfig, ignoreSession = true) {
  return (changes) => {
    if (ignoreSession && Object.keys(changes).length === 1 && 'sessions' in changes) return

    const configUpdate = {}
    for (const key of Object.keys(changes)) {
      configUpdate[key] = changes[key].newValue
    }
    setConfig((currentConfig) => ({ ...currentConfig, ...configUpdate }))
  }
}
