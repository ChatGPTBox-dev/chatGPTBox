import { render } from 'preact'
import '../../_locales/i18n-react'
import App from './App'
import Browser from 'webextension-polyfill'
import { changeLanguage } from 'i18next'
import { getPreferredLanguageKey } from '../../config/index.mjs'

document.body.style.margin = 0
document.body.style.overflow = 'hidden'
getPreferredLanguageKey().then((lang) => {
  changeLanguage(lang)
})
Browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'CHANGE_LANG') {
    const data = message.data
    changeLanguage(data.lang)
  }
})
render(<App />, document.getElementById('app'))
