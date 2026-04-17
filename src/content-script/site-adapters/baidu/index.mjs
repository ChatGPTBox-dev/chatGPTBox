import { config } from '../index'

export default {
  init: async (hostname, userConfig, getInput, mountComponent) => {
    try {
      const targetNode = document.getElementById('wrapper_wrapper')
      const observer = new MutationObserver(async (records) => {
        if (
          records.some(
            (record) =>
              record.type === 'childList' &&
              [...record.addedNodes].some((node) => node.id === 'container'),
          )
        ) {
          const searchValue = await getInput(config.baidu.inputQuery)
          if (searchValue) {
            mountComponent('baidu', config.baidu)
          }
        }
      })
      observer.observe(targetNode, { childList: true })
    } catch (e) {
      /* empty */
    }
    return true
  },
}
