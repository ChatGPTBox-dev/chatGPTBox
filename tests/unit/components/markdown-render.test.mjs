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

test('a question that mentions a reasoning tag cannot open a thinking block', () => {
  const container = mount({ children: 'Use <think> like this.' })

  assert.equal(container.querySelector('.reasoning-wrapper'), null)
  assert.match(container.textContent, /Use/)
  assert.match(container.textContent, /like this\./)
})

test('a reasoning tag in the answer never becomes a thinking block', () => {
  const container = mount({ children: '<think>not thinking</think>\n\nJust text.' })

  assert.equal(container.querySelector('.reasoning-wrapper'), null)
  assert.match(container.textContent, /Just text\./)
})

test('a reasoning tag inside a code fence stays in the answer', () => {
  const container = mount({ children: 'Example:\n\n```html\n<think>x</think>\n```' })

  assert.equal(container.querySelector('.reasoning-wrapper'), null)
  assert.ok(container.querySelector('pre code'))
  assert.match(container.textContent, /<think>x<\/think>/)
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

test('an answer that mentions the loading class still renders with its reasoning', () => {
  const container = mount({
    children: 'The class gpt-loading marks the waiting placeholder.',
    reasoning: 'weighing options',
    done: true,
  })

  assert.ok(container.querySelector('.reasoning-wrapper.collapsed'))
  assert.match(container.textContent, /gpt-loading marks the waiting placeholder/)
})

test('a closing tag inside code in the reasoning cannot leak into the answer', () => {
  const container = mount({
    children: 'The answer.',
    reasoning: 'The user wrote `</think>` in code, then explained it.',
    done: true,
  })

  assert.ok(container.querySelector('.reasoning-wrapper.collapsed'))
  assert.match(container.textContent, /The answer\./)
  assert.doesNotMatch(container.textContent, /then explained it/)
})

test('reasoning stays open when its code mentions a closing tag', () => {
  const container = mount({
    children: LOADING,
    reasoning: 'The user wrote `</think>` in code.',
    done: false,
  })

  assert.ok(container.querySelector('.reasoning-wrapper.open'))
})

test('a reasoning tag inside the thinking opens no nested block', () => {
  const container = mount({
    children: LOADING,
    reasoning: '<think>nested</think> still thinking',
    done: false,
  })

  assert.equal(container.querySelectorAll('.reasoning-wrapper').length, 1)
  assert.match(container.textContent, /still thinking/)
})

test('the thinking is rendered as markdown inside its own block', () => {
  const container = mount({ children: LOADING, reasoning: 'weighing **options**', done: false })

  const content = container.querySelector('.reasoning-content')
  assert.ok(content, 'the thinking block holds the content')
  assert.ok(content.querySelector('strong'), 'the thinking goes through the markdown pipeline')
})

test('the thinking highlights code the same way the answer does', () => {
  const container = mount({
    children: LOADING,
    reasoning: '```js\nconst answer = 42\n```',
    done: false,
  })

  const code = container.querySelector('.reasoning-content pre code')
  assert.ok(code, 'the thinking renders its code block')
  assert.ok(code.classList.contains('hljs'), 'the thinking uses the same highlight plugin')
})

test('a numbered list that begins at 1 is numbered from 1 once it finishes', async () => {
  const container = mount({ children: '1. a\n2. b', done: false })
  act(() => render(h(MarkdownRender, { children: '1. a\n2. b', done: true }), container))
  // The renderer adds `start="0"` on its own write, and the correction lands on the observer.
  await new Promise((resolve) => setTimeout(resolve, 32))

  const list = container.querySelector('ol')
  assert.ok(list, 'the list must render')
  assert.equal(
    list.hasAttribute('start'),
    false,
    'the finalized list must not be numbered from zero',
  )
})

test('a numbered list that begins at 0 keeps its start', () => {
  const container = mount({ children: '0. a\n1. b', done: true })

  assert.equal(container.querySelector('ol').getAttribute('start'), '0')
})

test('a link the sanitizer refuses does not take the answer down with it', () => {
  const container = mount({ children: 'before [x](javascript:alert(1)) after' })

  assert.match(container.textContent, /before x after/)
})

test('an anchor the renderer passes without a destination renders as text', async () => {
  const { Hyperlink } = await import('../../../src/components/MarkdownRender/Hyperlink.jsx')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  containers.add(container)

  act(() => render(h(Hyperlink, { href: undefined }, 'text'), container))

  assert.equal(container.textContent, 'text')
  assert.equal(container.querySelector('a'), null)
})

test('a table that arrives in one piece keeps its header row', () => {
  // A saved answer, a question and an error all reach the renderer as one finished write.
  const container = mount({ children: 'Intro.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nOutro.' })

  const table = container.querySelector('table')
  assert.ok(table, 'the table must render')
  assert.equal(table.getAttribute('data-headless'), 'false', 'the header row must survive')
  assert.deepEqual(
    Array.from(container.querySelectorAll('thead th')).map((cell) => cell.textContent),
    ['a', 'b'],
  )
  assert.equal(container.querySelectorAll('table tr').length, 2, 'no block is absorbed')
  assert.equal(container.textContent.includes('Intro.'), true)
})

test('a thematic break after a table survives a single write', () => {
  const container = mount({
    children: 'Intro.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\nAfter.',
  })

  assert.equal(container.querySelectorAll('hr').length, 1)
  assert.equal(container.querySelector('table').getAttribute('data-headless'), 'false')
})
