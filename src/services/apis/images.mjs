import {
  resolveEndpointTypeForSession,
  resolveOpenAICompatibleRequest,
} from './provider-registry.mjs'

import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_SESSION_IMAGE_BYTES,
} from '../../utils/image-limits.mjs'
export { MAX_IMAGE_COUNT, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES }
const SUPPORTED_IMAGE_MIME_TYPES = new Set(IMAGE_MIME_TYPES)
const IMAGE_DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i
const MAX_IMAGE_DATA_URL_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 128

function matchesBytes(binary, offset, expected) {
  return expected.every((byte, index) => binary.charCodeAt(offset + index) === byte)
}

function hasImageSignature(binary, mimeType) {
  switch (mimeType) {
    case 'image/png':
      return matchesBytes(binary, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg':
      return matchesBytes(binary, 0, [0xff, 0xd8, 0xff])
    case 'image/gif':
      return binary.startsWith('GIF87a') || binary.startsWith('GIF89a')
    case 'image/webp':
      return binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP'
    default:
      return false
  }
}

export class ImageValidationError extends Error {
  constructor(message, code = 'INVALID_IMAGE') {
    super(message)
    this.name = 'ImageValidationError'
    this.code = code
  }
}

function getImageDataUrlBytes(dataUrl, index) {
  if (typeof dataUrl !== 'string') {
    throw new ImageValidationError(
      `Image ${index + 1} must be a base64 data URL.`,
      'INVALID_IMAGE_DATA',
    )
  }

  if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw new ImageValidationError(
      `Image ${index + 1} exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB image limit.`,
      'IMAGE_SIZE_EXCEEDED',
    )
  }

  const match = dataUrl.match(IMAGE_DATA_URL_RE)
  if (!match) {
    throw new ImageValidationError(
      `Image ${index + 1} must be a PNG, JPEG, WebP, or GIF base64 data URL.`,
      'INVALID_IMAGE_DATA',
    )
  }

  const mimeType = match[1].toLowerCase()
  const payload = match[2]
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || payload.length === 0) {
    throw new ImageValidationError(
      `Image ${index + 1} must be a PNG, JPEG, WebP, or GIF base64 data URL.`,
      'INVALID_IMAGE_DATA',
    )
  }

  const paddingStart = payload.indexOf('=')
  const unpaddedLength = paddingStart === -1 ? payload.length : paddingStart
  const paddingLength = payload.length - unpaddedLength
  const remainder = unpaddedLength % 4

  // Accept both padded and unpadded base64, but reject malformed padding and
  // the impossible one-character remainder.
  if (
    remainder === 1 ||
    paddingLength > 2 ||
    (paddingStart !== -1 && !/^=+$/.test(payload.slice(paddingStart))) ||
    (paddingLength > 0 && payload.length % 4 !== 0) ||
    (paddingLength === 1 && remainder !== 3) ||
    (paddingLength === 2 && remainder !== 2)
  ) {
    throw new ImageValidationError(
      `Image ${index + 1} contains invalid base64 data.`,
      'INVALID_IMAGE_DATA',
    )
  }

  let binary
  try {
    binary = globalThis.atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '='))
  } catch {
    throw new ImageValidationError(
      `Image ${index + 1} contains invalid base64 data.`,
      'INVALID_IMAGE_DATA',
    )
  }

  const bytes = binary.length
  if (bytes === 0) {
    throw new ImageValidationError(
      `Image ${index + 1} must contain image data.`,
      'INVALID_IMAGE_DATA',
    )
  }
  if (bytes > MAX_IMAGE_BYTES) {
    throw new ImageValidationError(
      `Image ${index + 1} exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB image limit.`,
      'IMAGE_SIZE_EXCEEDED',
    )
  }
  if (!hasImageSignature(binary, mimeType)) {
    throw new ImageValidationError(
      `Image ${index + 1} content does not match its declared ${mimeType} type.`,
      'INVALID_IMAGE_DATA',
    )
  }

  return { dataUrl, bytes }
}

