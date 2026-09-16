import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import { highlightOptions } from '../../../src/components/MarkdownRender/highlight-options.mjs'

async function renderCodeNodes(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeHighlight, highlightOptions)

  const tree = await processor.run(processor.parse(markdown))
  const nodes = []
  const walk = (node) => {
    if (node.type === 'element' && node.tagName === 'code') nodes.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return nodes
}

function classNames(node) {
  return node.properties?.className ?? []
}

test('auto-detection still labels blocks from the configured subset', async () => {
  const [code] = await renderCodeNodes('```\nconst value = computeSomething(alpha, beta)\n```\n')

  const detected = classNames(code).find((name) => name.startsWith('language-'))
  assert.ok(
    detected && highlightOptions.subset.includes(detected.replace('language-', '')),
    `expected a detection within the subset, got ${classNames(code).join(', ')}`,
  )
  // A failure inside highlightAuto is swallowed by ignoreMissing, so token spans are the
  // evidence that the whole subset resolved.
  assert.ok(
    code.children.some((child) => classNames(child).some((name) => name.startsWith('hljs-'))),
    'expected token spans from auto-detection',
  )
})

test('the subset only narrows detection, not labelled blocks', async () => {
  // `lua` is registered by lowlight but deliberately left out of the detection subset.
  assert.equal(highlightOptions.subset.includes('lua'), false)

  const [code] = await renderCodeNodes('```lua\nlocal value = 1\n```\n')

  assert.ok(
    code.children.some((child) => classNames(child).some((name) => name.startsWith('hljs-'))),
    'expected token spans for a labelled language outside the detection subset',
  )
})

test('an unknown language label is ignored instead of failing the render', async () => {
  const [code] = await renderCodeNodes('```not-a-language\nconst value = 1\n```\n')

  assert.equal(code.children.length, 1)
  assert.equal(code.children[0].type, 'text')
})
