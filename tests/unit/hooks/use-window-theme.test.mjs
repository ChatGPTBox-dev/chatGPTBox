import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { render, unmountComponentAtNode } from 'react-dom'
import { act } from 'preact/test-utils'
import { useWindowTheme } from '../../../src/hooks/use-window-theme.mjs'

const globalNames = ['window', 'document', 'Node']
const originalDescriptors = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
)
let dom

const ThemeProbe = () => {
  useWindowTheme()
  return null
}

const setDOM = () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>')

  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
    })
  }
}

afterEach(() => {
  dom?.window.close()
  dom = undefined

  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete globalThis[name]
    }
  }
})

test('useWindowTheme removes the listener from the MediaQueryList that registered it', () => {
  setDOM()
  const mediaQueries = []

  window.matchMedia = () => {
    const listeners = new Set()
    const mediaQuery = {
      matches: false,
      addEventListener(type, listener) {
        assert.equal(type, 'change')
        listeners.add(listener)
      },
      removeEventListener(type, listener) {
        assert.equal(type, 'change')
        listeners.delete(listener)
      },
      listenerCount() {
        return listeners.size
      },
    }
    mediaQueries.push(mediaQuery)
    return mediaQuery
  }

  const container = document.querySelector('#root')
  act(() => render(createElement(ThemeProbe), container))

  const subscribedMediaQuery = mediaQueries.find((mediaQuery) => mediaQuery.listenerCount() === 1)
  assert.ok(subscribedMediaQuery)

  act(() => unmountComponentAtNode(container))

  assert.equal(subscribedMediaQuery.listenerCount(), 0)
})
