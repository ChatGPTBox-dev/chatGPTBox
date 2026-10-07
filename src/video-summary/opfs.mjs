import {
  validateLocalFetchRecipe,
  validateRedirectLocation,
  validateUploadTarget,
  VIDEO_MEDIA_MAX_REDIRECTS,
} from './media-policy.mjs'

const VIDEO_SUMMARY_TASKS_DIR = 'video-summary-tasks'
const DEFAULT_TASK_FILE_NAME = 'media.bin'
const CLEANUP_RETRY_DELAY_MS = 25
const DEFAULT_CANDIDATE_BITRATE = 320_000
export const VIDEO_SUMMARY_OPFS_RESERVE_BYTES = 64 * 1024 * 1024
export const VIDEO_SUMMARY_OPFS_TASK_LIMIT_BYTES = 1024 * 1024 * 1024

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

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
}

function createTaskSizeLimitError() {
  const error = new Error('OPFS_TASK_SIZE_LIMIT_EXCEEDED')
  error.code = 'OPFS_TASK_SIZE_LIMIT_EXCEEDED'
  return error
}

function isNotFoundError(error) {
  return error?.name === 'NotFoundError'
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

export function estimateCandidateBytes(candidate) {
  const metadata = candidate?.mediaMetadata || {}
  if (Number.isFinite(metadata.contentLength) && metadata.contentLength > 0) {
    return Math.ceil(metadata.contentLength)
  }
  if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0) {
    return VIDEO_SUMMARY_OPFS_TASK_LIMIT_BYTES
  }
  const bitrate =
    Number.isFinite(metadata.bandwidth) && metadata.bandwidth > 0
      ? metadata.bandwidth
      : DEFAULT_CANDIDATE_BITRATE
  return Math.ceil((metadata.durationMs / 1000) * (bitrate / 8))
}

async function getWritableBudget(estimateStorage) {
  if (typeof estimateStorage !== 'function') {
    return { quotaBytes: null, usageBytes: null, reserveBytes: null, availableBytes: null }
  }
  const estimate = await estimateStorage()
  const quotaBytes = Number.isFinite(estimate?.quota) ? estimate.quota : null
  const usageBytes = Number.isFinite(estimate?.usage) ? estimate.usage : null
  const reserveBytes =
    quotaBytes === null ? null : Math.max(VIDEO_SUMMARY_OPFS_RESERVE_BYTES, quotaBytes * 0.1)
  const availableBytes =
    quotaBytes !== null && usageBytes !== null
      ? Math.max(0, quotaBytes - usageBytes - reserveBytes)
      : null
  return { quotaBytes, usageBytes, reserveBytes, availableBytes }
}

function requireWithinBudget(requiredBytes, budget) {
  if (requiredBytes > VIDEO_SUMMARY_OPFS_TASK_LIMIT_BYTES) throw createTaskSizeLimitError()
  if (budget.availableBytes !== null && requiredBytes > budget.availableBytes) {
    throw createQuotaExceededError({ ...budget, requiredBytes })
  }
}

async function writeResponseBodyToFile({ response, writable, signal, onProgress, budget }) {
  const reader = response.body.getReader()
  let bytesWritten = 0
  const totalBytes = Number.parseInt(response.headers.get('content-length') || '', 10) || null

  try {
    for (;;) {
      throwIfAborted(signal)
      const chunk = await reader.read()
      if (chunk.done) break
      const nextBytes = bytesWritten + chunk.value.byteLength
      requireWithinBudget(nextBytes, budget)
      await writable.write(chunk.value)
      bytesWritten = nextBytes
      onProgress?.({ bytesWritten, totalBytes: totalBytes ?? bytesWritten })
    }
    await writable.close()
  } catch (error) {
    await reader.cancel?.(error).catch?.(() => {})
    await writable.abort?.(error).catch?.(() => {})
    throw error
  }

  return {
    bytesWritten,
    totalBytes: totalBytes ?? bytesWritten,
    contentLength: totalBytes,
    contentType: response.headers.get('content-type') || '',
  }
}

