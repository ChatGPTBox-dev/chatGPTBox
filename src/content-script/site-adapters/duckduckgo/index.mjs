import { waitForSiteAdapterElement } from '../../../utils/index.mjs'
import { config } from '../index'

export default {
  init: async (hostname, userConfig) => {
    if (userConfig.insertAtTop) {
      return !!(await waitForSiteAdapterElement(config.duckduckgo.resultsContainerQuery[0]))
    }
    return true
  },
}
