import { useEffect, useState } from 'react'
import { defaultConfig, getUserConfig } from '../config/index.mjs'
import Browser from 'webextension-polyfill'
import { createConfigStorageListener } from './config-storage-listener.mjs'

export function useConfig(initFn, ignoreSession = true) {
  const [config, setConfig] = useState(defaultConfig)
  useEffect(() => {
    let cancelled = false
    getUserConfig().then((config) => {
      if (cancelled) return
      setConfig(config)
      if (initFn) initFn()
    })
    return () => {
      cancelled = true
    }
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
