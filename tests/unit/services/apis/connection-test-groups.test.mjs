import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canTestConnectionSession } from '../../../../src/services/apis/connection-test-groups.mjs'

test('OpenAI-compatible API modes can be probed', () => {
  for (const groupName of [
    'chatgptApiModelKeys',
    'gptApiModelKeys',
    'deepSeekApiModelKeys',
    'customApiModelKeys',
    'ollamaApiModelKeys',
  ]) {
    assert.equal(canTestConnectionSession({ apiMode: { groupName } }), true, groupName)
  }
})

test('Azure and Anthropic modes are probed through their own protocol', () => {
  assert.equal(
    canTestConnectionSession({ apiMode: { groupName: 'azureOpenAiApiModelKeys' } }),
    true,
  )
  assert.equal(canTestConnectionSession({ apiMode: { groupName: 'claudeApiModelKeys' } }), true)
})

test('cookie and third-party modes cannot be probed', () => {
  for (const groupName of [
    'chatgptWebModelKeys',
    'claudeWebModelKeys',
    'moonshotWebModelKeys',
    'bingWebModelKeys',
    'bardWebModelKeys',
    'githubThirdPartyApiModelKeys',
  ]) {
    assert.equal(canTestConnectionSession({ apiMode: { groupName } }), false, groupName)
  }
})

test('the custom model on the General tab can be probed', () => {
  assert.equal(canTestConnectionSession({ modelName: 'customModel' }), true)
  assert.equal(canTestConnectionSession({ modelName: 'chatgptFree35' }), false)
  assert.equal(canTestConnectionSession({}), false)
})
