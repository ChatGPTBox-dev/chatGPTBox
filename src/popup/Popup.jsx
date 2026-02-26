import '@picocss/pico'
import { useEffect, useRef, useState } from 'react'
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
import {
  buildConfigRollbackPatch,
  mergeConfigUpdate,
  queueConfigWrite,
} from './popup-config-utils.mjs'
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
  const [configLoaded, setConfigLoaded] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')
  const [latestVersion, setLatestVersion] = useState('')
  const [tabIndex, setTabIndex] = useState(0)
  const theme = useWindowTheme()
  const initialConfigLoadGateRef = useRef(null)
  if (!initialConfigLoadGateRef.current) {
    let resolve
    const promise = new Promise((nextResolve) => {
      resolve = nextResolve
    })
    initialConfigLoadGateRef.current = { promise, resolve }
  }
  const updateConfigRequestIdRef = useRef(0)
  const latestTouchedRequestByKeyRef = useRef({})
  const writeQueueRef = useRef(initialConfigLoadGateRef.current.promise)
  const persistedConfigRef = useRef(defaultConfig)
  const latestConfigRef = useRef(defaultConfig)

  // Most popup field edits are fire-and-forget. Callers that must abort
  // follow-up work on persist failure opt into propagateError.
  const updateConfig = async (value, options = {}) => {
    const nextValue = value && typeof value === 'object' ? value : {}
    const { propagateError = false } = options && typeof options === 'object' ? options : {}
    const requestId = ++updateConfigRequestIdRef.current
    for (const key of Object.keys(nextValue)) {
      latestTouchedRequestByKeyRef.current[key] = requestId
    }
    latestConfigRef.current = mergeConfigUpdate(latestConfigRef.current, nextValue)
    setConfig((currentConfig) => {
      return mergeConfigUpdate(currentConfig, nextValue)
    })
    const { writePromise, nextQueue } = queueConfigWrite(writeQueueRef.current, () =>
      setUserConfig(nextValue),
    )
    writeQueueRef.current = nextQueue
    try {
      await writePromise
      persistedConfigRef.current = mergeConfigUpdate(persistedConfigRef.current, nextValue)
      return { ok: true, error: null }
    } catch (error) {
      const rollbackPatch = buildConfigRollbackPatch(
        persistedConfigRef.current,
        nextValue,
        latestTouchedRequestByKeyRef.current,
        requestId,
      )
      if (Object.keys(rollbackPatch).length > 0) {
        latestConfigRef.current = mergeConfigUpdate(latestConfigRef.current, rollbackPatch)
        setConfig((currentConfig) => mergeConfigUpdate(currentConfig, rollbackPatch))
      }
      console.error('[popup] Failed to persist config update', error)
      if (propagateError) throw error
      return { ok: false, error }
    }
  }

  const getPersistedConfig = () => persistedConfigRef.current
  const getCommittedConfig = async () => {
    await writeQueueRef.current
    return persistedConfigRef.current
  }

  useEffect(() => {
    getPreferredLanguageKey().then((lang) => {
      i18n.changeLanguage(lang)
    })
    setCurrentVersion(Browser.runtime.getManifest().version.replace('v', ''))
    fetch('https://api.github.com/repos/josstorer/chatGPTBox/releases/latest').then((response) =>
      response.json().then((data) => {
        setLatestVersion(data.tag_name.replace('v', ''))
      }),
    )
    const initialConfigLoadGate = initialConfigLoadGateRef.current
    getUserConfig()
      .then((config) => {
        persistedConfigRef.current = config
        latestConfigRef.current = config
        setConfig(config)
      })
      .catch((error) => {
        console.error('[popup] Failed to load initial config', error)
      })
      .finally(() => {
        setConfigLoaded(true)
        initialConfigLoadGate.resolve()
      })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = config.themeMode === 'auto' ? theme : config.themeMode
  }, [config.themeMode, theme])

  const search = new URLSearchParams(window.location.search)
  const popup = !isMobile() && search.get('popup') // manifest v2

  return (
    <div className={popup === 'true' ? 'container-popup-mode' : 'container-page-mode'}>
      {configLoaded ? (
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
              <GeneralPart
                config={config}
                updateConfig={updateConfig}
                getPersistedConfig={getPersistedConfig}
                getCommittedConfig={getCommittedConfig}
                setTabIndex={setTabIndex}
              />
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
      ) : null}
      <br />
      <Footer currentVersion={currentVersion} latestVersion={latestVersion} />
    </div>
  )
}

export default Popup
