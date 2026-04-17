import { cropText } from '../../../utils'

export default {
  inputQuery: async () => {
    try {
      const title = document.querySelector('.title')?.textContent.trim()
      const authors = document.querySelector('.authors')?.textContent
      const abstract = document.querySelector('blockquote.abstract')?.textContent.trim()

      return await cropText(
        `You are a research assistant skilled in academic paper analysis. ` +
          `Based on the provided paper abstract from a preprint site, generate a structured summary. ` +
          `The summary should clearly outline: key findings, methodology, and conclusions. ` +
          `Pay special attention to highlighting the main contributions of the paper. ` +
          `Ensure the summary is concise and maintains an academic tone.\n` +
          `Title: ${title}\n` +
          `Authors: ${authors}\n` +
          `Abstract: ${abstract}`,
      )
    } catch (e) {
      console.log(e)
    }
  },
}
