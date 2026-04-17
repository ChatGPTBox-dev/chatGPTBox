import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      const title = document.querySelector('#question-header .question-hyperlink')?.textContent
      if (title) {
        const description = document.querySelector('.postcell .s-prose')?.textContent
        let answer = ''
        const answers = document.querySelectorAll('.answercell .s-prose')
        if (answers.length > 0)
          for (let i = 1; i <= answers.length && i <= 2; i++) {
            answer += `answer${i}: ${answers[i - 1].textContent}|`
          }

        return await cropText(
          `You are an expert software developer and technical problem solver. ` +
            `The following content is from a developer Q&A platform (Stack Overflow).\n\n` +
            `Question: "${title}"\n` +
            `Question Description: "${description}"\n\n` +
            `Provided Answers:\n${answer}\n\n` +
            `Please perform the following tasks:\n` +
            `1. **Direct Solution:** Based on the provided answers, formulate a concise and effective solution to the question. ` +
            `If applicable, include a brief code snippet (using markdown for formatting).\n` +
            `2. **Overview of Answers:** Provide an overview of the different approaches or key points mentioned in the provided answers. ` +
            `You can highlight any notable variations, pros, or cons if apparent.`,
        )
      }
    } catch (e) {
      console.log(e)
    }
  },
}
