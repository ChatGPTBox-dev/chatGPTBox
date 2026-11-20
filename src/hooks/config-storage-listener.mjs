import { NON_CONFIG_STORAGE_KEYS } from '../config/storage-keys.mjs'

export function createConfigStorageListener(setConfig, ignoreSession = true) {
  return (changes) => {
    const changedKeys = Object.keys(changes)
    if (
      ignoreSession &&
      changedKeys.length === 1 &&
      NON_CONFIG_STORAGE_KEYS.includes(changedKeys[0])
    )
      return

    const configUpdate = Object.create(null)
    for (const key of changedKeys) {
      configUpdate[key] = changes[key].newValue
    }
    setConfig((currentConfig) => ({ ...currentConfig, ...configUpdate }))
  }
}
