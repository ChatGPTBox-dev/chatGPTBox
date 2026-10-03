import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, afterEach, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'

register('./tests/setup/markdown-render-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

const LOADING = '<p class="gpt-loading">Waiting for response...</p>'

// Everything the renderer touches, borrowed from the jsdom window.
const globalNames = [
  'window',
  'document',
  'Node',
  'HTMLElement',
  'Element',
  'Event',
  'MouseEvent',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'IntersectionObserver',
  'DOMParser',
  'SVGElement',
  'DocumentFragment',
]

let dom
let MarkdownRender
const containers = new Set()

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    pretendToBeVisual: true,
  })
  for (const name of globalNames) {
    if (dom.window[name] === undefined) continue
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = NoopObserver
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = NoopObserver
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: dom.window.matchMedia,
  })
  ;({ default: MarkdownRender } = await import(
    '../../../src/components/MarkdownRender/markdown.jsx'
  ))
})

afterEach(() => {
  act(() => {
    for (const container of containers) render(null, container)
  })
  for (const container of containers) container.remove()
  containers.clear()
})

after(() => {
  dom.window.close()
})

const mount = (props) => {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  containers.add(container)
  act(() => render(h(MarkdownRender, props), container))
  return container
}

test('the streaming loading placeholder keeps the class its styles target', () => {
  const container = mount({ children: LOADING, done: false })

  const placeholder = container.querySelector('p.gpt-loading')
  assert.ok(placeholder, 'the placeholder must survive sanitizing')
  assert.equal(placeholder.textContent, 'Waiting for response...')
})

test('a fenced code block keeps the highlight.js classes the theme targets', () => {
  const container = mount({ children: '```js\nconst answer = 42\n```' })

  const code = container.querySelector('pre code')
  assert.ok(code, 'the code block must render inside a pre/code pair')
  assert.ok(code.classList.contains('hljs'), 'the hljs theme class must survive')
  assert.ok(code.classList.contains('language-js'), 'the language class must survive')
  assert.ok(container.querySelector('code .hljs-keyword'), 'keywords must be highlighted')
})

test('a gfm table renders as a table element', () => {
  const container = mount({ children: '| a | b |\n| - | - |\n| 1 | 2 |' })

  assert.equal(container.querySelectorAll('table th').length, 2)
  assert.deepEqual(
    [...container.querySelectorAll('table td')].map((cell) => cell.textContent),
    ['1', '2'],
  )
})

test('inline math renders through katex', () => {
  const container = mount({ children: 'Inline $a^2$ end' })

  assert.ok(container.querySelector('.katex'), 'the katex markup must be present')
  assert.equal(container.textContent.includes('$a^2$'), false)
})

test('reasoning stays open while streaming and collapses once done', () => {
  const streaming = mount({ children: LOADING, reasoning: 'weighing options', done: false })
  assert.ok(streaming.querySelector('.reasoning-wrapper.open'), 'a live block stays open')

  const finished = mount({ children: 'The answer.', reasoning: 'weighing options', done: true })
  assert.ok(finished.querySelector('.reasoning-wrapper.collapsed'), 'a finished block collapses')
})

test('a question that mentions a reasoning tag renders it as text', () => {
  const container = mount({ children: 'Use <think> like this.', literalTags: true })

  assert.equal(container.querySelector('.reasoning-wrapper'), null)
  assert.match(container.textContent, /Use <think> like this\./)
})

test('raw html in an answer is preserved', () => {
  const container = mount({ children: 'a<br>b' })

  assert.ok(container.querySelector('br'), 'a line break must survive sanitizing')
})

test('links render through the shared Hyperlink component', () => {
  const container = mount({ children: '[docs](https://example.com/docs)' })

  const link = container.querySelector('a')
  assert.equal(link.getAttribute('href'), 'https://example.com/docs')
  assert.equal(link.getAttribute('target'), '_blank')
  assert.equal(link.getAttribute('rel'), 'nofollow noopener noreferrer')
})
