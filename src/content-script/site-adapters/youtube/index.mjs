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
          mountComponent(config.youtube)
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

      const subtitleResponse = await fetch(subtitleUrl)
      if (!subtitleResponse.ok) return
      let subtitleData = await subtitleResponse.text()

      let subtitleContent = ''
      while (subtitleData.indexOf('">') !== -1) {
        subtitleData = subtitleData.substring(subtitleData.indexOf('">') + 2)
        subtitleContent += subtitleData.substring(0, subtitleData.indexOf('<')) + '\n'
      }

      subtitleContent = replaceHtmlEntities(subtitleContent)

      return await cropText(
        `Provide a structured summary of the content of the following video in markdown format, focusing on key takeaways and crucial information for the viewer Gwern, and ensure to include the video title and completeness of transcript if needed. Ignore promotions, bio's, and other uninteresting parts. The summary should be easy to read and concise, yet comprehensive. You should include key text as markdown quotes after tidying them up.` +
          `The video title is "${title}". Add a tldr and BLUF. The subtitle content is as follows:\n${subtitleContent}`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
