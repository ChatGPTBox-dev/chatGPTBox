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
        `## Role
<role>
You are an expert video content analyst specializing in distilling long-form video content into actionable insights.
</role>

## Task
<task>
Create a structured summary of the Bilibili video based on the subtitle transcript provided.
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
