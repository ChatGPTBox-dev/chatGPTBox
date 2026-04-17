import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      const author = document.querySelector('main article a > span')?.textContent
      const description =
        document.querySelector('#article-content')?.textContent ||
        document.querySelector('#thead-gallery')?.textContent
      if (author && description) {
        const title = document.querySelector('main article h1')?.textContent
        if (title) {
          return await cropText(
            `You are an expert content summarizer. Please carefully read the following article. ` +
              `Provide a conclusion and 3 to 5 main points, presented as a markdown list. ` +
              `The summary should be concise, clear, and accurately reflect the core content.\n` +
              `Title: "${title}"\n` +
              `Author: "${author}"\n` +
              `Content:\n"${description}"`,
          )
        } else {
          return await cropText(
            `You are an expert content summarizer. Please carefully read the following long tweet. ` +
              `Provide a conclusion and 3 to 5 main points, presented as a markdown list. ` +
              `The summary should be concise, clear, and accurately reflect the core content.\n` +
              `Author: "${author}"\n` +
              `Content:\n"${description}"`,
          )
        }
      }
    } catch (e) {
      console.log(e)
    }
  },
}
