import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getOpenRouterAttributionHeaders,
  isNativeOllamaChatRequestUrl,
  resolveProviderRequestShapingId,
} from '../../../src/services/apis/openai-compatible-request-helpers.mjs'
import {
  hasCrossContextSessionLock,
  isConversationTitleApiModeSupported,
  isConversationTitleModelAvailable,
  isSecureConversationTitleRequestUrl,
  resolveConversationTitleModelRequest,
} from '../../../src/services/conversation-title-model.mjs'
import {
  buildConversationTitleMessages,
  formatSessionTimestamp,
  generateConversationTitle,
  getSessionDisplayName,
  sanitizeGeneratedSessionTitle,
  truncateSessionTitle,
} from '../../../src/services/session-title.mjs'

function getApiMode(
  itemName = 'chatgptApi4oMini',
  groupName = 'chatgptApiModelKeys',
) {
  return {
    groupName,
    itemName,
    isCustom: false,
    customName: '',
    customUrl: '',
    apiKey: '',
    providerId: '',
    active: true,
  }
}

function getConfig(
  itemName = 'chatgptApi4oMini',
  groupName = 'chatgptApiModelKeys',
) {
  const conversationTitleApiMode = getApiMode(itemName, groupName)
  return {
    conversationTitleApiMode,
    activeApiModes: [itemName],
    customApiModes: [],
    customOpenAIProviders: [],
    providerSecrets: { openai: 'test-key' },
    customOpenAiApiUrl: 'https://api.openai.com',
    customModelApiUrl: 'http://localhost:8000/v1/chat/completions',
    ollamaEndpoint: 'http://127.0.0.1:11434',
  }
}

const availableLocks = { request() {} }
const openAIRequest = {
  providerId: 'openai',
  secretProviderId: 'openai',
  endpointType: 'chat',
  requestUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'test-key',
  provider: { allowLegacyResponseField: false },
}

