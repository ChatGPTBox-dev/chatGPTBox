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
  let prompt = `## Role
<role>
You are an expert software engineer specializing in code review and issue tracking analysis.
</role>

## Task
<task>
Analyze the GitHub thread (${isIssue ? 'issue' : 'pull request'}) and provide a structured summary that captures the problem, discussion, and resolution status.
</task>

## Instructions
<instructions>
1. **Identify thread type**: This is a ${isIssue ? 'issue report' : 'pull request'}
2. **Extract problem statement**: ${isIssue ? 'What problem is being reported?' : 'What problem does this PR aim to solve?'}
3. **Summarize discussion**: Capture key points from comments in chronological order
4. **List proposed solutions**: Note all suggested approaches with brief rationale
5. **Determine current status**:
   - Open/Closed
   - Awaiting response/review
   - Merged/Rejected (for PRs)
   - Action items remaining
6. **Identify stakeholders**: Note primary participants and their roles
</instructions>

## Output Format
<output_format>
# [${isIssue ? 'Issue' : 'PR'} Title]

**Type**: ${isIssue ? 'Issue' : 'Pull Request'}
**Status**: [Open | Closed | Merged | Rejected]
**Primary Reporter**: [@username]

## Problem Statement
[Clear description of the problem being addressed]

## Discussion Summary
1. **[@username]** ([date]): [Key point or contribution]
2. **[@username]** ([date]): [Key point or contribution]
3. [Continue chronologically]

## Proposed Solutions
- **Solution 1**: [Description] - [Rationale or outcome]
- **Solution 2**: [Description] - [Rationale or outcome]

## Current Status
[Detailed status including next steps or blocking issues]

## Action Items
- [ ] [Action item 1]
- [ ] [Action item 2]
</output_format>

## Input Data
<input_data>
Thread Type: ${isIssue ? 'Issue' : 'Pull Request'}
Title: ${title}

`

  // Add each message to the prompt
  messages.forEach((message, index) => {
    prompt += `Message ${index + 1} by ${message.author} on ${message.date}:\n${message.body}\n\n`
  })

  // If there's content in the comment box, add it as a draft message
  if (commentBoxContent) {
    prompt += `Draft Content: ${commentBoxContent}\n`
  }

  prompt += `</input_data>

## Constraints
<constraints>
- Base analysis solely on provided thread content
- Preserve technical accuracy of proposed solutions
- Note when information is incomplete or unclear
- Maintain neutral tone when summarizing disagreements
- Do not infer unstated intentions or decisions
</constraints>`

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
        `## Role
<role>
You are a senior software engineer specializing in version control and code review, with expertise in writing clear, conventional commit messages.
</role>

## Task
<task>
Analyze the provided git patch and generate both a properly formatted commit message and a technical summary of changes.
</task>

## Instructions
<instructions>
1. **Analyze the patch**:
   - Identify files modified, added, or deleted
   - Understand the nature of changes (feature, bugfix, refactor, docs, etc.)
   - Determine the scope or component affected

2. **Generate commit message following Conventional Commits**:
   - **Subject line** (max 50 characters):
     * Format: \`type(scope): brief description\`
     * Types: feat, fix, docs, style, refactor, test, chore
     * Use imperative mood: "add" not "added" or "adds"
   - **Body** (wrap at 72 characters):
     * Explain WHAT changed and WHY
     * Include motivation and contrast with previous behavior
     * Reference issue numbers if apparent from patch context

3. **Create technical summary**:
   - List affected files with change type
   - Describe functional impact
   - Note any API changes or breaking changes
   - Identify test coverage changes
</instructions>

## Output Format
<output_format>
## Commit Message

\`\`\`
type(scope): subject line (max 50 chars)

Detailed explanation of what changed and why. Wrap at 72
characters per line. Explain the motivation for the change
and contrast with previous behavior.

Include context that helps reviewers understand the change.

Refs: #123
\`\`\`

## Summary of Changes

**Files Modified**: [count]
**Change Type**: [Feature | Bugfix | Refactor | Documentation | Test | Chore]

### Affected Files
- \`path/to/file1.js\`: [Brief description of changes]
- \`path/to/file2.py\`: [Brief description of changes]

### Functional Impact
[Description of how this changes application behavior]

### API Changes
[List any public API additions, modifications, or deprecations]
- None, OR
- Added: [new API]
- Modified: [changed API]
- Deprecated: [old API]

### Breaking Changes
[None, OR list of breaking changes]

### Test Coverage
[Changes to test files or coverage]
</output_format>

## Input Data
<input_data>
Patch Content:
${patchData}

[Patch limited to 40KB]
</input_data>

## Constraints
<constraints>
- Follow Conventional Commits specification strictly
- Subject line must be 50 characters or less
- Body lines must wrap at 72 characters
- Use imperative mood in subject ("add" not "added")
- If patch is truncated (40KB limit), note this in summary
- Infer intent from code changes, don't assume unstated motivations
- If commit type is unclear, default to "chore" and explain in body
</constraints>`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
