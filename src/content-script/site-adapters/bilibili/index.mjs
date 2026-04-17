import { cropText, waitForElementToExistAndSelect } from '../../../utils'
import { config } from '../index.mjs'

export default {
  init: async (hostname, userConfig, getInput, mountComponent) => {
    if (location.pathname.includes('/bangumi')) return false
    try {
      // B站页面是SSR的，如果插入过早，页面 js 检测到实际 Dom 和期望 Dom 不一致，会导致重新渲染
      await waitForElementToExistAndSelect('img.bili-avatar-img')
      const getVideoPath = () =>
        location.pathname + `?p=${new URLSearchParams(location.search).get('p') || 1}`
      let oldPath = getVideoPath()
      const checkPathChange = async () => {
        const newPath = getVideoPath()
        if (newPath !== oldPath) {
          oldPath = newPath
          mountComponent('bilibili', config.bilibili)
        }
      }
      window.setInterval(checkPathChange, 500)
    } catch (e) {
      /* empty */
    }
    return true
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

      let subtitleContent = ''
      for (let i = 0; i < subtitles.length; i++) {
        if (i === subtitles.length - 1) subtitleContent += subtitles[i].content
        else subtitleContent += subtitles[i].content + ','
      }

      return await cropText(
        `You are an expert video summarizer. Create a comprehensive summary of the following Bilibili video in markdown format, ` +
          `highlighting key takeaways, crucial information, and main topics. Include the video title.\n` +
          `Video Title: "${title}"\n` +
          `Subtitle content:\n${subtitleContent}`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
