const encoder = new TextEncoder()

export function createMockSseResponse(chunks, options = {}) {
  const { ok = true, status = 200, statusText = 'OK', json = async () => ({}) } = options

  return {
    ok,
    status,
    statusText,
    json,
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            if (index >= chunks.length) {
              return { done: true, value: undefined }
            }

            const value = encoder.encode(chunks[index])
            index += 1
            return { done: false, value }
          },
        }
      },
    },
  }
}
