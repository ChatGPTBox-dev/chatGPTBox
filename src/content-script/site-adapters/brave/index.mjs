import { waitForSiteAdapterElement } from '../../../utils'
import { config } from '../index.mjs'

export default {
  init: async (hostname, userConfig) => {
    const selector = (
      userConfig.insertAtTop
        ? config.brave.resultsContainerQuery
        : [...config.brave.sidebarContainerQuery, ...config.brave.resultsContainerQuery]
    ).join(',')
    await waitForSiteAdapterElement(selector)
    return true
  },
}
