export function waitForElementToExistAndSelect(selector, timeout = 0) {
  return new Promise((resolve) => {
    const existingElement = document.querySelector(selector)
    if (existingElement) return resolve(existingElement)

    let timeoutId

    const finish = (element) => {
      observer.disconnect()
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      resolve(element)
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector)
      if (element) finish(element)
    })

    observer.observe(document.body, {
      subtree: true,
      childList: true,
    })

    if (timeout)
      timeoutId = setTimeout(() => {
        finish(null)
      }, timeout)
  })
}

export function waitForSiteAdapterElement(selector) {
  return waitForElementToExistAndSelect(selector, 5_000)
}
