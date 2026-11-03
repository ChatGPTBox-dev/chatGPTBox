import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getExtraBodyParams,
  parseExtraBody,
} from '../../../src/services/apis/extra-body-params.mjs'

test('parseExtraBody accepts a JSON object', () => {
  assert.deepEqual(parseExtraBody('{"thinking":{"type":"enabled","budget_tokens":2048}}'), {
    thinking: { type: 'enabled', budget_tokens: 2048 },
  })
})

test('parseExtraBody rejects anything that is not a JSON object', () => {
  for (const raw of ['', '   ', 'not json', '[1,2]', '"text"', '42', 'null', null, undefined, {}]) {
    assert.equal(parseExtraBody(raw), null, `expected null for ${JSON.stringify(raw)}`)
  }
})

test('getExtraBodyParams is empty without a usable config value', () => {
  assert.deepEqual(getExtraBodyParams(undefined), {})
  assert.deepEqual(getExtraBodyParams({}), {})
  assert.deepEqual(getExtraBodyParams({ extraBody: '{oops' }), {})
})

test('getExtraBodyParams forwards user fields and keeps stream under extension control', () => {
  const config = { extraBody: '{"reasoning_effort":"high","stream":false}' }

  assert.deepEqual(getExtraBodyParams(config), { reasoning_effort: 'high' })
  // The parsed object is rebuilt per call, so repeated reads stay stripped.
  assert.deepEqual(getExtraBodyParams(config), { reasoning_effort: 'high' })
})
