import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { beforeEach, test } from 'node:test'
import {
  IMAGE_UNSUPPORTED_ERROR,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  canSendImages,
  validateImageDataUrls,
  validateSessionImages,
} from '../../../../src/services/apis/images.mjs'
import {
  generateAnswersWithGptCompletionApi,
  generateAnswersWithOpenAiApiCompat,
} from '../../../../src/services/apis/openai-api.mjs'
import { createFakePort } from '../../helpers/port.mjs'
import { createMockSseResponse } from '../../helpers/sse-response.mjs'

const imageSignatures = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/webp': Buffer.from('RIFF0000WEBP', 'ascii'),
  'image/gif': Buffer.from('GIF89a', 'ascii'),
}

const imageDataUrl = (mime = 'image/png', bytes = 12) => {
  const signature = imageSignatures[mime] ?? Buffer.alloc(0)
  const content = Buffer.alloc(Math.max(bytes, signature.length), 0xab)
  signature.copy(content)
  return `data:${mime};base64,${content.toString('base64')}`
}

const setStorage = (values) => {
  globalThis.__TEST_BROWSER_SHIM__.replaceStorage(values)
}

beforeEach(() => {
  globalThis.__TEST_BROWSER_SHIM__.clearStorage()
})

test('validates supported image data URLs and attachment limits', () => {
  const images = [
    imageDataUrl('image/png'),
    imageDataUrl('image/jpeg'),
    imageDataUrl('image/webp'),
    imageDataUrl('image/gif'),
  ]

  assert.deepEqual(validateImageDataUrls(images), images)
  assert.throws(
    () => validateImageDataUrls([...images, imageDataUrl()]),
    (error) => error.code === 'IMAGE_COUNT_EXCEEDED' && error.message.includes(MAX_IMAGE_COUNT),
  )
  assert.throws(
    () => validateImageDataUrls([imageDataUrl('image/svg+xml')]),
    (error) => error.code === 'INVALID_IMAGE_DATA',
  )
  assert.throws(
    () => validateImageDataUrls(['data:image/png;base64,not base64']),
    (error) => error.code === 'INVALID_IMAGE_DATA',
  )
  assert.throws(
    () => validateImageDataUrls([imageDataUrl('image/jpeg').replace('image/jpeg', 'image/png')]),
    (error) => error.code === 'INVALID_IMAGE_DATA' && error.message.includes('does not match'),
  )
})

test('validates per-image size and cumulative session limits', () => {
  const maxImage = imageDataUrl('image/png', MAX_IMAGE_BYTES)
  assert.equal(validateImageDataUrls([maxImage])[0], maxImage)

  const tooLarge = imageDataUrl('image/png', MAX_IMAGE_BYTES + 1)
  assert.throws(
    () => validateImageDataUrls([tooLarge]),
    (error) => error.code === 'IMAGE_SIZE_EXCEEDED',
  )

  const image = imageDataUrl('image/png', 3 * 1024 * 1024)
  const session = {
    images: [image],
    conversationRecords: Array.from({ length: 8 }, () => ({
      question: 'Q',
      answer: 'A',
      images: [image],
    })),
  }
  assert.throws(
    () => validateSessionImages(session),
    (error) => error.code === 'IMAGE_SESSION_SIZE_EXCEEDED',
  )
})

test('enables images only for resolved OpenAI-compatible chat endpoints', () => {
  const config = { customOpenAiApiUrl: 'https://api.example.com' }
  const chatSession = {
    modelName: 'chatgptApi4oMini',
    apiMode: { groupName: 'chatgptApiModelKeys', itemName: 'gpt-4o-mini' },
  }
  const completionSession = {
    modelName: 'gptApiInstruct',
    apiMode: { groupName: 'gptApiModelKeys', itemName: 'text-davinci-003' },
  }
  const webSession = { modelName: 'chatgptWeb' }

  assert.equal(canSendImages(config, chatSession), true)
  assert.equal(canSendImages(config, completionSession), false)
  assert.equal(canSendImages(config, webSession), false)
  assert.equal(
    canSendImages(
      {
        customOpenAIProviders: [
          {
            id: 'native',
            chatCompletionsUrl: 'http://127.0.0.1:11434/api/chat',
            enabled: true,
          },
        ],
      },
      {
        modelName: 'customModel',
        apiMode: {
          groupName: 'customApiModelKeys',
          itemName: 'customModel',
          isCustom: true,
          customName: 'native-model',
          providerId: 'native',
        },
      },
    ),
    false,
  )
})

test('sends current and history images as standard OpenAI chat content and preserves record images', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
  })

  const previousImage = imageDataUrl('image/jpeg')
  const currentImage = imageDataUrl('image/png')
  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [{ question: 'PrevQ', answer: 'PrevA', images: [previousImage] }],
    images: [currentImage],
    isRetry: false,
  }
  const port = createFakePort()
  let capturedInit
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    capturedInit = init
    return createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    ])
  })

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  const body = JSON.parse(capturedInit.body)
  assert.deepEqual(body.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'PrevQ' },
      { type: 'image_url', image_url: { url: previousImage } },
    ],
  })
  assert.deepEqual(body.messages.at(-1), {
    role: 'user',
    content: [
      { type: 'text', text: 'CurrentQ' },
      { type: 'image_url', image_url: { url: currentImage } },
    ],
  })
  assert.deepEqual(session.conversationRecords.at(-1), {
    question: 'CurrentQ',
    answer: 'OK',
    images: [currentImage],
  })
})

test('rejects image history before registering completion stream listeners', async () => {
  const image = imageDataUrl()
  const session = {
    modelName: 'gptApiInstruct',
    conversationRecords: [{ question: 'OldQ', answer: 'OldA', images: [image] }],
    images: [],
    isRetry: false,
  }
  const port = createFakePort()

  await assert.rejects(
    generateAnswersWithGptCompletionApi(port, 'CurrentQ', session, 'sk-test'),
    (error) => error.message === IMAGE_UNSUPPORTED_ERROR,
  )
  assert.deepEqual(port.listenerCounts(), { onMessage: 0, onDisconnect: 0 })
})

test('updates a retried multimodal record without dropping its images', async (t) => {
  t.mock.method(console, 'debug', () => {})
  setStorage({
    maxConversationContextLength: 3,
    maxResponseTokenLength: 256,
  })
  const image = imageDataUrl()
  const session = {
    modelName: 'chatgptApi4oMini',
    conversationRecords: [{ question: 'CurrentQ', answer: 'Old', images: [image] }],
    images: [image],
    isRetry: true,
  }
  const port = createFakePort()
  t.mock.method(globalThis, 'fetch', async () =>
    createMockSseResponse([
      'data: {"choices":[{"delta":{"content":"New"},"finish_reason":"stop"}]}\n\n',
    ]),
  )

  await generateAnswersWithOpenAiApiCompat(
    'https://api.example.com/v1',
    port,
    'CurrentQ',
    session,
    'sk-test',
  )

  assert.deepEqual(session.conversationRecords, [
    { question: 'CurrentQ', answer: 'New', images: [image] },
  ])
})
