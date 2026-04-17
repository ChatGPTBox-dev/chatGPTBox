import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isEdge } from '../../../src/utils/is-edge.mjs'
import { isFirefox } from '../../../src/utils/is-firefox.mjs'
import { isMobile } from '../../../src/utils/is-mobile.mjs'
import { isSafari } from '../../../src/utils/is-safari.mjs'

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

const restoreGlobal = (name, descriptor) => {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
  } else {
    delete globalThis[name]
  }
}

const setBrowserState = ({ userAgent, vendor, userAgentData, opera } = {}) => {
  const navigatorState = {}
  if (userAgent !== undefined) navigatorState.userAgent = userAgent
  if (vendor !== undefined) navigatorState.vendor = vendor
  if (userAgentData !== undefined) navigatorState.userAgentData = userAgentData

  Object.defineProperty(globalThis, 'navigator', {
    value: navigatorState,
    configurable: true,
  })

  const windowState = {}
  if (opera !== undefined) windowState.opera = opera
  Object.defineProperty(globalThis, 'window', {
    value: windowState,
    configurable: true,
  })
}

afterEach(() => {
  restoreGlobal('navigator', originalNavigatorDescriptor)
  restoreGlobal('window', originalWindowDescriptor)
})

test('isMobile prioritizes navigator.userAgentData.mobile when available', () => {
  setBrowserState({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    userAgentData: { mobile: true },
  })

  assert.equal(isMobile(), true)
})

test('isMobile returns false for desktop-like user agent when userAgentData is unavailable', () => {
  setBrowserState({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  })

  assert.equal(isMobile(), false)
})

test('isMobile detects mobile from iPhone user agent', () => {
  setBrowserState({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  })

  assert.equal(isMobile(), true)
})

test('isMobile falls back to window.opera when userAgent and vendor are missing', () => {
  setBrowserState({
    userAgent: undefined,
    vendor: undefined,
    opera: 'Opera Mini/36.2.2254/191.249',
  })

  assert.equal(isMobile(), true)
})

test('isEdge detects Edge user agent', () => {
  setBrowserState({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 EdG/120.0.0.0',
  })

  assert.equal(isEdge(), true)
})

test('isEdge excludes non-Edge user agent', () => {
  setBrowserState({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  })

  assert.equal(isEdge(), false)
})

test('isFirefox detects Firefox user agent', () => {
  setBrowserState({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
  })

  assert.equal(isFirefox(), true)
})

test('isFirefox excludes non-Firefox user agent', () => {
  setBrowserState({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15',
  })

  assert.equal(isFirefox(), false)
})

test('isSafari requires exact Apple vendor match', () => {
  setBrowserState({ vendor: 'Apple Computer, Inc.' })
  assert.equal(isSafari(), true)

  setBrowserState({ vendor: 'Google Inc.' })
  assert.equal(isSafari(), false)
})
