import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      const title = document.querySelector('#juejin .article-title')?.innerText
      const description = document.querySelector('#juejin #article-root')?.innerText
      if (title && description) {
        const author = document.querySelector('#juejin .author-block .info-box span')?.innerText
        const comments = document.querySelectorAll('.comment-list .comment-content')
        let comment = ''
        for (let i = 1; i <= comments.length && i <= 4; i++) {
          comment += `answer${i}: ${comment[i - 1].innerText}|`
        }
        return await cropText(
          `You are an expert content analyst and summarizer. ` +
            `Please analyze the following Juejin article and its comments. Provide a summary of the article (including author), your opinion on it, and a summary of the comments.\n` +
            `Article Title: "${title}"\n` +
            `Author: "${author}"\n` +
            `Content:\n"${description}"\n\n` +
            `Selected comments:\n${comment}`,
        )
      }
    } catch (e) {
      console.log(e)
    }
  },
}