function validateImageBatch(images) {
  if (images === undefined || images === null) return []
  if (!Array.isArray(images)) {
    throw new ImageValidationError('Image attachments must be an array.', 'INVALID_IMAGE_LIST')
  }
  if (images.length > MAX_IMAGE_COUNT) {
    throw new ImageValidationError(
      `A message can include at most ${MAX_IMAGE_COUNT} images.`,
      'IMAGE_COUNT_EXCEEDED',
    )
  }

  const validated = images.map((dataUrl, index) => getImageDataUrlBytes(dataUrl, index))
  const totalBytes = validated.reduce((sum, image) => sum + image.bytes, 0)
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new ImageValidationError(
      `Images in one message exceed the ${MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)} MiB total limit.`,
      'IMAGE_TOTAL_SIZE_EXCEEDED',
    )
  }
  return validated
}

export function validateImageDataUrls(images) {
  return validateImageBatch(images).map(({ dataUrl }) => dataUrl)
}

/**
 * Validate image attachments in the current message and conversation history.
 * The four-image limit applies to each user turn. The total byte limit applies
 * to the whole session, with repeated data URLs counted once.
 */
export function validateSessionImages(session) {
  const current = validateImageBatch(session?.images)
  const records = Array.isArray(session?.conversationRecords) ? session.conversationRecords : []
  const seen = new Set()

  const batches = [current]
  for (const [index, record] of records.entries()) {
    try {
      batches.push(validateImageBatch(record?.images))
    } catch (error) {
      if (error instanceof ImageValidationError) {
        throw new ImageValidationError(
          `Conversation image ${index + 1}: ${error.message}`,
          error.code,
        )
      }
      throw error
    }
  }

  let totalBytes = 0
  let uniqueTotalBytes = 0
  for (const batch of batches) {
    for (const image of batch) {
      totalBytes += image.bytes
      if (totalBytes > MAX_SESSION_IMAGE_BYTES) {
        throw new ImageValidationError(
          `Conversation images exceed the ${
            MAX_SESSION_IMAGE_BYTES / (1024 * 1024)
          } MiB session limit.`,
          'IMAGE_SESSION_SIZE_EXCEEDED',
        )
      }
      if (seen.has(image.dataUrl)) continue
      seen.add(image.dataUrl)
      uniqueTotalBytes += image.bytes
      if (uniqueTotalBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new ImageValidationError(
          `Conversation images exceed the ${
            MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)
          } MiB unique image limit.`,
          'IMAGE_TOTAL_SIZE_EXCEEDED',
        )
      }
    }
  }

  return {
    images: current.map(({ dataUrl }) => dataUrl),
    totalBytes,
    uniqueTotalBytes,
    hasImages: seen.size > 0,
  }
}

export function isNativeOllamaChatEndpoint(requestUrl) {
  if (!requestUrl) return false
  try {
    const pathname = new URL(requestUrl).pathname.replace(/\/+$/, '') || '/'
    return /(^|\/)api\/chat$/i.test(pathname)
  } catch {
    return false
  }
}

/**
 * Return whether a session can send standard OpenAI chat image content.
 * Provider/model vision support is ultimately decided by the provider; this
 * helper only enables the feature for resolved OpenAI-compatible chat routes.
 */
export function canSendImages(config, session) {
  if (!session || resolveEndpointTypeForSession(session) !== 'chat') return false

  try {
    const request = resolveOpenAICompatibleRequest(
      config && typeof config === 'object' ? config : {},
      session,
    )
    return Boolean(
      request && request.endpointType === 'chat' && !isNativeOllamaChatEndpoint(request.requestUrl),
    )
  } catch {
    return false
  }
}

export function buildOpenAIMessageContent(text, images = []) {
  if (!Array.isArray(images) || images.length === 0) return text

  const content = []
  if (typeof text === 'string' && text.length > 0) content.push({ type: 'text', text })
  content.push(
    ...images.map((dataUrl) => ({
      type: 'image_url',
      image_url: { url: dataUrl },
    })),
  )
  return content
}

export const IMAGE_UNSUPPORTED_ERROR =
  'Image attachments require an OpenAI-compatible chat endpoint that supports image content.'
