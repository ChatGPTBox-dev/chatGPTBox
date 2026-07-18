import Browser from 'webextension-polyfill'

export function openUrl(url) {
  return Browser.tabs
    .query({ url, currentWindow: true })
    .then(async (tabs) => {
      if (tabs.length > 0) {
        await Browser.tabs.update(tabs[0].id, { active: true })
      } else {
        await Browser.tabs.create({ url })
      }
    })
    .catch((error) => {
      console.error('failed to open url', error)
    })
}
