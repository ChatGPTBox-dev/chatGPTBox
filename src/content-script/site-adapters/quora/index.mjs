import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      if (location.pathname === '/') return

      const texts = document.querySelectorAll('.q-box.qu-userSelect--text')
      let title
      if (texts.length > 0) title = texts[0].textContent
      let answers = ''
      if (texts.length > 1)
        for (let i = 1; i < texts.length; i++) {
          answers += `answer${i}:${texts[i].textContent}|`
        }

      return await cropText(
        `You are an insightful analyst of Q&A discussions. ` +
          `Below is content from a Q&A platform. Please provide a summary of the discussion and your opinion on it.\n` +
          `Question: '${title}'\n` +
          `Answers:\n${answers}`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
