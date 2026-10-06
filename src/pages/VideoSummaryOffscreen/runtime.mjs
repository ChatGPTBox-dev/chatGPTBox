import { createMediaPipeline } from '../../video-summary/media-pipeline.mjs'
import { createTaskOpfsStore } from '../../video-summary/opfs.mjs'
import { fencesEqual, ownersEqual, parseOffscreenCommand } from '../../video-summary/protocol.mjs'
import { createVideoTaskRunner } from '../../video-summary/task-runner.mjs'

const AUTHORIZATION_TIMEOUT_MS = 10_000
const RELEASE_RETRY_MS = 1_000
const RELEASE_SEND_LIMIT = 10

function clone(value) {
  return structuredClone(value)
}

function fenceKey(fence) {
  return JSON.stringify(fence)
}

function generationKey({ owner, taskId, generation }) {
  return { owner, taskId, generation }
}

function createRpcError(value) {
  const error = new Error(value?.code || 'VIDEO_SUMMARY_GATEWAY_REQUEST_FAILED')
  Object.assign(error, value)
  return error
}

function sanitizeArgs(args) {
  const value = { ...(args || {}) }
  delete value.signal
  return clone(value)
}

function defaultRequestId() {
  return crypto.randomUUID()
}

export function startVideoSummaryOffscreenRuntime({
  port,
  taskRunner,
  mediaPipeline,
  modelGateway,
  logger,
  clock = {},
  createRequestId = defaultRequestId,
}) {
  const setTimer = clock.setTimeout?.bind(clock) ?? setTimeout
  const clearTimer = clock.clearTimeout?.bind(clock) ?? clearTimeout
  const attempts = new Map()
  const taskFences = new Map()
  const pendingGatewayRequests = new Map()
  const pendingSourceRefreshes = new Map()
  const pendingExecutionReleases = new Map()
  let stopped = false

  function post(message) {
    if (!stopped) port.postMessage(clone(message))
  }

  function currentFence(taskId) {
    return taskFences.get(taskId) ?? null
  }

  function requestGateway({ gateway, operation, args }) {
    const fence = currentFence(args?.taskId)
    if (!fence) return Promise.reject(new Error('VIDEO_SUMMARY_ATTEMPT_NOT_AUTHORIZED'))
    const requestId = createRequestId()
    return new Promise((resolve, reject) => {
      pendingGatewayRequests.set(requestId, { resolve, reject, fence })
      post({
        type: 'GATEWAY_REQUEST',
        requestId,
        fence,
        gateway,
        operation,
        args: sanitizeArgs(args),
      })
    })
  }

  const runtimeModelGateway = modelGateway || {
    describeCapabilities(modelSnapshot) {
      const attempt = [...attempts.values()].find(
        (candidate) =>
          JSON.stringify(candidate.modelSnapshot) === JSON.stringify(modelSnapshot) &&
          fencesEqual(taskFences.get(candidate.fence.taskId), candidate.fence),
      )
      return requestGateway({
        gateway: 'model',
        operation: 'describeCapabilities',
        args: { ...modelSnapshot, taskId: attempt?.fence.taskId },
      })
    },
    generateText(args) {
      return requestGateway({ gateway: 'model', operation: 'generateText', args })
    },
    cancel(args) {
      return requestGateway({ gateway: 'model', operation: 'cancel', args }).catch(() => {})
    },
  }
  const mediaKitGateway = {
    submitDirectAsr: (args) =>
      requestGateway({ gateway: 'mediakit', operation: 'submitDirectAsr', args }),
    requestUploadTarget: (args = {}) =>
      requestGateway({ gateway: 'mediakit', operation: 'requestUploadTarget', args }),
    queryTask: (args) => requestGateway({ gateway: 'mediakit', operation: 'queryTask', args }),
  }
  const runtimeMediaPipeline =
    mediaPipeline ||
    createMediaPipeline({
      mediaKitGateway,
      opfsStoreFactory: ({ taskId, owner }) => createTaskOpfsStore({ taskId, owner }),
      logger,
      clock,
    })
  const runner =
    taskRunner ||
    createVideoTaskRunner({
      mediaPipeline: runtimeMediaPipeline,
      modelGateway: runtimeModelGateway,
      logger,
      clock,
    })

  function normalizeEvent(event) {
    const type = event.type === 'TASK_RESULT' ? 'TASK_COMPLETED' : event.type
    const normalized = { type }
    for (const key of [
      'stage',
      'checkpointAvailable',
      'completedChunks',
      'totalChunks',
      'result',
      'errorCode',
      'message',
    ]) {
      if (key in event) normalized[key] = clone(event[key])
    }
    return normalized
  }

  function sendRelease(fence) {
    const key = fenceKey(fence)
    let record = pendingExecutionReleases.get(key)
    if (!record) {
      record = { fence: clone(fence), sends: 0, timerId: null }
      pendingExecutionReleases.set(key, record)
    }
    if (record.sends >= RELEASE_SEND_LIMIT) {
      pendingExecutionReleases.delete(key)
      return
    }
    record.sends += 1
    post({ type: 'EXECUTION_RELEASED', fence: record.fence })
    if (record.sends < RELEASE_SEND_LIMIT) {
      record.timerId = setTimer(() => sendRelease(record.fence), RELEASE_RETRY_MS)
    }
  }

  function release(fence) {
    const key = fenceKey(fence)
    const attempt = attempts.get(key)
    if (attempt?.authorizationTimerId != null) clearTimer(attempt.authorizationTimerId)
    attempts.delete(key)
    if (fencesEqual(taskFences.get(fence.taskId), fence)) taskFences.delete(fence.taskId)
    runner.releaseAttempt(fence)
    sendRelease(fence)
  }

  function requestSourceRefresh({ owner, taskId, reason }) {
    const fence = currentFence(taskId)
    const attempt = fence && attempts.get(fenceKey(fence))
    if (!fence || !attempt || !ownersEqual(fence.owner, owner)) {
      return Promise.reject(new Error('VIDEO_SUMMARY_OWNER_MISMATCH'))
    }
    const requestId = createRequestId()
    return new Promise((resolve, reject) => {
      pendingSourceRefreshes.set(requestId, { resolve, reject, fence })
      post({
        type: 'SOURCE_REFRESH_REQUEST',
        requestId,
        fence,
        expectedPageIdentity: attempt.pageIdentity,
        reason,
      })
    })
  }

  function register(command) {
    try {
      const emit = (event) =>
        post({ type: 'TASK_EVENT', fence: command.fence, event: normalizeEvent(event) })
      runner.registerAttempt({
        requestId: command.requestId,
        fence: command.fence,
        mode: command.mode,
        payload: { ...command.payload, requestSourceRefresh },
        emit,
      })
      const record = {
        requestId: command.requestId,
        fence: command.fence,
        modelSnapshot: clone(command.payload.modelSnapshot ?? {}),
        pageIdentity: clone(command.payload.sourceSnapshot?.pageIdentity),
        authorizationTimerId: null,
      }
      attempts.set(fenceKey(command.fence), record)
      post({ type: 'ATTEMPT_ACCEPTED', requestId: command.requestId, fence: command.fence })
      record.authorizationTimerId = setTimer(() => {
        if (attempts.get(fenceKey(command.fence)) !== record) return
        runner.cancelGeneration(generationKey(command.fence))
        release(command.fence)
      }, AUTHORIZATION_TIMEOUT_MS)
    } catch (error) {
      post({
        type: 'ATTEMPT_REJECTED',
        requestId: command.requestId,
        fence: command.fence,
        errorCode: error?.message || 'VIDEO_SUMMARY_ATTEMPT_REJECTED',
      })
    }
  }

  function authorize(command) {
    const record = attempts.get(fenceKey(command.fence))
    if (!record || record.requestId !== command.requestId) return
    clearTimer(record.authorizationTimerId)
    record.authorizationTimerId = null
    taskFences.set(command.fence.taskId, command.fence)
    void Promise.resolve(
      runner.authorizeAttempt({ requestId: command.requestId, fence: command.fence }),
    )
      .catch(() => {})
      .finally(() => release(command.fence))
  }

  function handleGatewayResponse(command) {
    const pending = pendingGatewayRequests.get(command.requestId)
    if (!pending || !fencesEqual(pending.fence, command.fence)) return
    pendingGatewayRequests.delete(command.requestId)
    if (command.ok) pending.resolve(command.result)
    else pending.reject(createRpcError(command.error))
  }

  function handleRefreshResult(command) {
    const pending = pendingSourceRefreshes.get(command.requestId)
    if (!pending || !fencesEqual(pending.fence, currentFence(command.taskId))) return
    pendingSourceRefreshes.delete(command.requestId)
    if (command.errorCode) pending.reject(new Error(command.errorCode))
    else pending.resolve(command.sourceSnapshot)
  }

  function handleCommand(value) {
    let command
    try {
      command = parseOffscreenCommand(value)
    } catch {
      return
    }
    if (command.type === 'START_ATTEMPT') register(command)
    else if (command.type === 'ATTEMPT_AUTHORIZED') authorize(command)
    else if (command.type === 'CANCEL_TASK') runner.cancelGeneration(generationKey(command.fence))
    else if (command.type === 'EXECUTION_RELEASED_ACK') {
      const record = pendingExecutionReleases.get(fenceKey(command.fence))
      if (record) clearTimer(record.timerId)
      pendingExecutionReleases.delete(fenceKey(command.fence))
    } else if (command.type === 'DELETE_TASK') {
      runner.deleteTask(command)
      post({
        type: 'TASK_DELETED',
        owner: command.owner,
        taskId: command.taskId,
        generation: command.generation,
      })
    } else if (command.type === 'GATEWAY_RESPONSE') handleGatewayResponse(command)
    else handleRefreshResult(command)
  }

  const onDisconnect = () => {
    stopped = true
    for (const record of attempts.values()) clearTimer(record.authorizationTimerId)
    for (const record of pendingExecutionReleases.values()) clearTimer(record.timerId)
    const error = new Error('VIDEO_SUMMARY_OFFSCREEN_DISCONNECTED')
    for (const pending of [
      ...pendingGatewayRequests.values(),
      ...pendingSourceRefreshes.values(),
    ]) {
      pending.reject(error)
    }
    pendingGatewayRequests.clear()
    pendingSourceRefreshes.clear()
    port.onMessage.removeListener(handleCommand)
    port.onDisconnect.removeListener(onDisconnect)
  }
  port.onMessage.addListener(handleCommand)
  port.onDisconnect.addListener(onDisconnect)
  return { mediaKitGateway, modelGateway: runtimeModelGateway }
}
