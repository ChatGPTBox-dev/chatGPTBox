import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import {
  getApiModesFromConfig,
  getUniquelySelectedApiModeIndex,
  isEdge,
  isFirefox,
  isMobile,
  isSafari,
  openUrl,
} from '../../utils/index.mjs'
import Browser from 'webextension-polyfill'
import PropTypes from 'prop-types'
import {
  hasCrossContextSessionLock,
  isConversationTitleApiModeSupported,
} from '../../services/conversation-title-model.mjs'
import { getApiModeDisplayLabel } from './api-modes-provider-utils.mjs'
import { useConversationTitleConfig } from '../../hooks/use-conversation-title-config.mjs'

FeaturePages.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

function getConversationTitleApiModes(config) {
  if (!hasCrossContextSessionLock()) return []

  return getApiModesFromConfig(config, true).filter((apiMode) =>
    isConversationTitleApiModeSupported(config, apiMode),
  )
}

function getConversationTitleApiModeKey(apiMode, index) {
  return [
    apiMode.groupName,
    apiMode.itemName,
    apiMode.customName,
    apiMode.providerId,
    index,
  ].join(':')
}

export function FeaturePages({ config, updateConfig }) {
  const { t } = useTranslation()
  const [backgroundPermission, setBackgroundPermission] = useState(false)
  const [conversationTitleConfig, updateConversationTitleConfig] =
    useConversationTitleConfig()
  const conversationTitleApiModes = getConversationTitleApiModes(config)
  const selectedConversationTitleApiModeIndex = getUniquelySelectedApiModeIndex(
    conversationTitleApiModes,
    { apiMode: conversationTitleConfig.conversationTitleApiMode },
    { sessionCompat: true },
  )
  const hasValidConversationTitleModel = selectedConversationTitleApiModeIndex !== -1
  const supportsBackgroundPermission = !isMobile() && !isFirefox() && !isSafari()

  useEffect(() => {
    if (!supportsBackgroundPermission) return undefined

    let active = true
    Browser.permissions
      .contains({ permissions: ['background'] })
      .then((result) => {
        if (active) setBackgroundPermission(result)
      })
      .catch((error) => {
        console.warn('[feature-pages] Failed to check background permission:', error)
      })

    return () => {
      active = false
    }
  }, [supportsBackgroundPermission])

  return (
    <div style="display:flex;flex-direction:column;align-items:left;">
      {supportsBackgroundPermission && (
        <button
          type="button"
          onClick={() => {
            if (isEdge()) openUrl('edge://extensions/shortcuts')
            else openUrl('chrome://extensions/shortcuts')
          }}
        >
          {t('Keyboard Shortcuts')}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          Browser.runtime.sendMessage({
            type: 'OPEN_URL',
            data: {
              url: Browser.runtime.getURL('IndependentPanel.html'),
            },
          })
        }}
      >
        {t('Open Conversation Page')}
      </button>
      {!isMobile() && (
        <button
          type="button"
          onClick={() => {
            Browser.runtime.sendMessage({
              type: 'OPEN_CHAT_WINDOW',
              data: {},
            })
          }}
        >
          {t('Open Conversation Window')}
        </button>
      )}
      {supportsBackgroundPermission && (
        <label>
          <input
            type="checkbox"
            checked={backgroundPermission}
            onChange={(e) => {
              const checked = e.target.checked
              if (checked)
                Browser.permissions.request({ permissions: ['background'] }).then((result) => {
                  setBackgroundPermission(result)
                })
              else
                Browser.permissions.remove({ permissions: ['background'] }).then((result) => {
                  setBackgroundPermission(result)
                })
            }}
          />
          {t('Keep Conversation Window in Background')}
        </label>
      )}
      {!isMobile() && (
        <label>
          <input
            type="checkbox"
            checked={config.alwaysCreateNewConversationWindow}
            onChange={(e) => {
              const checked = e.target.checked
              updateConfig({ alwaysCreateNewConversationWindow: checked })
            }}
          />
          {t('Always Create New Conversation Window')}
        </label>
      )}
      <label>
        <input
          type="checkbox"
          checked={conversationTitleConfig.autoGenerateConversationTitle}
          disabled={
            !hasValidConversationTitleModel &&
            !conversationTitleConfig.autoGenerateConversationTitle
          }
          onChange={(e) => {
            void updateConversationTitleConfig({
              autoGenerateConversationTitle: e.target.checked,
            })
          }}
        />
        {t('Automatically generate conversation titles')}
      </label>
      <label>
        <span>{t('Conversation title model')}</span>
        <select
          value={selectedConversationTitleApiModeIndex}
          disabled={conversationTitleApiModes.length === 0}
          onChange={(e) => {
            const index = Number(e.target.value)
            const apiMode = conversationTitleApiModes[index]
            void updateConversationTitleConfig({
              conversationTitleApiMode: apiMode ? { ...apiMode, apiKey: '' } : null,
              ...(apiMode ? {} : { autoGenerateConversationTitle: false }),
            })
          }}
        >
          <option value={-1}>{t('Select a model')}</option>
          {conversationTitleApiModes.map((apiMode, index) => (
            <option value={index} key={getConversationTitleApiModeKey(apiMode, index)}>
              {getApiModeDisplayLabel(
                apiMode,
                t,
                Array.isArray(config.customOpenAIProviders) ? config.customOpenAIProviders : [],
              )}
            </option>
          ))}
        </select>
        <small>
          {t('Choose a fast, low-cost OpenAI-compatible chat model.')}{' '}
          {t('The first completed exchange is sent once per conversation.')}
        </small>
      </label>
    </div>
  )
}
