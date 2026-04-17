import { cropText, limitedFetch } from '../../../utils'
import { config } from '../index.mjs'

const getPatchUrl = async () => {
  const patchUrl = location.origin + location.pathname + '.patch'
  const response = await fetch(patchUrl, { method: 'HEAD' }).catch(() => ({}))
  if (response.ok) return patchUrl
  return ''
}

const getPatchData = async (patchUrl) => {
  if (!patchUrl) return

  let patchData = await limitedFetch(patchUrl, 1024 * 40)
  patchData = patchData.substring(patchData.indexOf('---'))
  return patchData
}

const isPull = () => {
  return location.href.match(/\/pull\/\d+$/)
}

const isIssue = () => {
  return location.href.match(/\/issues\/\d+$/)
}

function parseGitHubIssueData() {
  // Function to parse a single comment
  function parseComment(commentElement) {
    // Parse the date
    const dateElement = commentElement.querySelector('relative-time')
    const date = dateElement.getAttribute('datetime')

    // Parse the author
    const authorElement =
      commentElement.querySelector('.author') || commentElement.querySelector('.author-name')
    const author = authorElement.textContent.trim()

    // Parse the body
    const bodyElement = commentElement.querySelector('.comment-body')
    const body = bodyElement.textContent.trim()

    return { date, author, body }
  }

  // Function to parse all messages on the page
  function parseAllMessages() {
    // Find all comment containers
    const commentElements = document.querySelectorAll('.timeline-comment-group')
    const messages = Array.from(commentElements).map(parseComment)

    // The initial post is not a ".timeline-comment-group", so we need to handle it separately
    const initialPostElement = document.querySelector('.js-comment-container')
    const initialPost = parseComment(initialPostElement)

    // Combine the initial post with the rest of the comments
    return [initialPost, ...messages]
  }

  // Function to get the content of the comment input box
  function getCommentInputContent() {
    const commentInput = document.querySelector('.js-new-comment-form textarea')
    return commentInput ? commentInput.value : ''
  }

  // Get the issue title
  const title = document.querySelector('.js-issue-title').textContent.trim()

  // Get all messages
  const messages = parseAllMessages()

  // Get the content of the new comment box
  const commentBoxContent = getCommentInputContent()

  // Return an object with both results
  return {
    title: title,
    messages: messages,
    commentBoxContent: commentBoxContent,
  }
}

function createChatGPtSummaryPrompt(issueData, isIssue = true) {
  // Destructure the issueData object into messages and commentBoxContent
  const { title, messages, commentBoxContent } = issueData

  // Start crafting the prompt
  let prompt = ''

  if (isIssue) {
    prompt =
      `You are an expert in analyzing GitHub discussions. ` +
      `Please provide a concise summary of the following GitHub issue thread. ` +
      `Identify the main problem reported, key points discussed by participants, proposed solutions (if any), and the current status or next steps. ` +
      `Present the summary in a structured markdown format.\n\n`
  } else {
    prompt =
      `You are an expert in analyzing GitHub discussions and code reviews. ` +
      `Please provide a concise summary of the following GitHub pull request thread. ` +
      `Identify the main problem this pull request aims to solve, the proposed changes, key discussion points from the review, and the overall status of the PR (e.g., approved, needs changes, merged). ` +
      `Present the summary in a structured markdown format.\n\n`
  }

  prompt += '---\n\n'

  prompt += `Title:\n${title}\n\n`

  // Add each message to the prompt
  messages.forEach((message, index) => {
    prompt += `Message ${index + 1} by ${message.author} on ${message.date}:\n${message.body}\n\n`
  })

  // If there's content in the comment box, add it as a draft message
  if (commentBoxContent) {
    prompt += '---\n\n'
    prompt += `Draft message in comment box:\n${commentBoxContent}\n\n`
  }

  // Add a request for summary at the end of the prompt
  // prompt += 'What is the main issue and key points discussed in this thread?'

  return prompt
}

export default {
  init: async (hostname, userConfig, getInput, mountComponent) => {
    try {
      let oldUrl = location.href
      const checkUrlChange = async () => {
        if (location.href !== oldUrl) {
          oldUrl = location.href
          if (isPull() || isIssue()) {
            mountComponent('github', config.github)
            return
          }

          const patchUrl = await getPatchUrl()
          if (patchUrl) {
            mountComponent('github', config.github)
          }
        }
      }
      window.setInterval(checkUrlChange, 500)
    } catch (e) {
      /* empty */
    }
    return (await getPatchUrl()) || isPull() || isIssue()
  },
  inputQuery: async () => {
    try {
      if (isPull() || isIssue()) {
        const issueData = parseGitHubIssueData()
        const summaryPrompt = createChatGPtSummaryPrompt(issueData, isIssue())

        return await cropText(summaryPrompt)
      }
      const patchUrl = await getPatchUrl()
      const patchData = await getPatchData(patchUrl)
      if (!patchData) return

      return await cropText(
        `You are an expert in analyzing git commits and crafting clear, concise commit messages. ` +
          `Based on the following git patch, please perform two tasks:\n` +
          `1. Generate a suitable commit message. It should follow standard conventions: a short imperative subject line (max 50 chars), ` +
          `followed by a blank line and a more detailed body if necessary, explaining the "what" and "why" of the changes.\n` +
          `2. Provide a brief summary of the changes introduced in this commit, highlighting the main purpose and impact.\n\n` +
          `The patch contents are as follows:\n${patchData}`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
