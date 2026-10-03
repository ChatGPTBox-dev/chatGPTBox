export const DEFAULT_INPUT_HEIGHT = 160
export const MIN_INPUT_HEIGHT = 70
export const MIN_CONVERSATION_HEIGHT = 80

const INPUT_RESIZE_KEY_STEP = 10
const INPUT_RESIZE_KEY_LARGE_STEP = 40

export function clampInputHeight(height, maxHeight) {
  const safeMaxHeight = Math.max(MIN_INPUT_HEIGHT, maxHeight)
  return Math.min(Math.max(MIN_INPUT_HEIGHT, height), safeMaxHeight)
}

export function getPointerInputHeight(startHeight, startY, currentY, maxHeight) {
  return clampInputHeight(startHeight + startY - currentY, maxHeight)
}

export function getKeyboardInputHeight(currentHeight, key, maxHeight, useLargeStep = false) {
  const step = useLargeStep ? INPUT_RESIZE_KEY_LARGE_STEP : INPUT_RESIZE_KEY_STEP

  switch (key) {
    case 'ArrowUp':
      return clampInputHeight(currentHeight + step, maxHeight)
    case 'ArrowDown':
      return clampInputHeight(currentHeight - step, maxHeight)
    case 'Home':
      return MIN_INPUT_HEIGHT
    case 'End':
      return Math.max(MIN_INPUT_HEIGHT, maxHeight)
    default:
      return null
  }
}
