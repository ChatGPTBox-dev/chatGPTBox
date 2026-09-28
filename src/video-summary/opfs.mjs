import { uploadMediaBlob } from '../services/apis/volcengine-mediakit.mjs'

const VIDEO_SUMMARY_TASKS_DIR = 'video-summary-tasks'
const DEFAULT_TASK_FILE_NAME = 'media.bin'
const CLEANUP_RETRY_DELAY_MS = 25

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createQuotaExceededError({ availableBytes, requiredBytes, quotaBytes, usageBytes }) {
  const error = new Error('OPFS_QUOTA_EXCEEDED')
  error.availableBytes = availableBytes
  error.requiredBytes = requiredBytes
  error.quotaBytes = quotaBytes
  error.usageBytes = usageBytes
  return error
}

async function getRootDirectory(rootDirectory) {
  if (rootDirectory) return rootDirectory

  const getDirectory = globalThis.navigator?.storage?.getDirectory?.bind(
    globalThis.navigator?.storage,
  )
  if (typeof getDirectory !== 'function') {
    throw new Error('OPFS_UNAVAILABLE')
  }

  return getDirectory()
}

async function getTasksDirectory(rootDirectory, create) {
  return rootDirectory.getDirectoryHandle(VIDEO_SUMMARY_TASKS_DIR, { create })
}

async function writeResponseBodyToFile({ response, writable, signal, onProgress }) {
  const reader = response.body.getReader()
  let bytesWritten = 0
  const totalBytes = Number.parseInt(response.headers.get('content-length') || '', 10) || null
  let done = false

  try {
    while (!done) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
      const chunk = await reader.read()
      done = chunk.done
      if (done) break
      const { value } = chunk
      await writable.write(value)
      bytesWritten += value.byteLength
      onProgress?.({
        bytesWritten,
        totalBytes: totalBytes ?? bytesWritten,
      })
    }
    await writable.close()
  } catch (error) {
    await writable.abort?.().catch?.(() => {})
    throw error
  }

  return {
    bytesWritten,
    totalBytes: totalBytes ?? bytesWritten,
    contentLength: totalBytes,
    contentType: response.headers.get('content-type') || '',
  }
}

export function createTaskOpfsStore({
  rootDirectory,
  taskId,
  fetchImpl = fetch,
  estimateStorage = globalThis.navigator?.storage?.estimate?.bind(globalThis.navigator?.storage),
  wait = waitFor,
  taskFileName = DEFAULT_TASK_FILE_NAME,
} = {}) {
  async function ensureQuota({ requiredBytes } = {}) {
    const normalizedRequiredBytes =
      Number.isFinite(requiredBytes) && requiredBytes > 0 ? requiredBytes : 0

    if (!normalizedRequiredBytes || typeof estimateStorage !== 'function') {
      return {
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
      }
    }

    const estimate = await estimateStorage()
    const quotaBytes = Number.isFinite(estimate?.quota) ? estimate.quota : null
    const usageBytes = Number.isFinite(estimate?.usage) ? estimate.usage : null
    const availableBytes =
      quotaBytes !== null && usageBytes !== null ? Math.max(0, quotaBytes - usageBytes) : null

    if (availableBytes !== null && availableBytes < normalizedRequiredBytes) {
      throw createQuotaExceededError({
        availableBytes,
        requiredBytes: normalizedRequiredBytes,
        quotaBytes,
        usageBytes,
      })
    }

    return { quotaBytes, usageBytes, availableBytes }
  }

  async function downloadCandidate({ candidate, signal, onProgress } = {}) {
    const urls = [
      candidate?.localFetchRecipe?.primaryUrl,
      ...(Array.isArray(candidate?.localFetchRecipe?.backupUrls)
        ? candidate.localFetchRecipe.backupUrls
        : []),
    ].filter(Boolean)

    if (urls.length === 0) {
      throw new Error('BILIBILI_MEDIA_CANDIDATE_NOT_FOUND')
    }

    const root = await getRootDirectory(rootDirectory)
    const tasksDirectory = await getTasksDirectory(root, true)
    const taskDirectory = await tasksDirectory.getDirectoryHandle(taskId, { create: true })
    const fileHandle = await taskDirectory.getFileHandle(taskFileName, { create: true })

    let lastError = null
    for (const url of urls) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')

      try {
        const response = await fetchImpl(url, {
          credentials: candidate?.localFetchRecipe?.credentialMode,
          signal,
        })
        if (!response?.ok || !response.body) {
          throw new Error(`MEDIA_DOWNLOAD_${response?.status || 'FAILED'}`)
        }

        const writable = await fileHandle.createWritable()
        const writeResult = await writeResponseBodyToFile({
          response,
          writable,
          signal,
          onProgress,
        })
        const blob = await fileHandle.getFile()
        return {
          blob,
          sourceUrl: url,
          bytesWritten: writeResult.bytesWritten,
          totalBytes: writeResult.totalBytes,
          contentLength: writeResult.contentLength,
          contentType: writeResult.contentType,
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        lastError = error
      }
    }

    throw lastError || new Error('MEDIA_DOWNLOAD_FAILED')
  }

  async function uploadBlob({ target, blob, onProgress } = {}) {
    await uploadMediaBlob({ target, blob, fetchImpl })
    onProgress?.({
      bytesWritten: blob?.size ?? 0,
      totalBytes: blob?.size ?? 0,
    })
  }

  async function cleanup() {
    const root = await getRootDirectory(rootDirectory)
    let tasksDirectory

    try {
      tasksDirectory = await getTasksDirectory(root, false)
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return { attempts: 1, retrySucceeded: false, initialError: null }
      }
      throw error
    }

    try {
      await tasksDirectory.removeEntry(taskId, { recursive: true })
      return { attempts: 1, retrySucceeded: false, initialError: null }
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        return { attempts: 1, retrySucceeded: false, initialError: null }
      }

      await wait(CLEANUP_RETRY_DELAY_MS)
      await tasksDirectory.removeEntry(taskId, { recursive: true })
      return { attempts: 2, retrySucceeded: true, initialError: error }
    }
  }

  return {
    ensureQuota,
    downloadCandidate,
    uploadBlob,
    cleanup,
  }
}
