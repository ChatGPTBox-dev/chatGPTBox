import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      const title = document.querySelector('.QuestionHeader-title')?.textContent
      if (title) {
        const description = document.querySelector('.QuestionRichText')?.textContent
        const answerQuery = '.AnswerItem .RichText'

        let answer = ''
        if (location.pathname.includes('answer')) {
          answer = document.querySelector(answerQuery)?.textContent
          return await cropText(
            `You are an insightful analyst of Q&A discussions. ` +
              `Below is content from Zhihu, a Q&A platform. Please provide a summary of the question and answer, and your opinion on them.\n` +
              `Question: "${title}"\n` +
              `Description: "${description}"\n` +
              `Answer:\n${answer}`,
          )
        } else {
          const answers = document.querySelectorAll(answerQuery)
          for (let i = 1; i <= answers.length && i <= 4; i++) {
            answer += `answer${i}: ${answers[i - 1].textContent}|`
          }
          return await cropText(
            `You are an insightful analyst of Q&A discussions. ` +
              `Below is content from Zhihu, a Q&A platform. Please provide a summary of the question and answers, and your opinion on them.\n` +
              `Question: "${title}"\n` +
              `Description: "${description}"\n` +
              `Answers:\n${answer}`,
          )
        }
      } else {
        const title = document.querySelector('.Post-Title')?.textContent
        const description = document.querySelector('.Post-RichText')?.textContent

        if (title) {
          return await cropText(
            `You are an expert article analyst. ` +
              `Below is an article from Zhihu. Please provide a summary of the article and your opinion on it.\n` +
              `Title: "${title}"\n` +
              `Content:\n"${description}"`,
          )
        }
      }
    } catch (e) {
      console.log(e)
    }
  },
}
