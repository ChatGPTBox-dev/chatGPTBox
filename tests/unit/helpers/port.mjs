export function createFakePort({ name = '', sender = undefined } = {}) {
  const onMessageListeners = new Set()
  const onDisconnectListeners = new Set()
  const postedMessages = []
  let disconnectCount = 0

  return {
    name,
    sender,
    postedMessages,
    onMessage: {
      addListener(listener) {
        onMessageListeners.add(listener)
      },
      removeListener(listener) {
        onMessageListeners.delete(listener)
      },
    },
    onDisconnect: {
      addListener(listener) {
        onDisconnectListeners.add(listener)
      },
      removeListener(listener) {
        onDisconnectListeners.delete(listener)
      },
    },
    postMessage(message) {
      postedMessages.push(message)
    },
    emitMessage(message) {
      for (const listener of Array.from(onMessageListeners)) {
        listener(message)
      }
    },
    emitDisconnect() {
      disconnectCount += 1
      for (const listener of Array.from(onDisconnectListeners)) {
        listener()
      }
    },
    disconnect() {
      disconnectCount += 1
      for (const listener of Array.from(onDisconnectListeners)) {
        listener()
      }
    },
    listenerCounts() {
      return {
        onMessage: onMessageListeners.size,
        onDisconnect: onDisconnectListeners.size,
      }
    },
    disconnectCount() {
      return disconnectCount
    },
  }
}
