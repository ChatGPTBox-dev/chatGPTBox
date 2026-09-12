import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  IMAGE_FILE_ERROR,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_SIZE,
  MAX_TOTAL_IMAGE_SIZE,
  readImageAsDataUrl,
  validateImageFile,
  validateImageFiles,
} from '../../../src/components/InputBox/images.mjs'

const image = (size = 1, type = 'image/png') => ({ size, type })

describe('input image validation', () => {
  test('accepts supported non-empty images and rejects unsupported types or empty files', () => {
    assert.equal(validateImageFile(image()).valid, true)
    assert.deepEqual(validateImageFile(image(0)), {
      valid: false,
      reason: IMAGE_FILE_ERROR.INVALID,
    })
    assert.deepEqual(validateImageFile(image(1, 'image/svg+xml')), {
      valid: false,
      reason: IMAGE_FILE_ERROR.TYPE,
    })
  })

  test('enforces per-file, count, and cumulative byte limits', () => {
    assert.equal(validateImageFile(image(MAX_IMAGE_SIZE)).valid, true)
    assert.equal(validateImageFile(image(MAX_IMAGE_SIZE + 1)).reason, IMAGE_FILE_ERROR.FILE_SIZE)

    const tooMany = validateImageFiles(Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => image()))
    assert.equal(tooMany.accepted.length, MAX_IMAGE_COUNT)
    assert.equal(tooMany.rejected.at(-1).reason, IMAGE_FILE_ERROR.COUNT)

    const overTotal = validateImageFiles([image(2)], [image(MAX_TOTAL_IMAGE_SIZE - 1)])
    assert.equal(overTotal.accepted.length, 0)
    assert.equal(overTotal.rejected[0].reason, IMAGE_FILE_ERROR.TOTAL_SIZE)
  })
})

test('reads an image as a typed data URL when FileReader is unavailable', async () => {
  const file = new File([new Uint8Array([0, 1, 2])], 'pixel.png', { type: 'image/png' })
  assert.equal(await readImageAsDataUrl(file), 'data:image/png;base64,AAEC')
})
