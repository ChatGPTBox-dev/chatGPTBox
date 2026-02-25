import { useTranslation } from 'react-i18next'
import { useLayoutEffect, useState } from 'react'
import FileSaver from 'file-saver'
import {
  openUrl,
  modelNameToDesc,
  isApiModeSelected,
  getApiModesFromConfig,
  apiModeToModelName,
} from '../../utils/index.mjs'
import {
  isUsingAzureOpenAiApiModel,
  isUsingClaudeApiModel,
  isUsingCustomModel,
  isUsingOllamaApiModel,
  isUsingGithubThirdPartyApiModel,
  isUsingMultiModeModel,
  ModelMode,
  ThemeMode,
  TriggerMode,
  Models,
} from '../../config/index.mjs'
import Browser from 'webextension-polyfill'
import { languageList } from '../../config/language.mjs'
import PropTypes from 'prop-types'
import { config as menuConfig } from '../../content-script/menu-tools'
import { PencilIcon } from '@primer/octicons-react'
import {
  getProviderById,
  resolveOpenAICompatibleRequest,
} from '../../services/apis/provider-registry.mjs'
import { buildProviderSecretUpdate } from './provider-secret-utils.mjs'

GeneralPart.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
  setTabIndex: PropTypes.func.isRequired,
}

function formatDate(date) {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')

  return `${year}-${month}-${day}`
}

async function checkBilling(apiKey, apiUrl) {
  const now = new Date()
  let startDate = new Date(now - 90 * 24 * 60 * 60 * 1000)
  const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const subDate = new Date(now)
  subDate.setDate(1)

  const urlSubscription = `${apiUrl}/v1/dashboard/billing/subscription`
  let urlUsage = `${apiUrl}/v1/dashboard/billing/usage?start_date=${formatDate(
    startDate,
  )}&end_date=${formatDate(endDate)}`
  const headers = {
    Authorization: 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
  }

  try {
    let response = await fetch(urlSubscription, { headers })
    if (!response.ok) {
      console.log('Your account has been suspended. Please log in to OpenAI to check.')
      return [null, null, null]
    }
    const subscriptionData = await response.json()
    const totalAmount = subscriptionData.hard_limit_usd

    if (totalAmount > 20) {
      startDate = subDate
    }

    urlUsage = `${apiUrl}/v1/dashboard/billing/usage?start_date=${formatDate(
      startDate,
    )}&end_date=${formatDate(endDate)}`

    response = await fetch(urlUsage, { headers })
    const usageData = await response.json()
    const totalUsage = usageData.total_usage / 100
    const remaining = totalAmount - totalUsage

    return [totalAmount, totalUsage, remaining]
  } catch (error) {
    console.error(error)
    return [null, null, null]
  }
}

function isUsingSpecialCustomModel(configOrSession) {
  return isUsingCustomModel(configOrSession) && !configOrSession.apiMode
}

