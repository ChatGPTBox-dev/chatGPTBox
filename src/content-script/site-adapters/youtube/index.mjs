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
        `## Role
<role>
You are an expert video content analyst specializing in distilling long-form video content into actionable insights.
</role>

## Task
<task>
Create a structured summary of the YouTube video based on the subtitle transcript provided.
</task>

## Instructions
<instructions>
1. **Open with context**: Begin with the video title and a one-sentence overview
2. **Identify main topics**: List 3-5 primary themes or segments
3. **Extract key takeaways**: Provide 5-7 bullet points of actionable insights or crucial information
4. **Note important details**: Include specific data, quotes, or examples that support main points
5. **Structure chronologically**: Maintain the flow of the video's narrative when relevant
</instructions>

## Output Format
<output_format>
# [Video Title]

## Overview
[One-sentence description of video purpose/topic]

## Main Topics
1. [Topic 1] - [Brief description]
2. [Topic 2] - [Brief description]
3. [Topic 3] - [Brief description]

## Key Takeaways
- [Actionable insight 1]
- [Actionable insight 2]
- [Actionable insight 3]
- [Continue as needed]

## Important Details
- [Specific data point, quote, or example]
- [Another relevant detail]

## Conclusion
[One-sentence summary of main message]
</output_format>

## Input Data
<input_data>
Video Title: "${title}"

Subtitle Content:
${subtitleContent}
</input_data>

## Constraints
<constraints>
- Focus on information actually present in the subtitles
- Do not add external knowledge or assumptions
- If subtitles are incomplete or unclear, note this limitation
- Keep summary concise while capturing essential information
</constraints>`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
