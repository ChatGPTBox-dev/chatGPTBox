import assert from 'node:assert/strict'
import { register } from 'node:module'
import { cwd } from 'node:process'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'

register('./tests/setup/jsx-loader-hooks.mjs', pathToFileURL(cwd() + '/').href)

const malicious = [
  '<script>alert("script")</script>',
  '<img src=x onerror=alert("image")>',
  '[attacker-link](javascript:alert("link"))',
  'https://evil.example/x',
  '# attacker-heading',
  '- attacker-list',
  '```attacker-code```',
  '| attacker | table |',
].join(' ')

const result = {
  status: malicious,
  overview: `${malicious}\n## multiline-heading\n- multiline-list\n\`\`\`\nmultiline-code\n\`\`\``,
  keyMoments: [{ startMs: 2_000, point: malicious }],
  chapters: [
    {
      startMs: 3_000,
      endMs: 4_000,
      title: malicious,
      summary: `${malicious}\n# chapter-summary-heading`,
    },
  ],
  transcriptSegments: [
    {
      startMs: 5_000,
      speaker: `Speaker\n# speaker-heading\n- speaker-list ${malicious}`,
      text: malicious,
    },
  ],
}

let dom
let MarkdownRender
let ReactMarkdown
let buildVideoSummaryMarkdown
const originals = new Map()
const globalNames = ['window', 'document', 'Node', 'Event', 'HTMLElement']

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of globalNames) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  const [markdownRenderModule, reactMarkdownModule, markdownExportModule] = await Promise.all([
    import('../../../src/components/MarkdownRender/markdown.jsx'),
    import('react-markdown'),
    import('../../../src/video-summary/markdown-export.mjs'),
  ])
  MarkdownRender = markdownRenderModule.MarkdownRender
  ReactMarkdown = reactMarkdownModule.default
  buildVideoSummaryMarkdown = markdownExportModule.buildVideoSummaryMarkdown
})

after(() => {
  dom.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

function assertInertSink(container) {
  assert.equal(
    container.querySelectorAll('a, img, video, script, iframe, pre, code').length,
    0,
    container.innerHTML,
  )
  assert.equal(container.querySelectorAll('h1').length, 1)
  assert.equal(container.querySelectorAll('h2').length, 4)
  assert.equal(container.querySelectorAll('h3').length, 1)
  assert.equal(container.querySelectorAll('ul').length, 3)
  assert.equal(container.querySelectorAll('ol').length, 0)
  assert.match(container.textContent, /attacker-link/)
  assert.match(container.textContent, /evil\.example/)
  assert.match(container.textContent, /attacker-heading/)
  assert.match(container.textContent, /multiline-heading/)
  assert.match(container.textContent, /speaker-heading/)
  assert.match(container.textContent, /attacker-code/)
}

test('structured fields stay inert through the archive renderer and download parser', () => {
  const archivedAnswer = buildVideoSummaryMarkdown({
    title: malicious,
    preferredLanguage: malicious,
    result,
  })
  const archiveRoot = document.createElement('div')
  const downloadRoot = document.createElement('div')
  document.body.append(archiveRoot, downloadRoot)

  act(() => render(h(MarkdownRender, null, archivedAnswer), archiveRoot))
  act(() => render(h(ReactMarkdown, null, archivedAnswer), downloadRoot))

  assertInertSink(archiveRoot)
  assertInertSink(downloadRoot)

  act(() => render(null, archiveRoot))
  act(() => render(null, downloadRoot))
  archiveRoot.remove()
  downloadRoot.remove()
})
