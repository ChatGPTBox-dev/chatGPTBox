// https://stackoverflow.com/questions/64304365/stop-request-after-x-amount-is-fetched

export async function limitedFetch(url, maxBytes) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest()
      const rejectHttpError = () => reject(new Error(String(xhr.status)))
      const isSuccessfulStatus = () => xhr.status >= 200 && xhr.status < 300
      xhr.onprogress = (ev) => {
        if (ev.loaded < maxBytes) return
        if (isSuccessfulStatus()) {
          resolve(ev.target.responseText.substring(0, maxBytes))
        } else {
          rejectHttpError()
        }
        xhr.abort()
      }
      xhr.onload = (ev) => {
        if (!isSuccessfulStatus()) {
          rejectHttpError()
          return
        }
        resolve(ev.target.responseText.substring(0, maxBytes))
      }
      xhr.onerror = (ev) => {
        reject(new Error(ev.target.status))
      }

      xhr.open('GET', url)
      xhr.send()
    } catch (err) {
      reject(err)
    }
  })
}