export function GeneralPart({ config, updateConfig, setTabIndex }) {
  const { t, i18n } = useTranslation()
  const [balance, setBalance] = useState(null)
  const [apiModes, setApiModes] = useState([])

  useLayoutEffect(() => {
    setApiModes(getApiModesFromConfig(config, true))
  }, [
    config.activeApiModes,
    config.customApiModes,
    config.azureDeploymentName,
    config.ollamaModelName,
  ])

  const selectedProviderSession =
    config.apiMode && typeof config.apiMode === 'object'
      ? { apiMode: config.apiMode }
      : { modelName: config.modelName }
  const selectedProviderRequest = resolveOpenAICompatibleRequest(config, selectedProviderSession)
  const selectedProviderId = selectedProviderRequest?.providerId || ''
  const selectedProvider = selectedProviderRequest
    ? getProviderById(config, selectedProviderRequest.providerId)
    : null
  const selectedProviderApiKey = selectedProviderRequest?.apiKey || ''
  const isUsingOpenAICompatibleProvider = Boolean(selectedProviderRequest)

  const getBalance = async () => {
    const openAiApiUrl = selectedProvider?.baseUrl || config.customOpenAiApiUrl
    const response = await fetch(`${openAiApiUrl}/dashboard/billing/credit_grants`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${selectedProviderApiKey}`,
      },
    })
    if (response.ok) setBalance((await response.json()).total_available.toFixed(2))
    else {
      const billing = await checkBilling(selectedProviderApiKey, openAiApiUrl)
      if (billing && billing.length > 2 && billing[2]) setBalance(`${billing[2].toFixed(2)}`)
      else openUrl('https://platform.openai.com/account/usage')
    }
  }

  return (
    <>
      <label>
        <legend>{t('Triggers')}</legend>
        <select
          required
          onChange={(e) => {
            const mode = e.target.value
            updateConfig({ triggerMode: mode })
          }}
        >
          {Object.entries(TriggerMode).map(([key, desc]) => {
            return (
              <option value={key} key={key} selected={key === config.triggerMode}>
                {t(desc)}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <legend>{t('Theme')}</legend>
        <select
          required
          onChange={(e) => {
            const mode = e.target.value
            updateConfig({ themeMode: mode })
          }}
        >
          {Object.entries(ThemeMode).map(([key, desc]) => {
            return (
              <option value={key} key={key} selected={key === config.themeMode}>
                {t(desc)}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <legend style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {t('API Mode')}
          <div
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.preventDefault()
              setTabIndex(2)
            }}
          >
            <PencilIcon />
          </div>
        </legend>
        <span style="display: flex; gap: 15px;">
          <select
            style={
              isUsingOpenAICompatibleProvider ||
              isUsingMultiModeModel(config) ||
              isUsingSpecialCustomModel(config) ||
              isUsingAzureOpenAiApiModel(config) ||
              isUsingClaudeApiModel(config)
                ? 'width: 50%;'
                : undefined
            }
            required
            onChange={(e) => {
              if (e.target.value === '-1') {
                updateConfig({ modelName: 'customModel', apiMode: null })
                return
              }
              const apiMode = apiModes[e.target.value]
              updateConfig({ apiMode: apiMode })
            }}
          >
            {apiModes.map((apiMode, index) => {
              const modelName = apiModeToModelName(apiMode)
              const desc = modelNameToDesc(modelName, t)
              if (desc) {
                return (
                  <option value={index} key={index} selected={isApiModeSelected(apiMode, config)}>
                    {desc}
                  </option>
                )
              }
            })}
            <option value={-1} selected={!config.apiMode && config.modelName === 'customModel'}>
              {t(Models.customModel.desc)}
            </option>
          </select>
          {isUsingMultiModeModel(config) && (
            <select
              style="width: 50%;"
              required
              onChange={(e) => {
                const modelMode = e.target.value
                updateConfig({ modelMode: modelMode })
              }}
            >
              {Object.entries(ModelMode).map(([key, desc]) => {
                return (
                  <option value={key} key={key} selected={key === config.modelMode}>
                    {t(desc)}
                  </option>
                )
              })}
            </select>
          )}
          {isUsingOpenAICompatibleProvider && (
            <span style="width: 50%; display: flex; gap: 5px;">
              <input
                type="password"
                value={selectedProviderApiKey}
                placeholder={t('API Key')}
                onChange={(e) => {
                  const apiKey = e.target.value
                  updateConfig(buildProviderSecretUpdate(config, selectedProviderId, apiKey))
                }}
              />
              {selectedProviderId === 'openai' &&
                (selectedProviderApiKey.length === 0 ? (
                  <a
                    href="https://platform.openai.com/account/api-keys"
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                  >
                    <button style="white-space: nowrap;" type="button">
                      {t('Get')}
                    </button>
                  </a>
                ) : balance ? (
                  <button type="button" onClick={getBalance}>
                    {balance}
                  </button>
                ) : (
                  <button type="button" onClick={getBalance}>
                    {t('Balance')}
                  </button>
                ))}
            </span>
          )}
          {isUsingSpecialCustomModel(config) && (
            <input
              style="width: 50%;"
              type="text"
              value={config.customModelName}
              placeholder={t('Model Name')}
              onChange={(e) => {
                const customModelName = e.target.value
                updateConfig({ customModelName: customModelName })
              }}
            />
          )}
          {isUsingAzureOpenAiApiModel(config) && (
            <input
              type="password"
              style="width: 50%;"
              value={config.azureApiKey}
              placeholder={t('Azure API Key')}
              onChange={(e) => {
                const apiKey = e.target.value
                updateConfig({ azureApiKey: apiKey })
              }}
            />
          )}
          {isUsingClaudeApiModel(config) && (
            <input
              type="password"
              style="width: 50%;"
              value={config.claudeApiKey}
              placeholder={t('Claude API Key')}
              onChange={(e) => {
                const apiKey = e.target.value
                updateConfig({ claudeApiKey: apiKey })
              }}
            />
          )}
        </span>
        {isUsingSpecialCustomModel(config) && (
          <input
            type="text"
            value={config.customModelApiUrl}
            placeholder={t('Custom Model API Url')}
            onChange={(e) => {
              const value = e.target.value
              updateConfig({ customModelApiUrl: value })
            }}
          />
        )}
        {isUsingOllamaApiModel(config) && (
          <div style={{ display: 'flex', gap: '10px' }}>
            {t('Keep-Alive Time') + ':'}
            <label>
              <input
                type="radio"
                name="ollamaKeepAliveTime"
                value="5m"
                checked={config.ollamaKeepAliveTime === '5m'}
                onChange={(e) => {
                  updateConfig({ ollamaKeepAliveTime: e.target.value })
                }}
              />
              {t('5m')}
            </label>
            <label>
              <input
                type="radio"
                name="ollamaKeepAliveTime"
                value="30m"
                checked={config.ollamaKeepAliveTime === '30m'}
                onChange={(e) => {
                  updateConfig({ ollamaKeepAliveTime: e.target.value })
                }}
              />
              {t('30m')}
            </label>
            <label>
              <input
                type="radio"
                name="ollamaKeepAliveTime"
                value="-1"
                checked={config.ollamaKeepAliveTime === '-1'}
                onChange={(e) => {
                  updateConfig({ ollamaKeepAliveTime: e.target.value })
                }}
              />
              {t('Forever')}
            </label>
          </div>
        )}
        {isUsingOllamaApiModel(config) && (
          <input
            type="text"
            value={config.ollamaEndpoint}
            placeholder={t('Ollama Endpoint')}
            onChange={(e) => {
              const value = e.target.value
              updateConfig({ ollamaEndpoint: value })
            }}
          />
        )}
        {isUsingAzureOpenAiApiModel(config) && (
          <input
            type="password"
            value={config.azureEndpoint}
            placeholder={t('Azure Endpoint')}
            onChange={(e) => {
              const endpoint = e.target.value
              updateConfig({ azureEndpoint: endpoint })
            }}
          />
        )}
        {isUsingGithubThirdPartyApiModel(config) && (
          <input
            type="text"
            value={config.githubThirdPartyUrl}
            placeholder={t('API Url')}
            onChange={(e) => {
              const url = e.target.value
              updateConfig({ githubThirdPartyUrl: url })
            }}
          />
        )}
      </label>
      <label>
        <legend>{t('Preferred Language')}</legend>
        <select
          required
          onChange={(e) => {
            const preferredLanguageKey = e.target.value
            updateConfig({ preferredLanguage: preferredLanguageKey })

            let lang
            if (preferredLanguageKey === 'auto') lang = config.userLanguage
            else lang = preferredLanguageKey
            i18n.changeLanguage(lang)

            Browser.tabs.query({}).then((tabs) => {
              tabs.forEach((tab) => {
                Browser.tabs
                  .sendMessage(tab.id, {
                    type: 'CHANGE_LANG',
                    data: {
                      lang,
                    },
                  })
                  .catch(() => {})
              })
            })
          }}
        >
          {Object.entries(languageList).map(([k, v]) => {
            return (
              <option value={k} key={k} selected={k === config.preferredLanguage}>
                {v.native}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <legend>{t('When Icon Clicked')}</legend>
        <select
          required
          onChange={(e) => {
            const mode = e.target.value
            updateConfig({ clickIconAction: mode })
          }}
        >
          <option value="popup" key="popup" selected={config.clickIconAction === 'popup'}>
            {t('Open Settings')}
          </option>
          {Object.entries(menuConfig).map(([k, v]) => {
            return (
              <option value={k} key={k} selected={k === config.clickIconAction}>
                {t(v.label)}
              </option>
            )
          })}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.insertAtTop}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ insertAtTop: checked })
          }}
        />
        {t('Insert ChatGPT at the top of search results')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.alwaysFloatingSidebar}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ alwaysFloatingSidebar: checked })
          }}
        />
        {t('Always display floating window, disable sidebar for all site adapters')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.allowEscToCloseAll}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ allowEscToCloseAll: checked })
          }}
        />
        {t('Allow ESC to close all floating windows')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.lockWhenAnswer}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ lockWhenAnswer: checked })
          }}
        />
        {t('Lock scrollbar while answering')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.autoRegenAfterSwitchModel}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ autoRegenAfterSwitchModel: checked })
          }}
        />
        {t('Regenerate the answer after switching model')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.selectionToolsNextToInputBox}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ selectionToolsNextToInputBox: checked })
          }}
        />
        {t('Display selection tools next to input box to avoid blocking')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.alwaysPinWindow}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ alwaysPinWindow: checked })
          }}
        />
        {t('Always pin the floating window')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.focusAfterAnswer}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ focusAfterAnswer: checked })
          }}
        />
        {t('Focus to input box after answering')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.cropText}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ cropText: checked })
          }}
        />
        {t("Crop Text to ensure the input tokens do not exceed the model's limit")}
      </label>
      <br />
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          className="secondary"
          onClick={async (e) => {
            e.preventDefault()
            const file = await new Promise((resolve) => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.json'
              input.onchange = (e) => resolve(e.target.files[0])
              input.click()
            })
            if (!file) return
            const data = await new Promise((resolve) => {
              const reader = new FileReader()
              reader.onload = (e) => resolve(JSON.parse(e.target.result))
              reader.readAsText(file)
            })
            await Browser.storage.local.set(data)
            window.location.reload()
          }}
        >
          {t('Import All Data')}
        </button>
        <button
          className="secondary"
          onClick={async (e) => {
            e.preventDefault()
            const blob = new Blob(
              [JSON.stringify(await Browser.storage.local.get(null), null, 2)],
              { type: 'text/json;charset=utf-8' },
            )
            FileSaver.saveAs(blob, 'chatgptbox-data.json')
          }}
        >
          {t('Export All Data')}
        </button>
      </div>
    </>
  )
}
