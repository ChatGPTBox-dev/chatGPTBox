import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createListStartNormalizer } from '../../../src/components/MarkdownRender/list-markers.mjs'

function createContainer(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`)
  return dom.window.document.getElementById('root')
}

test('a list that streamed without a start and then grew start="0" is numbered from 1 again', () => {
  const container = createContainer('<ol><li>Alpha</li><li>Beta</li></ol>')
  const normalizer = createListStartNormalizer()

  assert.equal(normalizer.apply(container), 0, 'the streaming list needs nothing yet')

  // This is what the renderer does when the block is finalized.
  container.querySelector('ol').setAttribute('start', '0')

  assert.equal(normalizer.apply(container), 1)
  assert.equal(container.querySelector('ol').hasAttribute('start'), false)
})

test('a list that really begins at 0 keeps its start', () => {
  const container = createContainer('<ol start="0"><li>Zero</li><li>One</li></ol>')
  const normalizer = createListStartNormalizer()

  assert.equal(normalizer.apply(container), 0)
  assert.equal(container.querySelector('ol').getAttribute('start'), '0')
})

test('a list that resumes at another number keeps its start', () => {
  const container = createContainer('<ol start="3"><li>Gamma</li><li>Delta</li></ol>')
  const normalizer = createListStartNormalizer()

  assert.equal(normalizer.apply(container), 0)
  assert.equal(container.querySelector('ol').getAttribute('start'), '3')
})

test('each list is judged on its own, and a missing container is tolerated', () => {
  const container = createContainer(
    '<ol id="plain"><li>Alpha</li></ol><ol id="zero" start="0"><li>Zero</li></ol>',
  )
  const normalizer = createListStartNormalizer()

  normalizer.apply(container)
  container.querySelector('#plain').setAttribute('start', '0')

  assert.equal(normalizer.apply(container), 1)
  assert.equal(container.querySelector('#plain').hasAttribute('start'), false)
  assert.equal(container.querySelector('#zero').getAttribute('start'), '0')
  assert.equal(normalizer.apply(null), 0)
})
