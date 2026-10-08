const MAX_HOST_WIDTH_PX = 560
const MAX_EXTRA_WIDTH_PX = 160
const VIEWPORT_RIGHT_GUTTER_PX = 24
const WIDTH_PROPERTY = '--video-summary-width'

function toPositiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function calculateVideoSummaryHostWidth({ parentWidth, left, viewportWidth }) {
  const resolvedParentWidth = toPositiveNumber(parentWidth)
  const resolvedViewportWidth = toPositiveNumber(viewportWidth)
  const resolvedLeft = Number(left)
  if (
    !resolvedParentWidth ||
    !resolvedViewportWidth ||
    !Number.isFinite(resolvedLeft) ||
    resolvedLeft < 0
  ) {
    return null
  }

  const availableWidth = Math.floor(resolvedViewportWidth - resolvedLeft - VIEWPORT_RIGHT_GUTTER_PX)
  if (availableWidth <= resolvedParentWidth) return Math.floor(resolvedParentWidth)

  return Math.floor(
    Math.min(MAX_HOST_WIDTH_PX, resolvedParentWidth + MAX_EXTRA_WIDTH_PX, availableWidth),
  )
}

export function createVideoSummaryHostWidthController({
  container,
  targetElement,
  windowObject = globalThis.window,
  ResizeObserverImpl = globalThis.ResizeObserver,
}) {
  const update = () => {
    const width = calculateVideoSummaryHostWidth({
      parentWidth: targetElement?.getBoundingClientRect?.().width,
      left: container?.getBoundingClientRect?.().left,
      viewportWidth: windowObject?.innerWidth,
    })
    if (width) container?.style?.setProperty?.(WIDTH_PROPERTY, `${width}px`)
  }

  const onWindowResize = () => update()
  windowObject?.addEventListener?.('resize', onWindowResize)

  const resizeObserver =
    typeof ResizeObserverImpl === 'function' ? new ResizeObserverImpl(update) : null
  resizeObserver?.observe?.(targetElement)
  update()

  return {
    update,
    dispose() {
      resizeObserver?.disconnect?.()
      windowObject?.removeEventListener?.('resize', onWindowResize)
    },
  }
}
