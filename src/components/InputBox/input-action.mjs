export function shouldHandleInputAction(event) {
  if (event.type === 'click') return true
  if (event.type !== 'keydown') return false

  const isComposing = event.isComposing || event.nativeEvent?.isComposing
  if (isComposing || event.keyCode === 229) return false

  const isEnter = event.key === 'Enter' || event.keyCode === 13
  return isEnter && !event.shiftKey
}
