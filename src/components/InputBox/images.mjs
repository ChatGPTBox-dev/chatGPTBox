export const IMAGE_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export const IMAGE_ACCEPT = IMAGE_MIME_TYPES.join(',')
export const MAX_IMAGE_COUNT = 4
export const MAX_IMAGE_SIZE = 4 * 1024 * 1024
export const MAX_TOTAL_IMAGE_SIZE = 12 * 1024 * 1024

export const IMAGE_FILE_ERROR = Object.freeze({
  INVALID: 'invalid',
  TYPE: 'type',
  FILE_SIZE: 'file-size',
  COUNT: 'count',
  TOTAL_SIZE: 'total-size',
})

export function hasDraggedFiles(dataTransfer) {
  if (Array.from(dataTransfer?.files ?? []).length > 0) return true
  return Array.from(dataTransfer?.types ?? []).includes('Files')
}

export function getDroppedFiles(dataTransfer) {
  return Array.from(dataTransfer?.files ?? [])
}

function getFileSize(file) {
  return typeof file?.size === 'number' && Number.isFinite(file.size) && file.size >= 0
    ? file.size
    : null
}

export function validateImageFile(file) {
  if (!file || typeof file !== 'object') {
    return { valid: false, reason: IMAGE_FILE_ERROR.INVALID }
  }

  const type = typeof file.type === 'string' ? file.type.toLowerCase() : ''
  const size = getFileSize(file)
  if (size === null) return { valid: false, reason: IMAGE_FILE_ERROR.INVALID }
  if (size === 0) return { valid: false, reason: IMAGE_FILE_ERROR.INVALID }
  if (!IMAGE_MIME_TYPES.includes(type)) return { valid: false, reason: IMAGE_FILE_ERROR.TYPE }
  if (size > MAX_IMAGE_SIZE) return { valid: false, reason: IMAGE_FILE_ERROR.FILE_SIZE }

  return { valid: true, type, size }
}

function getExistingImageSize(files) {
  return Array.from(files ?? []).reduce((total, file) => total + (getFileSize(file) ?? 0), 0)
}

/**
 * Select valid image files while enforcing the per-file, count, and total byte limits.
 * The returned rejected entries retain their original file and a stable reason code so
 * callers can present a localized message without exposing browser-specific errors.
 */
export function validateImageFiles(files, existingFiles = []) {
  const accepted = []
  const rejected = []
  let totalSize = getExistingImageSize(existingFiles)
  const existingCount = Array.from(existingFiles ?? []).length

  for (const file of Array.from(files ?? [])) {
    if (existingCount + accepted.length >= MAX_IMAGE_COUNT) {
      rejected.push({ file, reason: IMAGE_FILE_ERROR.COUNT })
      continue
    }

    const validation = validateImageFile(file)
    if (!validation.valid) {
      rejected.push({ file, reason: validation.reason })
      continue
    }

    if (totalSize + validation.size > MAX_TOTAL_IMAGE_SIZE) {
      rejected.push({ file, reason: IMAGE_FILE_ERROR.TOTAL_SIZE })
      continue
    }

    accepted.push(file)
    totalSize += validation.size
  }

  return { accepted, rejected, totalSize }
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }

  if (typeof btoa === 'function') return btoa(binary)
  if (typeof globalThis.Buffer !== 'undefined')
    return globalThis.Buffer.from(bytes).toString('base64')
  throw new Error('No base64 encoder is available')
}

/** Read a validated image file as a data URL for transport and previews. */
export function readImageAsDataUrl(file) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result)
        else reject(new Error('Image reader returned an invalid result'))
      }
      reader.onerror = () => reject(reader.error || new Error('Unable to read image'))
      reader.onabort = () => reject(new Error('Image read was aborted'))
      reader.readAsDataURL(file)
    })
  }

  if (typeof file?.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buffer) => {
      const type =
        typeof file.type === 'string' && file.type ? file.type : 'application/octet-stream'
      return `data:${type};base64,${bytesToBase64(new Uint8Array(buffer))}`
    })
  }

  return Promise.reject(new Error('Unable to read image'))
}
