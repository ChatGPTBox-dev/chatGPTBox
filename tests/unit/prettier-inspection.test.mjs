import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import prettier from 'prettier'

const paths = [
  'src/services/clients/gemini-web/index.mjs',
  'tests/unit/services/apis/gemini-web-retry.test.mjs',
  'tests/unit/services/apis/gemini-web.test.mjs',
]

function diffLines(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  const lines = []
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      lines.push('+ ' + b[j++])
    } else {
      lines.push('- ' + a[i++])
    }
  }
  return lines
}

test('inspect Prettier formatting before updating the public PR', async () => {
  for (const path of paths) {
    const before = await readFile(path, 'utf8')
    const after = prettier.format(before, {
      parser: 'babel',
      printWidth: 100,
      semi: false,
      tabWidth: 2,
      singleQuote: true,
      trailingComma: 'all',
      bracketSpacing: true,
      filepath: path,
    })
    console.log('FORMAT_DIFF_START', path)
    console.log(diffLines(before, after).join('\n'))
    console.log('FORMAT_DIFF_END', path)
    assert.ok(after.length > 0)
  }
})
