import { useEffect, useRef, useState } from 'react'
import Browser from 'webextension-polyfill'
import { canonicalizeApiMode } from '../config/model-key-migrations.mjs'

const STORAGE_KEYS = ['autoGenerateConversationTitle', 'conversationTitleApiMode']

export const defaultConversationTitleConfig = {
  autoGenerateConversationTitle: false,
  conversationTitleApiMode: null,
}

function normalizeTitleApiMode(value) {
  const canonical = canonicalizeApiMode(value)
  if (!canonical || typeof canonical !== 'object') return null
  return { ...canonical, apiKey: '' }
}

function normalizeConversationTitleConfig(value) {
  return {
    autoGenerateConversationTitle: value?.autoGenerateConversationTitle === true,
    conversationTitleApiMode: normalizeTitleApiMode(value?.conversationTitleApiMode),
  }
}

export function isConversationTitleConfigLoadCurrent(loadRevision, currentRevision) {
  return loadRevision === currentRevision
}

export async function getConversationTitleConfig() {
  const stored = await Browser.storage.local.get(STORAGE_KEYS)
  return normalizeConversationTitleConfig(stored)
}

export async function setConversationTitleConfig(changes) {
  const requestedChanges = changes && typeof changes === 'object' ? changes : {}
  const normalized = {}
  if (Object.hasOwn(requestedChanges, 'autoGenerateConversationTitle')) {
    normalized.autoGenerateConversationTitle =
      requestedChanges.autoGenerateConversationTitle === true
  }
  if (Object.hasOwn(requestedChanges, 'conversationTitleApiMode')) {
    normalized.conversationTitleApiMode = normalizeTitleApiMode(
      requestedChanges.conversationTitleApiMode,
    )
  }
  if (Object.keys(normalized).length > 0) await Browser.storage.local.set(normalized)
  return normalized
}

export function useConversationTitleConfig() {
  const [config, setConfig] = useState(defaultConversationTitleConfig)
  const storageRevisionRef = useRef(0)

  useEffect(() => {
    let active = true

    const listener = (changes, areaName) => {
      if (areaName && areaName !== 'local') return
      const update = {}
      if (Object.hasOwn(changes, 'autoGenerateConversationTitle')) {
        update.autoGenerateConversationTitle =
          changes.autoGenerateConversationTitle.newValue === true
      }
      if (Object.hasOwn(changes, 'conversationTitleApiMode')) {
        update.conversationTitleApiMode = normalizeTitleApiMode(
          changes.conversationTitleApiMode.newValue,
        )
      }
      if (Object.keys(update).length > 0) {
        storageRevisionRef.current += 1
        setConfig((current) => ({ ...current, ...update }))
      }
    }

    const loadCurrentConfig = async () => {
      while (active) {
        const loadRevision = storageRevisionRef.current
        const loadedConfig = await getConversationTitleConfig()
        if (!active) return
        if (isConversationTitleConfigLoadCurrent(loadRevision, storageRevisionRef.current)) {
          setConfig(loadedConfig)
          return
        }
      }
    }

    Browser.storage.onChanged.addListener(listener)
    loadCurrentConfig().catch((error) => {
      console.warn('[conversation-title] Failed to load title settings:', error)
    })

    return () => {
      active = false
      Browser.storage.onChanged.removeListener(listener)
    }
  }, [])

  const updateConfig = async (changes) => {
    storageRevisionRef.current += 1
    try {
      const normalized = await setConversationTitleConfig(changes)
      if (Object.keys(normalized).length > 0) {
        setConfig((current) => ({ ...current, ...normalized }))
      }
      return true
    } catch (error) {
      console.warn('[conversation-title] Failed to save title settings:', error)
      return false
    }
  }

  return [config, updateConfig]
}
