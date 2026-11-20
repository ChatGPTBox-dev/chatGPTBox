/* eslint-env node */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import {
  loadKatexFonts,
  observeKatexFonts,
} from '../../../src/components/MarkdownRender/katex-fonts.mjs'

const glyph = (family, text = 'x', style = 'normal', weight = '400') => {
  const css = `font-family: ${family}; font-style: ${style}; font-weight: ${weight}`
  return `<span style="${css}">${text}</span>`
}
const simpleMath = glyph('KaTeX_Math', 'x', 'italic') + glyph('KaTeX_Main', '+1')

function fixture(t, html = simpleMath, options = {}) {
  const dom = new JSDOM(
    `<span class="katex"><span class="katex-mathml">${glyph(
      'KaTeX_AMS',
    )}</span><span class="katex-html">${html}</span></span>`,
    { url: options.url || 'https://example.com' },
  )
  t.after(() => dom.window.close())
  const document = dom.window.document
  const root = document.querySelector('.katex')
  const requests = []
  const registered = []
  const warnings = []
  Object.defineProperty(document, 'fonts', { value: { add: (font) => registered.push(font) } })
  t.mock.method(globalThis, 'fetch', async (url) => {
    const filename = url.split('/').at(-1)
    requests.push(filename)
    if (options.fetch) await options.fetch(filename)
    const status = options.status?.(filename) ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => new ArrayBuffer(1),
    }
  })
  const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, 'FontFace')
  globalThis.FontFace = class {
    constructor(family, source, descriptors) {
      this.family = family
      this.source = source
      Object.assign(this, descriptors)
    }
    async load() {
      if (options.load) await options.load(this)
      return this
    }
  }
  t.after(() => {
    if (originalFontFace) Object.defineProperty(globalThis, 'FontFace', originalFontFace)
    else delete globalThis.FontFace
  })
  t.mock.method(console, 'warn', (...args) => warnings.push(args))
  return { root, document, requests, registered, warnings }
}

test('plain content and MathML-only output do not request fonts', async (t) => {
  const f = fixture(t)
  await loadKatexFonts(f.document.createElement('span'))
  f.root.querySelector('.katex-html').remove()
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests, [])
})

test('simple math loads only the two visible faces, cached across renders', async (t) => {
  const f = fixture(t, simpleMath + glyph('KaTeX_Main', '=2'))
  await loadKatexFonts(f.root)
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests.sort(), ['KaTeX_Main-Regular.woff2', 'KaTeX_Math-Italic.woff2'])
  assert.equal(f.registered.length, 2)
  assert.ok(f.registered.every((font) => font.source instanceof ArrayBuffer))
})

test('changed math adds new faces without fetching successful faces again', async (t) => {
  const f = fixture(t)
  await loadKatexFonts(f.root)
  f.root.querySelector('.katex-html').innerHTML =
    simpleMath + glyph('KaTeX_Size2', '∑') + glyph('KaTeX_Main', 'y', 'italic', '700')
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests.slice(2).sort(), [
    'KaTeX_Main-BoldItalic.woff2',
    'KaTeX_Size2-Regular.woff2',
  ])
  assert.equal(f.registered.length, 4)
})

test('concurrent formulas deduplicate requests and register a fast face immediately', async (t) => {
  let finishSlowFont
  let fastFontAdded
  const slowFont = new Promise((resolve) => (finishSlowFont = resolve))
  const fastFont = new Promise((resolve) => (fastFontAdded = resolve))
  const f = fixture(t, simpleMath, {
    load: async (font) => {
      if (font.family === 'KaTeX_Math') await slowFont
    },
  })
  const originalAdd = f.document.fonts.add
  f.document.fonts.add = (font) => {
    originalAdd(font)
    if (font.family === 'KaTeX_Main') fastFontAdded()
  }
  const first = loadKatexFonts(f.root)
  const second = loadKatexFonts(f.root)
  await fastFont
  assert.deepEqual(
    f.registered.map((font) => font.family),
    ['KaTeX_Main'],
  )
  assert.equal(f.requests.length, 2)
  finishSlowFont()
  await Promise.all([first, second])
  assert.equal(f.registered.length, 2)
})

test('a transient fetch failure retries the failed face without another render', async (t) => {
  let failed = false
  const f = fixture(t, simpleMath, {
    fetch: async (filename) => {
      if (filename === 'KaTeX_Math-Italic.woff2' && !failed) {
        failed = true
        throw new Error('Transient fetch failure')
      }
    },
  })
  await loadKatexFonts(f.root)
  assert.equal(f.requests.filter((name) => name === 'KaTeX_Main-Regular.woff2').length, 1)
  assert.equal(f.requests.filter((name) => name === 'KaTeX_Math-Italic.woff2').length, 2)
  assert.equal(f.registered.length, 2)
  assert.deepEqual(f.warnings, [])
})

