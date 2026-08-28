import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildConversationTitleMessages,
  formatSessionTimestamp,
  generateConversationTitle,
  getSessionDisplayName,
  sanitizeGeneratedSessionTitle,
  truncateSessionTitle,
} from '../../../src/services/session-title.mjs'
import { isConversationTitleModelAvailable } from '../../../src/services/conversation-title-model.mjs'

function getApiMode() {
  return {
    groupName: 'chatgptApiModelKeys',
    itemName: 'chatgptApi4oMini',
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
  }
}

function getConfig() {
  const conversationTitleApiMode = getApiMode()
  return {
    conversationTitleApiMode,
    activeApiModes: ['chatgptApi4oMini'],
    customApiModes: [],
    customOpenAIProviders: [],
    providerSecrets: { openai: 'test-key' },
    customOpenAiApiUrl: 'https://api.openai.com',
    customModelApiUrl: 'http://localhost:8000/v1/chat/completions',
    ollamaEndpoint: 'http://127.0.0.1:11434',
  }
}

test('sanitizes title labels, Markdown, and reasoning blocks', () => {
  assert.equal(
    sanitizeGeneratedSessionTitle('<think>hidden</think>\n標題：「ChatGPTBox 標題模型」'),
    'ChatGPTBox 標題模型',
  )
  assert.equal(sanitizeGeneratedSessionTitle('```text\n## Review pull request?\n```'), 'Review pull request')
  assert.equal(sanitizeGeneratedSessionTitle('<analysis>unfinished reasoning'), '')
})

test('truncates by grapheme without splitting emoji', () => {
  assert.equal(truncateSessionTitle('A👨‍👩‍👧‍👦BCD', 4), 'A👨‍👩‍👧‍👦B…')
})

test('long prompts retain the final task instead of using only the prefix', () => {
  const question = `${'前置規則'.repeat(1500)}\n真正的任務：替 ChatGPTBox 設計次要模型標題功能`
  const messages = buildConversationTitleMessages(question, '回答')
  assert.match(messages[0].content, /actual task or topic/)
  assert.match(messages[1].content, /真正的任務：替 ChatGPTBox 設計次要模型標題功能/)
})

test('uses a stable non-localized timestamp fallback', () => {
  const date = new Date(2026, 7, 6, 3, 9)
  assert.equal(formatSessionTimestamp(date.toISOString()), '2026-08-06 03:09')
  assert.equal(
    getSessionDisplayName({ sessionName: null, createdAt: date.toISOString() }, 'New Chat'),
    'New Chat · 2026-08-06 03:09',
  )
})

test('checks that the selected title model is enabled and chat-compatible', () => {
  const config = getConfig()
  const request = {
    endpointType: 'chat',
    requestUrl: 'https://api.openai.com/v1/chat/completions',
  }
  assert.equal(isConversationTitleModelAvailable(config, () => request), true)
  assert.equal(
    isConversationTitleModelAvailable({ ...config, activeApiModes: [] }, () => request),
    false,
  )
  assert.equal(
    isConversationTitleModelAvailable(config, () => ({ endpointType: 'completion' })),
    false,
  )
})

test('sends one non-streaming request through the selected provider', async () => {
  let captured
  const title = await generateConversationTitle({
    config: getConfig(),
    question: '請從長提示詞找出真正任務',
    answer: '真正任務是設計對話標題模型。',
    resolveRequest: () => ({
      providerId: 'openai',
      secretProviderId: 'openai',
      endpointType: 'chat',
      requestUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      provider: { allowLegacyResponseField: false },
    }),
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: '標題：對話標題模型設計' } }] }),
      }
    },
  })

  assert.equal(title, '對話標題模型設計')
  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.stream, false)
  assert.equal(body.model, 'gpt-4o-mini')
  assert.equal(body.max_tokens, 64)
  assert.equal(body.messages.length, 2)
})

test('rejects missing or disabled title model settings before fetch', async () => {
  await assert.rejects(
    generateConversationTitle({ config: {}, question: 'Q', answer: 'A' }),
    /No conversation title model/,
  )
  await assert.rejects(
    generateConversationTitle({
      config: { ...getConfig(), activeApiModes: [] },
      question: 'Q',
      answer: 'A',
    }),
    /no longer enabled/,
  )
})
