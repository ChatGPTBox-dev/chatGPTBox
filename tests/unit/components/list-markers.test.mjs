import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { normalizeListStarts } from '../../../src/components/MarkdownRender/list-markers.mjs'

function createContainer(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  return dom.window.document.getElementById('root')
}

test('a list the renderer marked as starting at 0 is numbered from 1 again', () => {
  const container = createContainer('<ol start="0"><li>Alpha</li><li>Beta</li></ol>')

  assert.equal(normalizeListStarts(container), 1)
  assert.equal(container.querySelector('ol').hasAttribute('start'), false)
})

test('a list that really resumes at another number keeps its start', () => {
  const container = createContainer('<ol start="3"><li>Gamma</li><li>Delta</li></ol>')

  assert.equal(normalizeListStarts(container), 0)
  assert.equal(container.querySelector('ol').getAttribute('start'), '3')
})

test('nested lists are corrected too and a missing container is tolerated', () => {
  const container = createContainer(
    '<ol start="0"><li>Alpha<ul><li>nested</li></ul></li></ol><ol start="0"><li>Beta</li></ol>',
  )

  assert.equal(normalizeListStarts(container), 2)
  assert.equal(container.querySelectorAll('ol[start]').length, 0)
  assert.equal(normalizeListStarts(null), 0)
})
