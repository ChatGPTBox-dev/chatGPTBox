import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const readability = require('@mozilla/readability')
const originalIsProbablyReaderable = readability.isProbablyReaderable
readability.isProbablyReaderable = () => false
const { getCoreContentText } = await import('../../../src/utils/get-core-content-text.mjs')

const globalNames = ['document', 'location', 'Node']
const originalDescriptors = new Map(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
)
let dom

after(() => {
  readability.isProbablyReaderable = originalIsProbablyReaderable
})

const setDOM = (html, url = 'https://example.com/') => {
  dom = new JSDOM(html, { url })

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

test('getCoreContentText prefers the known-site selector over a generic article', () => {
  setDOM(
    `
      <main id="search">Known site content</main>
      <article>Generic article content</article>
    `,
    'https://www.google.com/search?q=test',
  )

  assert.equal(getCoreContentText(), 'Known site content')
})

test('getCoreContentText uses an article and normalizes its text', () => {
  setDOM(`
    <article>  First  paragraph

      Second,,  </article>
  `)

  assert.equal(getCoreContentText(), 'FirstparagraphSecond')
})

test('getCoreContentText falls back to a small document body', (t) => {
  t.mock.method(console, 'log', () => {})
  setDOM('<body>Body fallback content</body>')

  assert.equal(getCoreContentText(), 'Body fallback content')
})

test('getCoreContentText falls back to the largest body child', (t) => {
  t.mock.method(console, 'log', () => {})
  setDOM(`
    <body>
      <main id="content">Largest content</main>
      <aside>Smaller content</aside>
    </body>
  `)

  document.body.getBoundingClientRect = () => ({ width: 100, height: 100 })
  document.querySelector('#content').getBoundingClientRect = () => ({ width: 80, height: 80 })
  document.querySelector('aside').getBoundingClientRect = () => ({ width: 20, height: 20 })

  assert.equal(getCoreContentText(), 'Largest content')
})

test('getCoreContentText uses a major nested content element', (t) => {
  t.mock.method(console, 'log', () => {})
  setDOM(`
    <body>
      <main id="content">
        <div id="nested-content">Nested content</div>
        <aside>Smaller content</aside>
      </main>
    </body>
  `)

  document.body.getBoundingClientRect = () => ({ width: 100, height: 100 })
  document.querySelector('#content').getBoundingClientRect = () => ({ width: 80, height: 80 })
  document.querySelector('#nested-content').getBoundingClientRect = () => ({
    width: 60,
    height: 60,
  })
  document.querySelector('aside').getBoundingClientRect = () => ({ width: 10, height: 10 })

  assert.equal(getCoreContentText(), 'Nested content')
})
