import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import prettier from 'prettier'

test('temporary Prettier diff inspection', async () => {
  const path = 'tests/unit/components/conversation-card-lifecycle.test.mjs'
  const input = await readFile(path, 'utf8')
  const config = JSON.parse(await readFile('.prettierrc', 'utf8'))
  const expected = prettier.format(input, { ...config, filepath: path })
  const left = input.split('\n')
  const right = expected.split('\n')
  const dp = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; --i) {
    for (let j = right.length - 1; j >= 0; --j) {
      dp[i][j] =
        left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const changes = []
  for (let i = 0, j = 0; i < left.length || j < right.length; ) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      i++
      j++
      continue
    }
    if (j < right.length && (i === left.length || dp[i][j + 1] >= dp[i + 1][j])) {
      changes.push({ type: '+', line: j + 1, text: right[j++] })
    } else {
      changes.push({ type: '-', line: i + 1, text: left[i++] })
    }
  }
  console.log('TEMP_PRETTIER_DIFF_START', JSON.stringify(changes))
  console.log('TEMP_PRETTIER_DIFF_END')
  assert.ok(expected.length > 0)
})
