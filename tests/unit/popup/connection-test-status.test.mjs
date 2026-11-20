import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getConnectionTestButtonStyle,
  getConnectionTestLabel,
  getConnectionTestTitle,
} from '../../../src/popup/sections/connection-test-status.mjs'

const t = (key) => key

test('an untested mode leaves the button unstyled', () => {
  assert.equal(getConnectionTestButtonStyle(undefined), undefined)
  assert.equal(getConnectionTestTitle(undefined, t), '')
  assert.equal(getConnectionTestLabel(undefined, t), 'Test')
})

test('the button colour carries the result', () => {
  assert.equal(getConnectionTestButtonStyle({ pending: true }).borderColor, '#9a6700')
  assert.equal(getConnectionTestButtonStyle({ ok: true }).borderColor, '#2da44e')
  assert.equal(getConnectionTestButtonStyle({ ok: false }).borderColor, '#d1242f')
})

test('a mode with no request shape stays neutral instead of reading as a failure', () => {
  const unsupported = { ok: false, unsupported: true, error: 'unsupported-provider' }

  assert.equal(getConnectionTestButtonStyle(unsupported).borderColor, '#57606a')
  assert.equal(getConnectionTestLabel(unsupported, t), 'Not testable')
  assert.equal(getConnectionTestTitle(unsupported, t), 'Not testable')
})

test('the result detail only lives in the tooltip', () => {
  assert.equal(getConnectionTestTitle({ pending: true }, t), 'Testing...')
  assert.equal(getConnectionTestTitle({ ok: true, elapsedMs: 42 }, t), 'Reachable 42ms')
  assert.equal(getConnectionTestTitle({ ok: false, error: 'boom' }, t), 'Unreachable: boom')
  assert.equal(getConnectionTestTitle({ ok: false }, t), 'Unreachable')
})

test('the button label carries the result', () => {
  assert.equal(getConnectionTestLabel({ pending: true }, t), 'Testing...')
  assert.equal(getConnectionTestLabel({ ok: true, elapsedMs: 42 }, t), 'Reachable 42ms')
  assert.equal(getConnectionTestLabel({ ok: false, error: 'boom' }, t), 'Unreachable')
})