export async function cleanupVideoSummaryTaskDirectory({ rootDirectory, taskId, signal } = {}) {
  throwIfAborted(signal)
  const root = await getRootDirectory(rootDirectory)
  let tasksDirectory
  try {
    tasksDirectory = await getTasksDirectory(root, false)
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
  throwIfAborted(signal)
  try {
    await tasksDirectory.removeEntry(taskId, { recursive: true })
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
}

export async function cleanupVideoSummaryTasksRoot({ rootDirectory, signal } = {}) {
  throwIfAborted(signal)
  const root = await getRootDirectory(rootDirectory)
  let tasksDirectory
  try {
    tasksDirectory = await getTasksDirectory(root, false)
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
  for await (const entry of tasksDirectory.values()) {
    throwIfAborted(signal)
    if (entry?.name) await tasksDirectory.removeEntry(entry.name, { recursive: true })
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
  async function ensureQuota({ requiredBytes, candidate } = {}) {
    const normalizedRequiredBytes =
      Number.isFinite(requiredBytes) && requiredBytes > 0
        ? requiredBytes
        : estimateCandidateBytes(candidate)
    const budget = await getWritableBudget(estimateStorage)
    requireWithinBudget(normalizedRequiredBytes, budget)
    return budget
  }

  async function downloadCandidate({ platform, candidate, signal, onProgress } = {}) {
    const recipe = validateLocalFetchRecipe({ platform, recipe: candidate?.localFetchRecipe })
    const urls = [recipe.primaryUrl, ...recipe.backupUrls]

    if (urls.length === 0) throw new Error('VIDEO_MEDIA_CANDIDATE_NOT_FOUND')

    let lastError = null
    for (const url of urls) {
      throwIfAborted(signal)
      let taskDirectoryCreated = false

      try {
        let currentUrl = url
        let response
        for (let redirectCount = 0; ; redirectCount += 1) {
          response = await fetchImpl(currentUrl, {
            credentials: recipe.credentialMode,
            redirect: 'manual',
            signal,
          })
          if (response?.status < 300 || response.status > 399) break
          if (redirectCount >= VIDEO_MEDIA_MAX_REDIRECTS) {
            throw new Error('VIDEO_MEDIA_REDIRECT_LIMIT_EXCEEDED')
          }
          currentUrl = validateRedirectLocation({
            platform,
            currentUrl,
            location: response.headers.get('location'),
          })
        }
        if (!response?.ok || !response.body) {
          throw new Error(`MEDIA_DOWNLOAD_${response?.status || 'FAILED'}`)
        }

        const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10)
        const requiredBytes =
          Number.isFinite(contentLength) && contentLength > 0
            ? contentLength
            : estimateCandidateBytes(candidate)
        const budget = await ensureQuota({ requiredBytes, candidate })
        const root = await getRootDirectory(rootDirectory)
        const tasksDirectory = await getTasksDirectory(root, true)
        const taskDirectory = await tasksDirectory.getDirectoryHandle(taskId, { create: true })
        taskDirectoryCreated = true
        const fileHandle = await taskDirectory.getFileHandle(taskFileName, { create: true })
        const writable = await fileHandle.createWritable()
        const writeResult = await writeResponseBodyToFile({
          response,
          writable,
          signal,
          onProgress,
          budget,
        })
        const blob = await fileHandle.getFile()
        return {
          blob,
          sourceUrl: currentUrl,
          bytesWritten: writeResult.bytesWritten,
          totalBytes: writeResult.totalBytes,
          contentLength: writeResult.contentLength,
          contentType: writeResult.contentType,
        }
      } catch (error) {
        if (taskDirectoryCreated) {
          await cleanupVideoSummaryTaskDirectory({ rootDirectory, taskId }).catch(() => {})
        }
        if (
          error?.name === 'AbortError' ||
          String(error?.message).startsWith('VIDEO_MEDIA_') ||
          String(error?.message).startsWith('OPFS_')
        ) {
          throw error
        }
        lastError = error
      }
    }

    throw lastError || new Error('MEDIA_DOWNLOAD_FAILED')
  }

  async function uploadBlob({ target, blob, signal, onProgress } = {}) {
    const validatedTarget = validateUploadTarget(target)
    const response = await fetchImpl(validatedTarget.url, {
      method: validatedTarget.method,
      headers: validatedTarget.headers,
      body: blob,
      credentials: validatedTarget.credentials,
      redirect: validatedTarget.redirect,
      signal,
    })
    if (!response?.ok) throw new Error(`MEDIA_UPLOAD_${response?.status || 'FAILED'}`)
    onProgress?.({ bytesWritten: blob?.size ?? 0, totalBytes: blob?.size ?? 0 })
  }

  async function cleanup({ signal } = {}) {
    try {
      await cleanupVideoSummaryTaskDirectory({ rootDirectory, taskId, signal })
      return { attempts: 1, retrySucceeded: false, initialError: null }
    } catch (error) {
      await wait(CLEANUP_RETRY_DELAY_MS, { signal })
      await cleanupVideoSummaryTaskDirectory({ rootDirectory, taskId, signal })
      return { attempts: 2, retrySucceeded: true, initialError: error }
    }
  }

  return { ensureQuota, downloadCandidate, uploadBlob, cleanup }
}
