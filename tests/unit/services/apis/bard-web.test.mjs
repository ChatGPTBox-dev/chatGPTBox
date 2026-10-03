import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithBardWebApi } from '../../../../src/services/apis/bard-web.mjs'
import Bard from '../../../../src/services/clients/bard/index.mjs'
import { createFakePort } from '../../helpers/port.mjs'

test('generateAnswersWithBardWebApi ignores a superseded response', async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => {
    resolveResponse = resolve
  })
  t.mock.method(Bard.prototype, 'ask', () => response)

  const session = { conversationRecords: [] }
  const port = createFakePort()
  let isLatest = true
  const generation = generateAnswersWithBardWebApi(
    port,
    'CurrentQ',
    session,
    'cookie',
    () => isLatest,
  )

  isLatest = false
  resolveResponse({ answer: 'Stale answer', conversationObj: { id: 'stale' } })
  await generation

  assert.deepEqual(session, { conversationRecords: [] })
  assert.deepEqual(port.postedMessages, [])
})