test('decode failures have bounded retries and allow independent recovery', async (t) => {
  let fail = true
  const f = fixture(t, simpleMath, {
    load: async (font) => {
      if (font.family === 'KaTeX_Math' && fail) throw new Error('Decode failed')
    },
  })
  await loadKatexFonts(f.root)
  assert.equal(f.requests.length, 3)
  assert.deepEqual(
    f.registered.map((font) => font.family),
    ['KaTeX_Main'],
  )
  assert.equal(f.warnings.length, 1)
  fail = false
  await loadKatexFonts(f.root)
  assert.equal(f.requests.length, 4)
  assert.equal(f.registered.length, 2)
})

test('face matching handles quoted families, bold italic and synthetic styles', async (t) => {
  const f = fixture(
    t,
    glyph(`'KaTeX_Main', serif`, 'x', 'italic', '700') +
      glyph('KaTeX_Script', 'y', 'italic', '700') +
      glyph('KaTeX_Math', 'z') +
      glyph('serif', 'plain'),
  )
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests.sort(), [
    'KaTeX_Main-BoldItalic.woff2',
    'KaTeX_Math-Italic.woff2',
    'KaTeX_Script-Regular.woff2',
  ])
})

test('extension pages attach one stylesheet and keep native per-face loading', async (t) => {
  const f = fixture(t, simpleMath, { url: 'chrome-extension://test/popup.html' })
  await loadKatexFonts(f.root)
  await loadKatexFonts(f.root)
  const links = f.document.querySelectorAll('#chatgptbox-katex-fonts')
  assert.equal(links.length, 1)
  assert.ok(links[0].href.endsWith('/katex-fonts.css'))
  assert.deepEqual(f.requests, [])
})

test('a transient HTTP 503 retries successfully without refetching other faces', async (t) => {
  let attempts = 0
  const f = fixture(t, simpleMath, {
    status: (filename) => {
      if (filename === 'KaTeX_Math-Italic.woff2' && ++attempts === 1) return 503
      return 200
    },
  })
  await loadKatexFonts(f.root)
  assert.equal(attempts, 2)
  assert.equal(f.requests.length, 3)
  assert.equal(f.registered.length, 2)
  assert.deepEqual(f.warnings, [])
})

test('persistent HTTP errors retry once and preserve successful faces', async (t) => {
  for (const status of [404, 503]) {
    const f = fixture(t, simpleMath, {
      status: (filename) => (filename === 'KaTeX_Math-Italic.woff2' ? status : 200),
    })
    await loadKatexFonts(f.root)
    assert.equal(f.requests.length, 3)
    assert.deepEqual(
      f.registered.map((font) => font.family),
      ['KaTeX_Main'],
    )
    assert.equal(f.warnings.length, 1)
    assert.match(f.warnings[0][1].message, new RegExp(`KaTeX_Math-Italic: ${status}`))
  }
})

test('identical replacement DOM avoids formula style scans', async (t) => {
  const f = fixture(t)
  const styles = t.mock.method(f.document.defaultView, 'getComputedStyle')
  const stop = observeKatexFonts(f.root)
  t.after(stop)
  await loadKatexFonts(f.root)
  const initialScans = styles.mock.callCount()
  const original = f.root.innerHTML
  const outside = f.document.createElement('p')
  f.document.body.appendChild(outside)
  for (let token = 0; token < 5; token++) {
    outside.textContent += 'token'
    f.root.innerHTML = original
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(styles.mock.callCount(), initialScans)
  assert.equal(f.requests.length, 2)
})

test('content and style changes load faces; disconnect stops observation', async (t) => {
  const f = fixture(t)
  const styles = t.mock.method(f.document.defaultView, 'getComputedStyle')
  const stop = observeKatexFonts(f.root)
  t.after(stop)
  await loadKatexFonts(f.root)
  const html = f.root.querySelector('.katex-html')
  html.insertAdjacentHTML('beforeend', glyph('KaTeX_AMS', 'R'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(f.requests.includes('KaTeX_AMS-Regular.woff2'))
  html.querySelector('span').style.fontWeight = '700'
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(f.requests.includes('KaTeX_Math-BoldItalic.woff2'))
  const scans = styles.mock.callCount()
  html.querySelector('span').firstChild.data = 'y'
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(styles.mock.callCount() > scans)
  stop()
  const beforeDisconnect = styles.mock.callCount()
  html.insertAdjacentHTML('beforeend', glyph('KaTeX_Size3', '∑'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(styles.mock.callCount(), beforeDisconnect)
  assert.ok(!f.requests.includes('KaTeX_Size3-Regular.woff2'))
})
