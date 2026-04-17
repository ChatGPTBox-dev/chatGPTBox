import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  redactSensitiveFields,
  isPromptOrSelectionLikeKey,
} from '../../../src/background/redact.mjs'

describe('redactSensitiveFields', () => {
  test('redacts keys containing sensitive keywords', () => {
    const input = {
      apiKey: 'sk-1234',
      accessToken: 'tok-abc',
      secret: 'shh',
      password: 'hunter2',
      credential: 'cred-value',
      jwt: 'eyJ...',
      session: 'sess-xyz',
      kimimoonshotrefreshtoken: 'refresh-val',
    }
    const result = redactSensitiveFields(input)
    for (const key of Object.keys(input)) {
      assert.equal(result[key], 'REDACTED', `expected ${key} to be redacted`)
    }
  })

  test('preserves non-sensitive keys', () => {
    const input = { name: 'Alice', age: 30, enabled: true }
    const result = redactSensitiveFields(input)
    assert.deepEqual(result, { name: 'Alice', age: 30, enabled: true })
  })

  test('handles nested objects', () => {
    const input = {
      user: { name: 'Bob', apiKey: 'sk-nested' },
      count: 5,
    }
    const result = redactSensitiveFields(input)
    assert.equal(result.user.name, 'Bob')
    assert.equal(result.user.apiKey, 'REDACTED')
    assert.equal(result.count, 5)
  })

  test('handles arrays with mixed objects', () => {
    const input = [{ name: 'a', token: 'tok1' }, 'plain-string', 42, { password: 'pw', safe: true }]
    const result = redactSensitiveFields(input)
    assert.ok(Array.isArray(result))
    assert.equal(result[0].name, 'a')
    assert.equal(result[0].token, 'REDACTED')
    assert.equal(result[1], 'plain-string')
    assert.equal(result[2], 42)
    assert.equal(result[3].password, 'REDACTED')
    assert.equal(result[3].safe, true)
  })

  test('respects maxDepth', () => {
    const deep = { a: { b: { c: { d: 'value' } } } }
    const result = redactSensitiveFields(deep, 0, 2)
    assert.equal(result.a.b.c, 'REDACTED_TOO_DEEP')
  })

  test('handles null and primitive inputs', () => {
    assert.equal(redactSensitiveFields(null), null)
    assert.equal(redactSensitiveFields(42), 42)
    assert.equal(redactSensitiveFields('hello'), 'hello')
    assert.equal(redactSensitiveFields(undefined), undefined)
  })

  test('handles circular references', () => {
    const obj = { name: 'root' }
    obj.self = obj
    const result = redactSensitiveFields(obj)
    assert.equal(result.name, 'root')
    assert.equal(result.self, 'REDACTED_CIRCULAR_REFERENCE')
  })

  test('redacts prompt/selection-like keys via isPromptOrSelectionLikeKey integration', () => {
    const input = {
      prompt: 'secret input',
      userQuestion: 'what is X?',
      selection: 'highlighted text',
      name: 'safe',
    }
    const result = redactSensitiveFields(input)
    assert.equal(result.prompt, 'REDACTED')
    assert.equal(result.userQuestion, 'REDACTED')
    assert.equal(result.selection, 'REDACTED')
    assert.equal(result.name, 'safe')
  })
})

describe('isPromptOrSelectionLikeKey', () => {
  test('matches prompt/selection-related keys', () => {
    assert.ok(isPromptOrSelectionLikeKey('question'))
    assert.ok(isPromptOrSelectionLikeKey('prompt'))
    assert.ok(isPromptOrSelectionLikeKey('query'))
    assert.ok(isPromptOrSelectionLikeKey('selection'))
    assert.ok(isPromptOrSelectionLikeKey('selectiontext'))
    assert.ok(isPromptOrSelectionLikeKey('systemprompt'))
    assert.ok(isPromptOrSelectionLikeKey('user_question'))
    assert.ok(isPromptOrSelectionLikeKey('searchquery'))
  })

  test('rejects unrelated keys', () => {
    assert.ok(!isPromptOrSelectionLikeKey('name'))
    assert.ok(!isPromptOrSelectionLikeKey('apikey'))
    assert.ok(!isPromptOrSelectionLikeKey('enabled'))
    assert.ok(!isPromptOrSelectionLikeKey('count'))
    assert.ok(!isPromptOrSelectionLikeKey('model'))
  })
})