test('sanitizes title labels, Markdown, and reasoning blocks', () => {
  assert.equal(
    sanitizeGeneratedSessionTitle('<think>hidden</think>\n標題：「ChatGPTBox 標題模型」'),
    'ChatGPTBox 標題模型',
  )
  assert.equal(
    sanitizeGeneratedSessionTitle('<thinking>hidden</thinking>\nTitle: Useful title'),
    'Useful title',
  )
  assert.equal(
    sanitizeGeneratedSessionTitle('```text\n## Review pull request?\n```'),
    'Review pull request',
  )
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

test('very large prompts are reduced to a bounded head and tail context', () => {
  const question = `START:${'x'.repeat(1_000_000)}:ACTUAL TASK AT END`
  const messages = buildConversationTitleMessages(question, 'Answer')
  const transcriptPrefix = 'Create a title for this JSON transcript:\n'
  const transcript = JSON.parse(messages[1].content.slice(transcriptPrefix.length))

  assert.ok(transcript.user.startsWith('START:'))
  assert.ok(transcript.user.endsWith(':ACTUAL TASK AT END'))
  assert.match(transcript.user, /\n…\n/)
  assert.ok(transcript.user.length <= 6000)
})

test('combining-mark graphemes cannot exceed the hard transcript limit', () => {
  const question = `a${'\u0301'.repeat(100_000)}:ACTUAL TASK AT END`
  const messages = buildConversationTitleMessages(question, 'Answer')
  const transcriptPrefix = 'Create a title for this JSON transcript:\n'
  const transcript = JSON.parse(messages[1].content.slice(transcriptPrefix.length))

  assert.ok(transcript.user.length <= 6000)
  assert.ok(transcript.user.endsWith(':ACTUAL TASK AT END'))
  assert.match(transcript.user, /\n…\n/)
})

test('uses a stable non-localized timestamp fallback', () => {
  const localTimestamp = '2026-08-06T03:09:00'
  assert.equal(formatSessionTimestamp(localTimestamp), '2026-08-06 03:09')
  assert.equal(
    getSessionDisplayName({ sessionName: null, createdAt: localTimestamp }, 'New Chat'),
    'New Chat · 2026-08-06 03:09',
  )
})

test('missing timestamps fall back to the label without showing the Unix epoch', () => {
  assert.equal(formatSessionTimestamp(null), '')
  assert.equal(formatSessionTimestamp(undefined), '')
  assert.equal(formatSessionTimestamp(''), '')
  assert.equal(getSessionDisplayName({ sessionName: null, createdAt: null }, 'New Chat'), 'New Chat')
})

test('requires cross-context locks before enabling a title model', () => {
  assert.equal(hasCrossContextSessionLock(availableLocks), true)
  assert.equal(hasCrossContextSessionLock(null), false)
  assert.equal(
    isConversationTitleModelAvailable(getConfig(), () => openAIRequest, null),
    false,
  )
})

test('checks that the selected title model is enabled and chat-compatible', () => {
  const config = getConfig()
  assert.equal(
    isConversationTitleModelAvailable(config, () => openAIRequest, availableLocks),
    true,
  )
  assert.equal(
    isConversationTitleModelAvailable(
      { ...config, activeApiModes: [] },
      () => openAIRequest,
      availableLocks,
    ),
    false,
  )
  assert.equal(
    isConversationTitleModelAvailable(
      config,
      () => ({ endpointType: 'completion' }),
      availableLocks,
    ),
    false,
  )
  assert.equal(
    isConversationTitleModelAvailable(
      config,
      () => {
        throw new Error('malformed provider')
      },
      availableLocks,
    ),
    false,
  )
})

test('requires TLS except for loopback development endpoints', () => {
  assert.equal(isSecureConversationTitleRequestUrl('https://example.com/v1/chat/completions'), true)
  assert.equal(isSecureConversationTitleRequestUrl('http://localhost:8000/v1/chat/completions'), true)
  assert.equal(isSecureConversationTitleRequestUrl('http://127.0.0.1:11434/v1/chat/completions'), true)
  assert.equal(isSecureConversationTitleRequestUrl('http://[::1]:11434/v1/chat/completions'), true)
  assert.equal(isSecureConversationTitleRequestUrl('http://example.com/v1/chat/completions'), false)

  assert.throws(
    () =>
      resolveConversationTitleModelRequest(getConfig(), undefined, () => ({
        ...openAIRequest,
        requestUrl: 'http://example.com/v1/chat/completions',
      })),
    /must use HTTPS/,
  )
})

test('rejects native Ollama chat endpoints for title generation', () => {
  const requestUrl = 'http://127.0.0.1:11434/api/chat'
  assert.equal(isNativeOllamaChatRequestUrl(requestUrl), true)
  assert.throws(
    () =>
      resolveConversationTitleModelRequest(getConfig(), undefined, () => ({
        ...openAIRequest,
        providerId: 'ollama',
        secretProviderId: 'ollama',
        requestUrl,
      })),
    /Native Ollama chat endpoints/,
  )
})

test('excludes reasoning-heavy models from the title selector', () => {
  const nativeOpenAIConfig = getConfig('chatgptApi5')
  assert.equal(
    isConversationTitleApiModeSupported(
      nativeOpenAIConfig,
      nativeOpenAIConfig.conversationTitleApiMode,
      () => openAIRequest,
    ),
    false,
  )

  const deepSeekConfig = getConfig('deepseek_reasoner', 'deepSeekApiModelKeys')
  assert.equal(
    isConversationTitleApiModeSupported(
      deepSeekConfig,
      deepSeekConfig.conversationTitleApiMode,
      () => ({
        ...openAIRequest,
        providerId: 'deepseek',
        secretProviderId: 'deepseek',
        requestUrl: 'https://api.deepseek.com/chat/completions',
      }),
    ),
    false,
  )

  const openRouterConfig = getConfig('openRouter_openai_o3', 'openRouterApiModelKeys')
  assert.equal(
    isConversationTitleApiModeSupported(
      openRouterConfig,
      openRouterConfig.conversationTitleApiMode,
      () => ({
        ...openAIRequest,
        providerId: 'openrouter',
        secretProviderId: 'openrouter',
        requestUrl: 'https://openrouter.ai/api/v1/chat/completions',
      }),
    ),
    false,
  )
})

test('shares OpenAI request shaping and OpenRouter attribution behavior', () => {
  assert.equal(resolveProviderRequestShapingId({ providerId: 'openai' }), 'openai')
  assert.equal(
    resolveProviderRequestShapingId({
      providerId: 'custom-provider',
      secretProviderId: 'openai',
      requestUrl: 'https://api.openai.com/v1/chat/completions',
    }),
    'openai',
  )
  assert.deepEqual(getOpenRouterAttributionHeaders('https://example.com/v1/chat/completions'), {})
  assert.equal(
    getOpenRouterAttributionHeaders('https://openrouter.ai/api/v1/chat/completions')[
      'X-OpenRouter-Title'
    ],
    'ChatGPTBox',
  )
})

test('sends one non-streaming request through the selected provider', async () => {
  let captured
  const title = await generateConversationTitle({
    config: getConfig(),
    question: '請從長提示詞找出真正任務',
    answer: '真正任務是設計對話標題模型。',
    resolveRequest: () => openAIRequest,
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
      resolveRequest: () => openAIRequest,
    }),
    /no longer enabled/,
  )
})
