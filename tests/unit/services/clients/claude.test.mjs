import assert from 'node:assert/strict'
import { test } from 'node:test'
import Claude from '../../../../src/services/clients/claude/index.mjs'

const API_ORG = { uuid: 'api-org', capabilities: ['api', 'customer_terms:standard'] }
const CHAT_ORG = { uuid: 'chat-org', capabilities: ['chat', 'claude_pro'] }

function createClient(routes) {
  const requests = []
  const fetch = async (url) => {
    requests.push(url)
    const path = new URL(url).pathname
    if (!(path in routes)) throw new Error('unexpected request ' + path)
    return new Response(JSON.stringify(routes[path]))
  }
  return { client: new Claude({ sessionKey: 'sk-ant-sid02-test', fetch }), requests }
}

test('Claude init prefers the organization with chat capability', async () => {
  const { client, requests } = createClient({
    '/api/organizations': [API_ORG, CHAT_ORG],
    '/api/organizations/chat-org/chat_conversations': [{ uuid: 'c1', name: 'First' }],
  })

  await client.init()

  assert.equal(client.organizationId, 'chat-org')
  assert.deepEqual(
    client.recent_conversations.map((c) => c.conversationId),
    ['c1'],
  )
  assert.ok(requests.every((url) => !url.includes('api-org')))
})

test('Claude init falls back to the first organization when none has chat capability', async () => {
  const { client } = createClient({
    '/api/organizations': [{ uuid: 'first-org' }, { uuid: 'second-org', capabilities: ['api'] }],
    '/api/organizations/first-org/chat_conversations': [],
  })

  await client.init()

  assert.equal(client.organizationId, 'first-org')
})

test('Claude init reports the claude.ai error when conversations are denied', async () => {
  const { client } = createClient({
    '/api/organizations': [API_ORG],
    '/api/organizations/api-org/chat_conversations': {
      type: 'error',
      error: { type: 'permission_error', message: 'Permission denied.' },
    },
  })

  await assert.rejects(client.init(), { message: 'Permission denied.' })
})
