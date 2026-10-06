import Browser from 'webextension-polyfill'
import { cropText, waitForSiteAdapterElement } from '../../../utils'
import { config } from '../index.mjs'
import { createVideoSummaryAdapterController } from '../../video-summary-adapter-controller.mjs'
import { isEnhancedVideoSummaryAvailable } from '../../video-summary-capability.mjs'
import { getYouTubeWatchIdentity } from './media-source.mjs'
import { createYouTubeVideoPageBridge } from './video-page-bridge.mjs'

const SECONDARY_COLUMN_SELECTOR =
  '#secondary:not([style*="display: none"]):not(.ytd-two-column-browse-results-renderer)'

function getWatchIdentity() {
  try {
    return getYouTubeWatchIdentity(location.href)
  } catch {
    return { videoId: null, supported: false }
  }
}

function isLiveWatchPage() {
  const playerResponse = globalThis.ytInitialPlayerResponse
  return Boolean(
    document.querySelector('ytd-watch-flexy[is-live]') ||
      playerResponse?.videoDetails?.isLiveContent === true ||
      playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow ===
        true,
  )
}

function unwrapPageDataResponse(response) {
  if (response?.ok === true) return response.data
  if (response?.ok !== false) return response

  const error = new Error(
    /^[A-Z][A-Z0-9_]+$/.test(response.errorCode || '')
      ? response.errorCode
      : 'YOUTUBE_PAGE_SCRIPT_EXECUTION_FAILED',
  )
  if (
    /^(?:Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|UnknownError)$/.test(
      response.causeCode || '',
    )
  ) {
    error.causeCode = response.causeCode
  }
  if (/^[a-z-]+$/.test(response.stage || '')) error.stage = response.stage
  throw error
}

function isEnhancedModeAvailable(userConfig) {
  return (
    (!Array.isArray(userConfig?.activeSiteAdapters) ||
      userConfig.activeSiteAdapters.includes('youtube')) &&
    isEnhancedVideoSummaryAvailable(userConfig)
  )
}

// This function was written by ChatGPT and modified by iamsirsammy
function replaceHtmlEntities(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString.replaceAll('&amp;', '&'), 'text/html')
  return doc.documentElement.innerText
}

export default {
  init: async (hostname, userConfig, getInput, mountComponent) => {
    const initialIdentity = getWatchIdentity()
    if (initialIdentity.supported && !isLiveWatchPage() && isEnhancedModeAvailable(userConfig)) {
      const controller = createVideoSummaryAdapterController({
        platform: 'youtube',
        createBridge: () =>
          createYouTubeVideoPageBridge({
            getLocationHref: () => location.href,
            getPlayerResponse: async (expectedVideoId) =>
              unwrapPageDataResponse(
                await Browser.runtime.sendMessage({
                  type: 'YOUTUBE_PAGE_PLAYER_RESPONSE',
                  data: { expectedVideoId },
                }),
              ),
            getPageHtml: () => document.documentElement?.outerHTML || '',
            captureCaption: async ({ expectedVideoId, language, sourceKind, vssId, mode }) =>
              unwrapPageDataResponse(
                await Browser.runtime.sendMessage({
                  type: 'YOUTUBE_PAGE_CAPTURE_CAPTION',
                  data: {
                    expectedVideoId,
                    language,
                    sourceKind,
                    vssId,
                    mode,
                  },
                }),
              ),
            getVideoElement: () => document.querySelector('video'),
          }),
        findTargetElement: () => document.querySelector(SECONDARY_COLUMN_SELECTOR),
        waitForTargetElement: () => waitForSiteAdapterElement(SECONDARY_COLUMN_SELECTOR),
        isPageSupported: () => {
          const identity = getWatchIdentity()
          return identity.supported && !isLiveWatchPage()
        },
      })
      await controller.start()
      return false
    }

    try {
      let oldUrl = location.href
      const checkUrlChange = async () => {
        if (location.href !== oldUrl) {
          oldUrl = location.href
          mountComponent('youtube', config.youtube)
        }
      }
      window.setInterval(checkUrlChange, 500)
    } catch {
      /* empty */
    }
    return true
  },
  inputQuery: async () => {
    try {
      const docText = await (
        await fetch(location.href, {
          credentials: 'include',
        })
      ).text()

      const subtitleUrlStartAt = docText.indexOf('https://www.youtube.com/api/timedtext')
      if (subtitleUrlStartAt === -1) return

      let subtitleUrl = docText.substring(subtitleUrlStartAt)
      subtitleUrl = subtitleUrl.substring(0, subtitleUrl.indexOf('"'))
      subtitleUrl = subtitleUrl.replaceAll('\\u0026', '&')

      let title = docText.substring(docText.indexOf('"title":"') + '"title":"'.length)
      title = title.substring(0, title.indexOf('","'))

      let potokenSource = performance
        .getEntriesByType('resource')
        .filter((a) => a?.name.includes('/api/timedtext?'))
        .pop()
      if (!potokenSource) {
        //TODO use waitUntil function in refactor version
        await new Promise((r) => setTimeout(r, 500))
        document.querySelector('button.ytp-subtitles-button.ytp-button').click()
        await new Promise((r) => setTimeout(r, 100))
        document.querySelector('button.ytp-subtitles-button.ytp-button').click()
      }
      await new Promise((r) => setTimeout(r, 500))
      potokenSource = performance
        .getEntriesByType('resource')
        .filter((a) => a?.name.includes('/api/timedtext?'))
        .pop()
      if (!potokenSource) return
      const potoken = new URL(potokenSource.name).searchParams.get('pot')

      const subtitleResponse = await fetch(`${subtitleUrl}&pot=${potoken}&c=WEB`)
      if (!subtitleResponse.ok) return
      let subtitleData = await subtitleResponse.text()

      let subtitleContent = ''
      while (subtitleData.indexOf('">') !== -1) {
        subtitleData = subtitleData.substring(subtitleData.indexOf('">') + 2)
        subtitleContent += subtitleData.substring(0, subtitleData.indexOf('<')) + ','
      }

      subtitleContent = replaceHtmlEntities(subtitleContent)

      return await cropText(
        `You are an expert video summarizer. Create a comprehensive summary of the following YouTube video in markdown format, ` +
          `highlighting key takeaways, crucial information, and main topics. Include the video title.\n` +
          `Video Title: "${title}"\n` +
          `Subtitle content:\n${subtitleContent}`,
      )
    } catch {
      return
    }
  },
}
