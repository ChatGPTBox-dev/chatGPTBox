import { getCoreContentText } from '../../utils/get-core-content-text'
import Browser from 'webextension-polyfill'
import { getUserConfig } from '../../config/index.mjs'
import { openUrl } from '../../utils/open-url'

export const config = {
  newChat: {
    label: 'New Chat',
    genPrompt: async () => {
      return ''
    },
  },
  summarizePage: {
    label: 'Summarize Page',
    genPrompt: async () => {
      const pageContent = getCoreContentText()
      return `## Role
<role>
You are an expert content analyst specializing in web page summarization and information extraction.
</role>

## Task
<task>
Analyze the extracted web page content and create a structured summary that captures the main topic, key points, and essential information.
</task>

## Instructions
<instructions>
1. **Identify page type**:
   - Article/Blog post
   - Documentation
   - Product page
   - News article
   - Tutorial/Guide
   - Other

2. **Extract core information**:
   - Main topic or thesis
   - 3-5 key points or sections
   - Important data, statistics, or facts
   - Conclusions or takeaways

3. **Assess content structure**:
   - Identify major sections or themes
   - Note logical flow of information
   - Recognize hierarchical organization

4. **Filter noise**:
   - Ignore navigation, ads, footers
   - Focus on substantive content
   - Distinguish main content from sidebars
</instructions>

## Output Format
<output_format>
# [Page Title or Main Topic]

**Type**: [Article | Documentation | Product | News | Tutorial | Other]
**Topic**: [One-sentence description]

## Summary
[2-4 sentence overview of the page's main message or purpose]

## Key Points
1. **[Point 1]**: [Brief explanation]
2. **[Point 2]**: [Brief explanation]
3. **[Point 3]**: [Brief explanation]
4. [Continue as needed]

## Important Details
- [Significant fact, statistic, or detail]
- [Another relevant detail]
- [Additional information worth noting]

## Conclusion/Takeaway
[Main conclusion or action item from the content]

## Content Quality Note
[Optional: Note if content is incomplete, poorly extracted, or unclear]
</output_format>

## Input Data
<input_data>
Web Page Content:
${pageContent}
</input_data>

## Constraints
<constraints>
- Base summary only on provided extracted content
- If extraction quality is poor (lots of navigation/ads), note this limitation
- Focus on informational content, not page structure or design
- If content is too fragmented to summarize meaningfully, state this
- Do not add external knowledge about the topic
- Maintain objectivity in summarization
- If page type is unclear, make best assessment or state "Mixed content"
</constraints>`
    },
  },
  openConversationPage: {
    label: 'Open Conversation Page',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        openUrl(Browser.runtime.getURL('IndependentPanel.html'))
      } else {
        Browser.runtime.sendMessage({
          type: 'OPEN_URL',
          data: {
            url: Browser.runtime.getURL('IndependentPanel.html'),
          },
        })
      }
    },
  },
  openConversationWindow: {
    label: 'Open Conversation Window',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        const config = await getUserConfig()
        const url = Browser.runtime.getURL('IndependentPanel.html')
        const tabs = await Browser.tabs.query({ url: url, windowType: 'popup' })
        if (!config.alwaysCreateNewConversationWindow && tabs.length > 0)
          await Browser.windows.update(tabs[0].windowId, { focused: true })
        else
          await Browser.windows.create({
            url: url,
            type: 'popup',
            width: 500,
            height: 650,
          })
      } else {
        Browser.runtime.sendMessage({
          type: 'OPEN_CHAT_WINDOW',
          data: {},
        })
      }
    },
  },
  openSidePanel: {
    label: 'Open Side Panel',
    action: async (fromBackground, tab) => {
      console.debug('action is from background', fromBackground)
      if (fromBackground) {
        // eslint-disable-next-line no-undef
        chrome.sidePanel.open({ windowId: tab.windowId, tabId: tab.id })
      } else {
        // side panel is not supported
      }
    },
  },
  closeAllChats: {
    label: 'Close All Chats In This Page',
    action: async (fromBackground) => {
      console.debug('action is from background', fromBackground)
      Browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        Browser.tabs.sendMessage(tabs[0].id, {
          type: 'CLOSE_CHATS',
          data: {},
        })
      })
    },
  },
}
