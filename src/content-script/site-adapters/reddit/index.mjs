import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      const title = document.querySelector('[id*="post-title"]')?.textContent
      const description = document.querySelector(
        'shreddit-post > div.text-neutral-content',
      )?.textContent
      const texts = document.querySelectorAll('shreddit-comment div.md')
      let answers = ''
      for (let i = 0; i < texts.length; i++) {
        answers += `answer${i}:${texts[i].textContent}|`
      }

      return await cropText(
        `You are an expert in analyzing online forum discussions. ` +
          `Below is content from a social forum (Reddit). Please provide a summary of the discussion and your opinion on it.\n` +
          `Title: '${title}'\n` +
          `Description: '${description}'\n` +
          `Comments:\n${answers}`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
