import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initSession } from '../../../src/services/init-session.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('initSession returns object with all required default/null fields', () => {
  const session = initSession()

  assert.equal(session.question, null)
  assert.deepEqual(session.conversationRecords, [])
  assert.equal(session.sessionName, null)
  assert.equal(session.modelName, null)
  assert.equal(session.apiMode, null)
  assert.equal(session.autoClean, false)
  assert.equal(session.isRetry, false)
  assert.equal(session.aiName, null)
})

test('initSession generates a UUID v4 sessionId', () => {
  const session = initSession()
  assert.match(session.sessionId, UUID_RE)
})

test('initSession sets createdAt and updatedAt as ISO timestamps', () => {
  const before = new Date().toISOString()
  const session = initSession()
  const after = new Date().toISOString()

  assert.ok(session.createdAt >= before && session.createdAt <= after)
  assert.ok(session.updatedAt >= before && session.updatedAt <= after)
})

test('initSession generates unique sessionIds', () => {
  const a = initSession()
  const b = initSession()
  assert.notEqual(a.sessionId, b.sessionId)
})

test('initSession resolves aiName from modelName (not null)', () => {
  const session = initSession({ modelName: 'claude2WebFree' })
  assert.equal(session.modelName, 'claude2WebFree')
  // aiName is derived via modelNameToDesc; exact value depends on i18next init
  assert.notEqual(session.aiName, null)
})

test('initSession resolves aiName from apiMode (not null)', () => {
  const apiMode = {
    groupName: 'claude2WebFree',
    itemName: 'claude2WebFree',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    active: true,
  }
  const session = initSession({ apiMode })
  assert.notEqual(session.aiName, null)
})

test('initSession aiName is null when no modelName and no apiMode', () => {
  const session = initSession()
  assert.equal(session.aiName, null)
})

test('initSession passes through provided question and sessionName', () => {
  const session = initSession({ question: 'hello', sessionName: 'My Chat' })
  assert.equal(session.question, 'hello')
  assert.equal(session.sessionName, 'My Chat')
})

test('all provider-specific fields default to null', () => {
  const session = initSession()

  // chatgpt-web
  assert.equal(session.conversationId, null)
  assert.equal(session.messageId, null)
  assert.equal(session.parentMessageId, null)
  assert.equal(session.wsRequestId, null)

  // bing
  assert.equal(session.bingWeb_encryptedConversationSignature, null)
  assert.equal(session.bingWeb_conversationId, null)
  assert.equal(session.bingWeb_clientId, null)
  assert.equal(session.bingWeb_invocationId, null)

  // bing sydney
  assert.equal(session.bingWeb_jailbreakConversationId, null)
  assert.equal(session.bingWeb_parentMessageId, null)
  assert.equal(session.bingWeb_jailbreakConversationCache, null)

  // poe
  assert.equal(session.poe_chatId, null)

  // bard
  assert.equal(session.bard_conversationObj, null)

  // claude.ai
  assert.equal(session.claude_conversation, null)

  // kimi.com
  assert.equal(session.moonshot_conversation, null)
})

test('initSession includes extraCustomModelName in aiName for customModel', () => {
  const session = initSession({
    modelName: 'customModel',
    extraCustomModelName: 'my-special-model',
  })
  assert.ok(session.aiName.includes('my-special-model'))
})
