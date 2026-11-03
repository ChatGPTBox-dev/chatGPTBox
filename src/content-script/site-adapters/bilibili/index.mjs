import { cropText, waitForElementToExistAndSelect } from '../../../utils'
import { config } from '../index.mjs'
import { createVideoSummaryAdapterController } from '../../video-summary-adapter-controller.mjs'
import { isEnhancedVideoSummaryAvailable } from '../../video-summary-capability.mjs'
import { resolvePageMode } from '../../video-summary-page-mode.mjs'
import { mountVideoSummaryHost } from '../../video-summary-host.mjs'
import { createBilibiliVideoPageBridge } from './video-page-bridge.mjs'

export default {
  init: async (hostname, userConfig, getInput, mountComponent) => {
    const enhancedAvailable = isEnhancedVideoSummaryAvailable(userConfig)
    const bridge = createBilibiliVideoPageBridge({
      getLocationHref: () => location.href,
      getVideoElement: () => document.querySelector('video'),
    })
    let currentMode = 'none'
    const controller = createVideoSummaryAdapterController({
      getPageIdentity: async () => {
        if (!location.pathname.startsWith('/video/')) return null
        try {
          return await bridge.resolveCurrentPageIdentity()
        } catch {
          return null
        }
      },
      resolveMode: ({ pageIdentity }) => {
        const supported = location.pathname.startsWith('/video/') && Boolean(pageIdentity)
        currentMode = resolvePageMode({
          config: userConfig,
          capabilities: { enhanced: enhancedAvailable },
          pageIdentity,
          pageState: { enhancedSupported: supported, legacySupported: supported },
        })
        return currentMode
      },
      mountEnhanced: ({ pageIdentity, pageGeneration, targetElement, isCurrentPage }) =>
        mountVideoSummaryHost({
          platform: 'bilibili',
          bridge,
          pageIdentity,
          pageGeneration,
          isPageCurrent: isCurrentPage,
          targetElement,
        }),
      async mountLegacy() {
        await mountComponent('bilibili', config.bilibili)
        let connected = true
        return {
          dispose() {
            connected = false
            document
              .querySelectorAll('.chatgptbox-container,#chatgptbox-container')
              .forEach((element) => element.remove())
          },
          isConnected: () =>
            connected &&
            document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').length > 0,
        }
      },
      subscribeToPageChanges: (listener) => bridge.subscribeToVideoChanges(listener),
      findTargetElement: () =>
        currentMode === 'enhanced'
          ? document.querySelector('#danmukuBox')
          : document.documentElement,
      waitForTargetElement: () =>
        currentMode === 'enhanced'
          ? waitForElementToExistAndSelect('#danmukuBox')
          : document.documentElement,
    })
    await controller.start()
    return false
  },
  inputQuery: async () => {
    try {
      const bvid = location.pathname.replace('video', '').replaceAll('/', '')
      const p = Number(new URLSearchParams(location.search).get('p') || 1) - 1

      const pagelistResponse = await fetch(
        `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`,
      )
      const pagelistData = await pagelistResponse.json()
      const videoList = pagelistData.data
      const cid = videoList[p].cid
      const title = videoList[p].part

      const infoResponse = await fetch(
        `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`,
        {
          credentials: 'include',
        },
      )
      const infoData = await infoResponse.json()
      let subtitleUrl = infoData.data.subtitle.subtitles[0].subtitle_url
      if (subtitleUrl.startsWith('//')) subtitleUrl = 'https:' + subtitleUrl
      else if (!subtitleUrl.startsWith('http')) subtitleUrl = 'https://' + subtitleUrl

      const subtitleResponse = await fetch(subtitleUrl)
      const subtitleData = await subtitleResponse.json()
      const subtitles = subtitleData.body

      const subtitleContent = subtitles
        .map((s) => s.content)
        .filter((c) => c != null)
        .join(',')

      return await cropText(
        `You are an expert video summarizer. Create a comprehensive summary of the following Bilibili video in markdown format, ` +
          `highlighting key takeaways, crucial information, and main topics. Include the video title.\n` +
          `Video Title: "${title}"\n` +
          `Subtitle content:\n${subtitleContent}`,
      )
    } catch (e) {
      /* empty */
    }
  },
}
