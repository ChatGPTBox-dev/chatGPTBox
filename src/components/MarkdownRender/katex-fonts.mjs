import Browser from 'webextension-polyfill'

const fontFiles = [
  'KaTeX_AMS-Regular',
  'KaTeX_Caligraphic-Bold',
  'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold',
  'KaTeX_Fraktur-Regular',
  'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic',
  'KaTeX_Main-Italic',
  'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic',
  'KaTeX_Math-Italic',
  'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic',
  'KaTeX_SansSerif-Regular',
  'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular',
  'KaTeX_Size2-Regular',
  'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular',
  'KaTeX_Typewriter-Regular',
].map((filename) => {
  const [family, variant] = filename.split('-')
  return {
    filename,
    family,
    style: variant.includes('Italic') ? 'italic' : 'normal',
    weight: variant.includes('Bold') ? '700' : '400',
  }
})
const fontLoads = new WeakMap()

/** Watch actual formula changes instead of rebuilt React child identities. */
export function observeKatexFonts(root) {
  let content
  const update = () => {
    const nextContent = root.outerHTML
    if (nextContent === content) return
    content = nextContent
    loadKatexFonts(root)
  }
  const observer = new root.ownerDocument.defaultView.MutationObserver(update)
  observer.observe(root, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
    subtree: true,
  })
  update()
  return () => observer.disconnect()
}

function usedFonts(root) {
  const document = root.ownerDocument
  const html = root.querySelector('.katex-html')
  const fonts = new Set()
  if (!html) return fonts

  // Inspect rendered glyphs, not the hidden MathML accessibility copy.
  const walker = document.createTreeWalker(html, 4 /* NodeFilter.SHOW_TEXT */)
  while (walker.nextNode()) {
    const text = walker.currentNode
    if (!text.data.trim()) continue
    const style = document.defaultView.getComputedStyle(text.parentElement)
    const families = style.fontFamily.split(',').map((family) => family.trim().replace(/['"]/g, ''))
    const family = families.find((name) => fontFiles.some((font) => font.family === name))
    const faces = fontFiles.filter((font) => font.family === family)
    if (!faces.length) continue

    const requestedStyle = /italic|oblique/.test(style.fontStyle) ? 'italic' : 'normal'
    const styledFaces = faces.filter((font) => font.style === requestedStyle)
    const candidates = styledFaces.length ? styledFaces : faces
    const weight = Number(style.fontWeight) > 500 || style.fontWeight === 'bold' ? '700' : '400'
    fonts.add(candidates.find((font) => font.weight === weight) || candidates[0])
  }
  return fonts
}

async function loadFont(font, document) {
  // Retry a transient failure once, even if the mounted formula does not change.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(Browser.runtime.getURL(`katex-fonts/${font.filename}.woff2`))
      if (!response.ok) throw new Error(`Failed to fetch ${font.filename}: ${response.status}`)
      // Binary sources avoid the host page's font-src restriction.
      const face = new FontFace(font.family, await response.arrayBuffer(), {
        style: font.style,
        weight: font.weight,
      })
      await face.load()
      document.fonts.add(face)
      return
    } catch (error) {
      if (attempt === 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/** Load only faces used by a rendered KaTeX subtree; cache each face independently. */
export function loadKatexFonts(root) {
  if (!root) return Promise.resolve()
  const document = root.ownerDocument
  if (document.location.origin === new URL(Browser.runtime.getURL('/')).origin) {
    if (!document.getElementById('chatgptbox-katex-fonts')) {
      const stylesheet = document.createElement('link')
      stylesheet.id = 'chatgptbox-katex-fonts'
      stylesheet.rel = 'stylesheet'
      stylesheet.href = Browser.runtime.getURL('katex-fonts.css')
      document.head.appendChild(stylesheet)
    }
    return Promise.resolve()
  }

  let cache = fontLoads.get(document)
  if (!cache) {
    cache = new Map()
    fontLoads.set(document, cache)
  }
  return Promise.all(
    [...usedFonts(root)].map((font) => {
      if (!cache.has(font.filename)) {
        const loading = loadFont(font, document).catch((error) => {
          cache.delete(font.filename)
          console.warn('[markdown] Failed to load KaTeX font', error)
        })
        cache.set(font.filename, loading)
      }
      return cache.get(font.filename)
    }),
  )
}
