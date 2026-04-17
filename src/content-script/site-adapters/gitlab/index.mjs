import { cropText, limitedFetch } from '../../../utils'

const getPatchUrl = async () => {
  const patchUrl = location.origin + location.pathname + '.patch'
  const response = await fetch(patchUrl, { method: 'HEAD' })
  if (response.ok) return patchUrl
  return ''
}

const getPatchData = async (patchUrl) => {
  if (!patchUrl) return

  let patchData = await limitedFetch(patchUrl, 1024 * 40)
  patchData = patchData.substring(patchData.indexOf('---'))
  return patchData
}

export default {
  inputQuery: async () => {
    try {
      if (location.pathname.includes('/blob')) {
        const fileData = await limitedFetch(location.href.replace('/blob/', '/raw/'), 1024 * 40)
        if (!fileData) return

        return await cropText(
          `You are a senior software engineer and code reviewer. ` +
            `Analyze the following file content thoroughly. ` +
            `Explain its purpose, main functionalities, and how different parts of the code contribute to its overall behavior. ` +
            `Identify any potential issues, areas for improvement, or notable design patterns. ` +
            `Use markdown syntax (e.g., code blocks, bolding, lists) to structure your explanation for better readability.\n\n` +
            `File content:\n\`\`\`\n${fileData}\n\`\`\``,
        )
      } else {
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
      }
    } catch (e) {
      console.log(e)
    }
  },
}
