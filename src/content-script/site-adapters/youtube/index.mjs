import { cropText } from '../../../utils'
import { config } from '../index.mjs'

// This function was written by ChatGPT and modified by iamsirsammy
function replaceHtmlEntities(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString.replaceAll('&amp;', '&'), 'text/html')
  return doc.documentElement.innerText
}

export default {
  init: async (hostname, userConfig, getInput, mountComponent) => {
    try {
      let oldUrl = location.href
      const checkUrlChange = async () => {
        if (location.href !== oldUrl) {
          oldUrl = location.href
          mountComponent('youtube', config.youtube)
        }
      }
      window.setInterval(checkUrlChange, 500)
    } catch (e) {
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
    } catch (e) {
      console.log(e)
    }
  },
}
