import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  calculateVideoSummaryHostWidth,
  createVideoSummaryHostWidthController,
} from '../../../src/content-script/site-adapters/bilibili/video-summary-host-width.mjs'

test('host width expands rightward within preferred, extra-width, and viewport limits', () => {
  assert.equal(
    calculateVideoSummaryHostWidth({ parentWidth: 420, left: 1400, viewportWidth: 2000 }),
    560,
  )
  assert.equal(
    calculateVideoSummaryHostWidth({ parentWidth: 420, left: 1400, viewportWidth: 1900 }),
    476,
  )
  assert.equal(
    calculateVideoSummaryHostWidth({ parentWidth: 420, left: 1500, viewportWidth: 1920 }),
    420,
  )
})

test('host width controller updates on resize and releases listeners on dispose', () => {
  const styleValues = new Map()
  const listeners = new Map()
  let observerCallback = null
  let observedTarget = null
  let observerDisconnected = false

  const container = {
    getBoundingClientRect: () => ({ left: 1400 }),
    style: {
      setProperty(name, value) {
        styleValues.set(name, value)
      },
    },
  }
  const targetElement = {
    getBoundingClientRect: () => ({ width: 420 }),
  }
  const windowObject = {
    innerWidth: 2000,
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  }
  class FakeResizeObserver {
    constructor(callback) {
      observerCallback = callback
    }

    observe(target) {
      observedTarget = target
    }

    disconnect() {
      observerDisconnected = true
    }
  }

  const controller = createVideoSummaryHostWidthController({
    container,
    targetElement,
    windowObject,
    ResizeObserverImpl: FakeResizeObserver,
  })

  assert.equal(styleValues.get('--bilibili-video-summary-width'), '560px')
  assert.equal(observedTarget, targetElement)

  windowObject.innerWidth = 1870
  listeners.get('resize')()
  assert.equal(styleValues.get('--bilibili-video-summary-width'), '446px')

  windowObject.innerWidth = 1820
  observerCallback()
  assert.equal(styleValues.get('--bilibili-video-summary-width'), '420px')

  controller.dispose()
  assert.equal(observerDisconnected, true)
  assert.equal(listeners.has('resize'), false)
})

test('host styles unlock only the clipping Bilibili ancestors that contain the summary', () => {
  const styles = readFileSync(
    new URL('../../../src/components/BilibiliVideoSummaryView/styles.scss', import.meta.url),
    'utf8',
  )

  assert.equal(
    styles.includes('.video-pod-above-modules__inner:has(.bilibili-video-summary-host)'),
    true,
  )
  assert.equal(styles.includes('.video-pod-above-modules:has(.bilibili-video-summary-host)'), true)
  assert.match(styles, /overflow:\s*visible\s*!important/)
})
