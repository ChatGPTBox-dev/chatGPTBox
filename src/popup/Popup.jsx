import '@picocss/pico'
import { useEffect, useState } from 'react'
import {
  defaultConfig,
  getPreferredLanguageKey,
  getUserConfig,
  setUserConfig,
} from '../config/index.mjs'
import { Tab, TabList, TabPanel, Tabs } from 'react-tabs'
import 'react-tabs/style/react-tabs.css'
import './styles.scss'
import { MarkGithubIcon } from '@primer/octicons-react'
import Browser from 'webextension-polyfill'
import { useWindowTheme } from '../hooks/use-window-theme.mjs'
import { isMobile } from '../utils/index.mjs'
import { useTranslation } from 'react-i18next'
import { GeneralPart } from './sections/GeneralPart'
import { FeaturePages } from './sections/FeaturePages'
import { AdvancedPart } from './sections/AdvancedPart'
import { ModulesPart } from './sections/ModulesPart'

// eslint-disable-next-line react/prop-types
function Footer({ currentVersion, latestVersion }) {
  const { t } = useTranslation()

  return (
    <div className="footer">
      <div>
        {`${t('Current Version')}: ${currentVersion} `}
        {currentVersion >= latestVersion ? (
          `(${t('Latest')})`
        ) : (
          <>
            ({`${t('Latest')}: `}
            <a
              href={'https://github.com/ChatGPTBox-dev/chatGPTBox/releases/tag/v' + latestVersion}
              target="_blank"
              rel="nofollow noopener noreferrer"
            >
              {latestVersion}
            </a>
            )
          </>
        )}
      </div>
      <div>
        <a
          href="https://github.com/ChatGPTBox-dev/chatGPTBox"
          target="_blank"
          rel="nofollow noopener noreferrer"
        >
          <span>{t('Help | Changelog ')}</span>
          <MarkGithubIcon />
        </a>
      </div>
    </div>
  )
}

function Popup() {
  const { t, i18n } = useTranslation()
  const [config, setConfig] = useState(defaultConfig)
  const [currentVersion, setCurrentVersion] = useState('')
  const [latestVersion, setLatestVersion] = useState('')
  const [tabIndex, setTabIndex] = useState(0)
  const theme = useWindowTheme()

  const updateConfig = async (value) => {
    setConfig({ ...config, ...value })
    await setUserConfig(value)
  }

  useEffect(() => {
    getPreferredLanguageKey().then((lang) => {
      i18n.changeLanguage(lang)
    })
    getUserConfig().then((config) => {
      setConfig(config)
      setCurrentVersion(Browser.runtime.getManifest().version.replace('v', ''))
      fetch('https://api.github.com/repos/josstorer/chatGPTBox/releases/latest').then((response) =>
        response.json().then((data) => {
          setLatestVersion(data.tag_name.replace('v', ''))
        }),
      )
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = config.themeMode === 'auto' ? theme : config.themeMode
  }, [config.themeMode, theme])

  const search = new URLSearchParams(window.location.search)
  const popup = !isMobile() && search.get('popup') // manifest v2

  return (
    <div className={popup === 'true' ? 'container-popup-mode' : 'container-page-mode'}>
      <form style="width:100%;">
        <Tabs
          selectedTabClassName="popup-tab--selected"
          selectedIndex={tabIndex}
          onSelect={(index) => {
            setTabIndex(index)
          }}
        >
          <TabList>
            <Tab className="popup-tab">{t('General')}</Tab>
            <Tab className="popup-tab">{t('Feature Pages')}</Tab>
            <Tab className="popup-tab">{t('Modules')}</Tab>
            <Tab className="popup-tab">{t('Advanced')}</Tab>
          </TabList>

          <TabPanel>
            <GeneralPart config={config} updateConfig={updateConfig} setTabIndex={setTabIndex} />
          </TabPanel>
          <TabPanel>
            <FeaturePages config={config} updateConfig={updateConfig} />
          </TabPanel>
          <TabPanel>
            <ModulesPart config={config} updateConfig={updateConfig} />
          </TabPanel>
          <TabPanel>
            <AdvancedPart config={config} updateConfig={updateConfig} />
          </TabPanel>
        </Tabs>
      </form>
      <br />
      <Footer currentVersion={currentVersion} latestVersion={latestVersion} />
    </div>
  )
}

export default Popup
