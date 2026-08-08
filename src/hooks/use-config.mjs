import { useEffect, useState } from 'react'
import { defaultConfig, getUserConfig } from '../config/index.mjs'
import Browser from 'webextension-polyfill'
import { createConfigStorageListener } from './config-storage-listener.mjs'

export function useConfig(initFn, ignoreSession = true) {
  const [config, setConfig] = useState(defaultConfig)
  useEffect(() => {
    getUserConfig().then((config) => {
      setConfig(config)
      if (initFn) initFn()
    })
  }, [])
  useEffect(() => {
    const listener = createConfigStorageListener(setConfig, ignoreSession)
    Browser.storage.local.onChanged.addListener(listener)
    return () => {
      Browser.storage.local.onChanged.removeListener(listener)
    }
  }, [ignoreSession])
  return config
}
