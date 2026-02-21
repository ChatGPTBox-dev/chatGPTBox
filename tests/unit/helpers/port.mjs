export function createFakePort() {
  const onMessageListeners = new Set()
  const onDisconnectListeners = new Set()
  const postedMessages = []

  return {
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
  }
}
