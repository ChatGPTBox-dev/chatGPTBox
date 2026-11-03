import Browser from 'webextension-polyfill'
import { isVideoSummaryAvailable } from '../video-summary/capabilities.mjs'

export function isEnhancedVideoSummaryAvailable(
  config,
  dependencies = { Browser, navigator: globalThis.navigator },
) {
  try {
    const manifest = dependencies.Browser.runtime.getManifest()
    return isVideoSummaryAvailable(config, {
      manifestVersion: manifest.manifest_version,
      hasOffscreenPermission: manifest.permissions?.includes('offscreen') === true,
      minChromeVersion: manifest.minimum_chrome_version,
      userAgent: dependencies.navigator?.userAgent,
    })
  } catch {
    return false
  }
}
