import { useTranslation } from 'react-i18next'
import { parseFloatWithClamp, parseIntWithClamp } from '../../utils/index.mjs'
import PropTypes from 'prop-types'
import { Tab, TabList, TabPanel, Tabs } from 'react-tabs'
import Browser from 'webextension-polyfill'

ApiParams.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

function ApiParams({ config, updateConfig }) {
  const { t } = useTranslation()

  return (
    <>
      <label>
        {t('Max Response Token Length') + `: ${config.maxResponseTokenLength}`}
        <input
          type="range"
          min="100"
          max="40000"
          step="100"
          value={config.maxResponseTokenLength}
          onChange={(e) => {
            const value = parseIntWithClamp(e.target.value, 1000, 100, 40000)
            updateConfig({ maxResponseTokenLength: value })
          }}
        />
      </label>
      <label>
        {t('Max Conversation Length') + `: ${config.maxConversationContextLength}`}
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={config.maxConversationContextLength}
          onChange={(e) => {
            const value = parseIntWithClamp(e.target.value, 9, 0, 100)
            updateConfig({ maxConversationContextLength: value })
          }}
        />
      </label>
      <label>
        {t('Temperature') + `: ${config.temperature}`}
        <input
          type="range"
          min="0"
          max="2"
          step="0.1"
          value={config.temperature}
          onChange={(e) => {
            const value = parseFloatWithClamp(e.target.value, 1, 0, 2)
            updateConfig({ temperature: value })
          }}
        />
      </label>
    </>
  )
}

ApiUrl.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

function ApiUrl({ config, updateConfig }) {
  const { t } = useTranslation()

  return (
    <>
      <label>
        {t('Custom ChatGPT Web API Url')}
        <input
          type="text"
          value={config.customChatGptWebApiUrl}
          onChange={(e) => {
            const value = e.target.value
            updateConfig({ customChatGptWebApiUrl: value })
          }}
        />
      </label>
      <label>
        {t('Custom ChatGPT Web API Path')}
        <input
          type="text"
          value={config.customChatGptWebApiPath}
          onChange={(e) => {
            const value = e.target.value
            updateConfig({ customChatGptWebApiPath: value })
          }}
        />
      </label>
      <label>
        {t('Custom OpenAI API Url')}
        <input
          type="text"
          value={config.customOpenAiApiUrl}
          onChange={(e) => {
            const value = e.target.value
            updateConfig({ customOpenAiApiUrl: value })
          }}
        />
      </label>
      <label>
        {t('Custom Anthropic API Url')}
        <input
          type="text"
          value={config.customAnthropicApiUrl}
          onChange={(e) => {
            const value = e.target.value
            updateConfig({ customAnthropicApiUrl: value })
          }}
        />
      </label>
    </>
  )
}

Others.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

function Others({ config, updateConfig }) {
  const { t } = useTranslation()

  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={config.disableWebModeHistory}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ disableWebModeHistory: checked })
          }}
        />
        {t(
          'Disable web mode history for better privacy protection, but it will result in unavailable conversations after a period of time',
        )}
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.hideContextMenu}
          onChange={async (e) => {
            const checked = e.target.checked
            await updateConfig({ hideContextMenu: checked })
            Browser.runtime.sendMessage({
              type: 'REFRESH_MENU',
            })
          }}
        />
        {t('Hide context menu of this extension')}
      </label>
      <br />
      <label>
        {t('Custom Site Regex')}
        <input
          type="text"
          value={config.siteRegex}
          onChange={(e) => {
            const regex = e.target.value
            updateConfig({ siteRegex: regex })
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={config.useSiteRegexOnly}
          onChange={(e) => {
            const checked = e.target.checked
            updateConfig({ useSiteRegexOnly: checked })
          }}
        />
        {t('Exclusively use Custom Site Regex for website matching, ignoring built-in rules')}
      </label>
      <br />
      <label>
        {t('Input Query')}
        <input
          type="text"
          value={config.inputQuery}
          onChange={(e) => {
            const query = e.target.value
            updateConfig({ inputQuery: query })
          }}
        />
      </label>
      <label>
        {t('Append Query')}
        <input
          type="text"
          value={config.appendQuery}
          onChange={(e) => {
            const query = e.target.value
            updateConfig({ appendQuery: query })
          }}
        />
      </label>
      <label>
        {t('Prepend Query')}
        <input
          type="text"
          value={config.prependQuery}
          onChange={(e) => {
            const query = e.target.value
            updateConfig({ prependQuery: query })
          }}
        />
      </label>
    </>
  )
}

AdvancedPart.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

export function AdvancedPart({ config, updateConfig }) {
  const { t } = useTranslation()

  return (
    <>
      <Tabs selectedTabClassName="popup-tab--selected">
        <TabList>
          <Tab className="popup-tab">{t('API Params')}</Tab>
          <Tab className="popup-tab">{t('API Url')}</Tab>
          <Tab className="popup-tab">{t('Others')}</Tab>
        </TabList>

        <TabPanel>
          <ApiParams config={config} updateConfig={updateConfig} />
        </TabPanel>
        <TabPanel>
          <ApiUrl config={config} updateConfig={updateConfig} />
        </TabPanel>
        <TabPanel>
          <Others config={config} updateConfig={updateConfig} />
        </TabPanel>
      </Tabs>
    </>
  )
}
