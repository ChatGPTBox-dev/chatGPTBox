import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateAnswersWithOpenAICompatible } from '../../../../src/services/apis/openai-compatible-core.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const CONFIG = {
  maxConversationContextLength: 9,
  maxResponseTokenLength: 1000,
  temperatureOverrideEnabled: false,
  temperature: 1,
}

async function run(t, chunks) {
  t.mock.method(console, 'debug', () => {})
  t.mock.method(globalThis, 'fetch', async () => createMockSseResponse(chunks))
  const port = createFakePort()
  const session = { conversationRecords: [] }
  await generateAnswersWithOpenAICompatible({
    port,
    question: 'hi',
    session,
    endpointType: 'chat',
    requestUrl: 'https://example.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    apiKey: 'key',
    provider: 'openai',
    config: CONFIG,
  })
  return { port, session }
}

test('reasoning_content is streamed to the card', async (t) => {
  const { port } = await run(t, [
    'data: {"choices":[{"delta":{"reasoning_content":"weighing "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"options"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"The answer."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const reasoningUpdates = port.postedMessages.filter((message) => message.reasoning)
  assert.deepEqual(
    reasoningUpdates.map((message) => message.reasoning),
    ['weighing ', 'weighing options'],
  )
})

test('reasoning stays out of what is sent back as context', async (t) => {
  const { session } = await run(t, [
    'data: {"choices":[{"delta":{"reasoning_content":"secret thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"The answer."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.equal(session.conversationRecords.length, 1)
  assert.equal(session.conversationRecords[0].answer, 'The answer.')
})

test('an answer with no reasoning behaves as before', async (t) => {
  const { port, session } = await run(t, [
    'data: {"choices":[{"delta":{"content":"Plain"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.equal(port.postedMessages.filter((message) => message.reasoning).length, 0)
  assert.equal(session.conversationRecords[0].answer, 'Plain')
})

test('reasoning-only chunks do not repost the unchanged answer', async (t) => {
  const { port } = await run(t, [
    'data: {"choices":[{"delta":{"content":"The answer."}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"more thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const answerUpdates = port.postedMessages.filter((message) => message.answer)
  assert.deepEqual(
    answerUpdates.map((message) => message.answer),
    ['The answer.'],
  )
})

test('thinking written inside the answer is moved to the reasoning channel', async (t) => {
  const { port, session } = await run(t, [
    'data: {"choices":[{"delta":{"content":"<think>weighing "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"options</think>\\n\\nThe answer."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const reasoningUpdates = port.postedMessages
    .filter((message) => message.reasoning)
    .map((message) => message.reasoning)
  assert.deepEqual(reasoningUpdates, ['weighing ', 'weighing options'])

  const answerUpdates = port.postedMessages
    .filter((message) => message.answer !== undefined && message.answer !== null)
    .map((message) => message.answer)
  // Nothing is posted for the answer while the thinking is still streaming.
  assert.deepEqual(answerUpdates, ['The answer.'])

  assert.equal(session.conversationRecords[0].answer, 'The answer.')
})

test('thinking that never closes is not recorded as an answer', async (t) => {
  const { port, session } = await run(t, [
    'data: {"choices":[{"delta":{"content":"<think>cut off while thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  // The block never closed, so the turn has no answer: recording the thinking would send
  // the model its own unfinished reasoning back as context.
  assert.equal(session.conversationRecords.length, 0)
  assert.equal(
    port.postedMessages.some(
      (message) => typeof message.answer === 'string' && message.answer.includes('cut off'),
    ),
    false,
  )
  assert.deepEqual(
    port.postedMessages.filter((message) => message.reasoning).map((message) => message.reasoning),
    ['cut off while thinking'],
  )
})

test('thinking split off the answer is combined with an explicit reasoning field', async (t) => {
  const { port, session } = await run(t, [
    'data: {"choices":[{"delta":{"reasoning_content":"from the field"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<think>in the answer</think>\\n\\nThe answer."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const lastReasoning = port.postedMessages.filter((message) => message.reasoning).at(-1)
  assert.equal(lastReasoning.reasoning, 'from the field\n\nin the answer')
  assert.equal(session.conversationRecords[0].answer, 'The answer.')
})

test('a partial inline tag is cleared once the tag resolves', async (t) => {
  const { port, session } = await run(t, [
    'data: {"choices":[{"delta":{"content":"<think"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":">"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"thinking</think>\\n\\nThe answer."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  const answers = port.postedMessages
    .filter((message) => typeof message.answer === 'string')
    .map((message) => message.answer)
  // The partial tag is posted first, then cleared once it turns out to be thinking, so the
  // card never keeps the stale fragment as its answer.
  assert.deepEqual(answers, ['<think', '', 'The answer.'])
  assert.equal(session.conversationRecords[0].answer, 'The answer.')
})
