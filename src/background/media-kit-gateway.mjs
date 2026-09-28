import {
  MediaKitError,
  queryMediaKitTask,
  requestMediaUploadTarget,
  sanitizeMediaUrl,
  submitMediaKitAsr,
} from '../services/apis/volcengine-mediakit.mjs'
import { VIDEO_SUMMARY_STORAGE_KEY } from '../video-summary/contracts.mjs'

function getLoggerMethod(logger, level) {
  return typeof logger?.[level] === 'function' ? logger[level].bind(logger) : () => {}
}

function logGatewayEvent(logger, level, entry) {
  getLoggerMethod(logger, level)(entry)
}

function sanitizeAudioReference(audioUrl) {
  if (typeof audioUrl !== 'string' || !audioUrl) return null
  if (audioUrl.startsWith('mediakit://')) {
    return {
      scheme: 'mediakit',
      fileReferencePresent: true,
    }
  }

  try {
    return sanitizeMediaUrl(audioUrl)
  } catch {
    return { scheme: 'opaque', valuePresent: true }
  }
}

function serializeError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message : null,
    operation: error?.operation ?? null,
    httpStatus: error?.httpStatus ?? null,
    providerCode: error?.providerCode ?? null,
    requestId: error?.requestId ?? null,
    retryAfterMs: error?.retryAfterMs ?? null,
  }
}

async function requireMediaKitKey(storageArea) {
  const payload = await storageArea.get(VIDEO_SUMMARY_STORAGE_KEY)
  const apiKey = String(payload?.[VIDEO_SUMMARY_STORAGE_KEY] || '').trim()
  if (!apiKey) throw new MediaKitError('MEDIAKIT_API_KEY_REQUIRED')
  return apiKey
}

export function createMediaKitGateway({ storageArea, fetchImpl = fetch, logger } = {}) {
  return {
    async getKeyState() {
      const payload = await storageArea.get(VIDEO_SUMMARY_STORAGE_KEY)
      return { present: Boolean(payload?.[VIDEO_SUMMARY_STORAGE_KEY]) }
    },

    async setKey(apiKey) {
      await storageArea.set({ [VIDEO_SUMMARY_STORAGE_KEY]: String(apiKey || '').trim() })
    },

    async deleteKey() {
      await storageArea.remove(VIDEO_SUMMARY_STORAGE_KEY)
    },

    async submitDirectAsr({ audioUrl, clientToken, speakerIdentification, confirmed }) {
      const logContext = {
        event: 'video-summary-mediakit.submit-direct-asr',
        audioSource: sanitizeAudioReference(audioUrl),
        clientTokenPresent: Boolean(clientToken),
        speakerIdentification: speakerIdentification === true,
        confirmed: confirmed === true,
      }

      try {
        const apiKey = await requireMediaKitKey(storageArea)
        const result = await submitMediaKitAsr({
          apiKey,
          audioUrl,
          clientToken,
          speakerIdentification,
          confirmed,
          fetchImpl,
        })
        logGatewayEvent(logger, 'info', {
          ...logContext,
          status: 'passed',
          taskIdPresent: Boolean(result.taskId),
          requestIdPresent: Boolean(result.requestId),
        })
        return result
      } catch (error) {
        logGatewayEvent(logger, 'warn', {
          ...logContext,
          status: 'failed',
          error: serializeError(error),
        })
        throw error
      }
    },

    async requestUploadTarget() {
      const logContext = { event: 'video-summary-mediakit.request-upload-target' }

      try {
        const apiKey = await requireMediaKitKey(storageArea)
        const result = await requestMediaUploadTarget({ apiKey, fetchImpl })
        logGatewayEvent(logger, 'info', {
          ...logContext,
          status: 'passed',
          fileReferenceScheme: result.fileReference.startsWith('mediakit://') ? 'mediakit' : null,
          uploadMethod: result.method,
          uploadHeaderKeys: Object.keys(result.headers).sort(),
        })
        return result
      } catch (error) {
        logGatewayEvent(logger, 'warn', {
          ...logContext,
          status: 'failed',
          error: serializeError(error),
        })
        throw error
      }
    },

    async queryTask({ taskId }) {
      const logContext = {
        event: 'video-summary-mediakit.query-task',
        taskIdPresent: Boolean(taskId),
      }

      try {
        const apiKey = await requireMediaKitKey(storageArea)
        const result = await queryMediaKitTask({ apiKey, taskId, fetchImpl })
        logGatewayEvent(logger, 'info', {
          ...logContext,
          status: 'passed',
          taskStatus: result?.status ?? null,
          requestIdPresent: Boolean(result?.request_id),
        })
        return result
      } catch (error) {
        logGatewayEvent(logger, 'warn', {
          ...logContext,
          status: 'failed',
          error: serializeError(error),
        })
        throw error
      }
    },
  }
}
