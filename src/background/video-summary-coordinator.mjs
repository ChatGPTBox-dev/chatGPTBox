import {
  fencesEqual,
  hashRetryRequest,
  hashStartRequest,
  measureSerializedBytes,
  ownersEqual,
  pageIdentitiesEqual,
  parseContentCommand,
  parseOffscreenMessage,
} from '../video-summary/protocol.mjs'

const WATCHDOG_MS = 10_000
const DISCONNECT_GRACE_MS = 15_000
const RETENTION_MS = 15 * 60_000
const START_RECORD_LIMIT = 128
const RETAINED_TASK_LIMIT = 32
const REPLAY_BYTES_LIMIT = 16 * 1024 * 1024

function clone(value) {
  return structuredClone(value)
}

function getNested(root, keys) {
  let current = root
  for (const key of keys) {
    current = current?.get(key)
    if (current === undefined) return undefined
  }
  return current
}

function setNested(root, keys, value) {
  let current = root
  for (const key of keys.slice(0, -1)) {
    if (!current.has(key)) current.set(key, new Map())
    current = current.get(key)
  }
  current.set(keys.at(-1), value)
}

function deleteNested(root, keys) {
  const maps = [root]
  let current = root
  for (const key of keys.slice(0, -1)) {
    current = current.get(key)
    if (!current) return false
    maps.push(current)
  }
  const deleted = current.delete(keys.at(-1))
  for (let index = maps.length - 1; index > 0; index -= 1) {
    if (maps[index].size > 0) break
    maps[index - 1].delete(keys[index - 1])
  }
  return deleted
}

function valuesNested(root, depth, values = []) {
  for (const value of root.values()) {
    if (depth === 1) values.push(value)
    else valuesNested(value, depth - 1, values)
  }
  return values
}

function ownerKeys(owner) {
  return [owner.tabId, owner.documentId, owner.platform, owner.mediaId]
}

function retainedKeys(owner, taskId, generation) {
  return [...ownerKeys(owner), taskId, generation]
}

function capabilityKeys({ owner, taskId, generation }) {
  return retainedKeys(owner, taskId, generation)
}

function fail(code) {
  throw new Error(code)
}

function boundedId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isTerminalEvent(event) {
  return ['TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED'].includes(event.type)
}

function createFailureEvent(errorCode) {
  return { type: 'TASK_FAILED', checkpointAvailable: false, errorCode }
}

export function createVideoSummaryCoordinator({
  clock,
  ensureOffscreen,
  sendOffscreen,
  sendContent,
  resetOffscreen,
}) {
  const activeSlots = new Map()
  const retainedTasks = new Map()
  const startRecords = new Map()
  const capabilities = new Map()
  let nextGeneration = 1
  let resetting = null

  function slotKeys(owner) {
    return [owner.tabId, owner.platform]
  }

  function getSlot(owner) {
    return getNested(activeSlots, slotKeys(owner))
  }

  function setSlot(owner, slot) {
    setNested(activeSlots, slotKeys(owner), slot)
  }

  function deleteSlot(owner) {
    deleteNested(activeSlots, slotKeys(owner))
  }

  function getRetained(owner, taskId, generation) {
    return getNested(retainedTasks, retainedKeys(owner, taskId, generation))
  }

  function setRetained(record) {
    setNested(retainedTasks, retainedKeys(record.owner, record.taskId, record.generation), record)
  }

  function clearTimer(record, field) {
    if (record?.[field] != null) clock.clearTimeout(record[field])
    if (record) record[field] = null
  }

  function getStartRecord(documentId, taskId) {
    return getNested(startRecords, [documentId, taskId])
  }

  function setStartRecord(record) {
    setNested(startRecords, [record.documentId, record.taskId], record)
  }

  function sendToWaiters(record, response) {
    record.response = clone(response)
    for (const port of record.waiters.splice(0)) sendContent(port, clone(response))
  }

  function scheduleStartExpiry(record) {
    clearTimer(record, 'expiryTimerId')
    const deadline = clock.now() + RETENTION_MS
    record.expiresAt = deadline
    record.expiryTimerId = clock.setTimeout(() => {
      const current = getStartRecord(record.documentId, record.taskId)
      if (current !== record || current.expiresAt !== deadline || current.state === 'pending')
        return
      deleteNested(startRecords, [record.documentId, record.taskId])
    }, RETENTION_MS)
  }

  function countRetained() {
    return valuesNested(retainedTasks, 6).length
  }

  function replayBytes(except = null, candidate = null) {
    let total = candidate ? measureSerializedBytes(candidate) : 0
    for (const record of valuesNested(retainedTasks, 6)) {
      if (record !== except) total += measureSerializedBytes(record.replayEvent)
    }
    return total
  }

  function storeReplay(record, event) {
    let replayEvent = clone(event)
    if (
      replayBytes(record, replayEvent) > REPLAY_BYTES_LIMIT ||
      measureSerializedBytes(replayEvent) > REPLAY_BYTES_LIMIT
    ) {
      replayEvent = createFailureEvent('VIDEO_SUMMARY_RESULT_TOO_LARGE')
      record.checkpointAvailable = false
    } else if ('checkpointAvailable' in replayEvent) {
      record.checkpointAvailable = replayEvent.checkpointAvailable
    }
    record.replayEvent = replayEvent
    return replayEvent
  }

  function getCapability(fence) {
    return getNested(capabilities, capabilityKeys(fence))
  }

  function setCapability(capability) {
    setNested(capabilities, capabilityKeys(capability), capability)
  }

  function deleteCapability(fence) {
    deleteNested(capabilities, capabilityKeys(fence))
  }

  function revokeGenerationCapability({ owner, taskId, generation }) {
    const capability = getNested(capabilities, retainedKeys(owner, taskId, generation))
    if (capability) capability.revoked = true
  }

  function revokeAttemptModelCapability(fence) {
    const capability = getCapability(fence)
    if (capability?.currentAttempt?.attempt === fence.attempt) capability.currentAttempt = null
  }

  function requireExecutableCapability(fence) {
    const capability = getCapability(fence)
    const slot = getSlot(fence.owner)
    if (
      !capability ||
      capability.revoked ||
      !slot ||
      slot.state !== 'running' ||
      !fencesEqual(slot.fence, fence) ||
      capability.currentAttempt?.attempt !== fence.attempt ||
      !ownersEqual(capability.owner, fence.owner) ||
      capability.taskId !== fence.taskId ||
      capability.generation !== fence.generation
    ) {
      fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
    }
    return capability
  }

  function requireAsrCapability(capability) {
    if (capability.sourceChoice !== 'asr' || !capability.asrConfirmed) {
      fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
    }
  }

  function requireCurrentAttemptModel(capability, args) {
    const modelIdentity = args?.modelSnapshot ?? args
    const normalizedIdentity = { ...modelIdentity }
    delete normalizedIdentity.taskId
    if (!valuesEqual(capability.currentAttempt.modelIdentity, normalizedIdentity)) {
      fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
    }
  }

  function authorizeGatewayRequest({ fence, requestId, gateway, operation, args }) {
    const capability = requireExecutableCapability(fence)
    boundedId(requestId)
    const authorizedArgs = clone(args)

    if (gateway === 'model') {
      if (!['describeCapabilities', 'generateText'].includes(operation)) {
        fail('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')
      }
      requireCurrentAttemptModel(capability, authorizedArgs)
      return { args: authorizedArgs, reservation: null }
    }
    if (gateway !== 'mediakit') fail('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')

    requireAsrCapability(capability)
    if (operation === 'submitDirectAsr') {
      if (!capability.candidateUrls.includes(authorizedArgs.audioUrl)) {
        fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
      }
      if (capability.directSubmission !== 'available') {
        fail('VIDEO_SUMMARY_SUBMISSION_ALREADY_CONSUMED')
      }
      capability.directSubmission = 'consumed'
      return { args: authorizedArgs, reservation: { kind: 'direct-submit' } }
    }
    if (operation === 'markFallbackEligible') {
      if (
        capability.directSubmission !== 'consumed' ||
        capability.providerTaskId !== authorizedArgs.providerTaskId ||
        !['URL_DOWNLOAD_FAILED', 'AUDIO_URL_DOWNLOAD_FAILED'].includes(authorizedArgs.providerCode)
      ) {
        fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
      }
      capability.directSubmission = 'fallback-eligible'
      return { args: authorizedArgs, reservation: { kind: 'fallback-transition' } }
    }
    if (operation === 'requestUploadTarget') {
      if (capability.directSubmission !== 'fallback-eligible') {
        fail('VIDEO_SUMMARY_FALLBACK_NOT_ELIGIBLE')
      }
      if (capability.fallbackSubmission !== 'unavailable') {
        fail('VIDEO_SUMMARY_UPLOAD_TARGET_ALREADY_ISSUED')
      }
      capability.fallbackSubmission = 'target-issued'
      return { args: authorizedArgs, reservation: { kind: 'upload-target' } }
    }
    if (operation === 'submitUploadedAsr') {
      if (capability.fallbackSubmission !== 'target-issued') {
        if (capability.fallbackSubmission === 'consumed') {
          fail('VIDEO_SUMMARY_SUBMISSION_ALREADY_CONSUMED')
        }
        fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
      }
      const submittedTarget = authorizedArgs.uploadTarget ?? {
        url: authorizedArgs.url,
        method: authorizedArgs.method,
        headers: authorizedArgs.headers,
        fileReference: authorizedArgs.audioUrl,
      }
      if (!capability.uploadTarget || !valuesEqual(capability.uploadTarget, submittedTarget)) {
        fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
      }
      capability.fallbackSubmission = 'consumed'
      return { args: authorizedArgs, reservation: { kind: 'fallback-submit' } }
    }
    if (operation === 'queryTask') {
      if (!capability.providerTaskId || capability.providerTaskId !== authorizedArgs.taskId) {
        fail('VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
      }
      return { args: authorizedArgs, reservation: null }
    }
    fail('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')
  }

  function completeGatewayRequest({ fence, gateway, operation, outcome }) {
    const capability = getCapability(fence)
    if (
      !capability ||
      capability.revoked ||
      capability.currentAttempt?.attempt !== fence.attempt ||
      gateway !== 'mediakit' ||
      !outcome?.ok
    ) {
      return
    }
    if (operation === 'requestUploadTarget') {
      capability.uploadTarget = clone(outcome.result)
    } else if (operation === 'submitDirectAsr' || operation === 'submitUploadedAsr') {
      if (typeof outcome.result?.taskId === 'string' && outcome.result.taskId) {
        capability.providerTaskId = outcome.result.taskId
      }
    }
  }

  function latestFence(record) {
    const slot = getSlot(record.owner)
    if (
      slot &&
      slot.fence.taskId === record.taskId &&
      slot.fence.generation === record.generation
    ) {
      return slot.fence
    }
    if (record.retryRecord?.fence) return record.retryRecord.fence
    const startRecord = getStartRecord(record.owner.documentId, record.taskId)
    return startRecord?.fence ?? null
  }

  function scheduleRetainedExpiry(record) {
    clearTimer(record, 'expiryTimerId')
    const deadline = clock.now() + RETENTION_MS
    record.expiresAt = deadline
    record.expiryTimerId = clock.setTimeout(() => {
      const current = getRetained(record.owner, record.taskId, record.generation)
      if (
        current !== record ||
        current.expiresAt !== deadline ||
        getSlot(record.owner) ||
        record.state !== 'retained'
      ) {
        return
      }
      beginDelete(record)
    }, RETENTION_MS)
  }

  function clearRetained(record) {
    clearTimer(record, 'expiryTimerId')
    clearTimer(record, 'deleteTimerId')
    clearTimer(record, 'disconnectTimerId')
    deleteNested(retainedTasks, retainedKeys(record.owner, record.taskId, record.generation))
    const capability = getNested(
      capabilities,
      retainedKeys(record.owner, record.taskId, record.generation),
    )
    if (capability) deleteCapability(capability)
  }

  function markRuntimeRestart(record) {
    record.checkpointAvailable = false
    record.state = 'retained'
    storeReplay(record, createFailureEvent('VIDEO_SUMMARY_RUNTIME_RESTARTED'))
    scheduleRetainedExpiry(record)
  }

  function rejectPending(record, errorCode) {
    const response = {
      type: record.kind === 'start' ? 'START_ACK' : 'RETRY_ACK',
      requestId: record.requestId,
      taskId: record.taskId,
      status: 'rejected',
      errorCode,
    }
    record.state = 'rejected'
    sendToWaiters(record, response)
    if (record.kind === 'start') scheduleStartExpiry(record)
  }

  function cleanupRuntimeState({ removeDeleting = false } = {}) {
    for (const slot of valuesNested(activeSlots, 2)) {
      clearTimer(slot, 'acceptTimerId')
      clearTimer(slot, 'releaseTimerId')
      const retained = getRetained(slot.fence.owner, slot.fence.taskId, slot.fence.generation)
      if (retained) markRuntimeRestart(retained)
      const startRecord = getStartRecord(slot.fence.owner.documentId, slot.fence.taskId)
      if (startRecord?.state === 'pending') {
        rejectPending(startRecord, 'VIDEO_SUMMARY_RUNTIME_RESTARTED')
      }
      if (retained?.retryRecord?.state === 'pending') {
        rejectPending(retained.retryRecord, 'VIDEO_SUMMARY_RUNTIME_RESTARTED')
      }
    }
    activeSlots.clear()
    capabilities.clear()
    for (const retained of [...valuesNested(retainedTasks, 6)]) {
      if (retained.state === 'deleting' && removeDeleting) clearRetained(retained)
      else markRuntimeRestart(retained)
    }
  }

  function resetRuntime(options) {
    cleanupRuntimeState(options)
    if (!resetting) {
      resetting = Promise.resolve(resetOffscreen()).finally(() => {
        resetting = null
      })
    }
    return resetting
  }

  function beginDelete(record) {
    if (record.state === 'deleting') return
    record.state = 'deleting'
    record.expiresAt = null
    clearTimer(record, 'expiryTimerId')
    sendOffscreen({
      type: 'DELETE_TASK',
      owner: clone(record.owner),
      taskId: record.taskId,
      generation: record.generation,
    })
    record.deleteTimerId = clock.setTimeout(() => {
      const current = getRetained(record.owner, record.taskId, record.generation)
      if (current !== record || current.state !== 'deleting') return
      void resetRuntime({ removeDeleting: true })
    }, WATCHDOG_MS)
  }

  function startReleaseWatchdog(slot) {
    clearTimer(slot, 'releaseTimerId')
    slot.releaseTimerId = clock.setTimeout(() => {
      const current = getSlot(slot.fence.owner)
      if (current !== slot || !fencesEqual(current.fence, slot.fence)) return
      void resetRuntime()
    }, WATCHDOG_MS)
  }

  function cancelActive(slot, deleteAfterRelease = false) {
    revokeGenerationCapability(slot.fence)
    slot.state = 'cancelling'
    slot.deleteAfterRelease ||= deleteAfterRelease
    clearTimer(slot, 'acceptTimerId')
    sendOffscreen({ type: 'CANCEL_TASK', fence: clone(slot.fence) })
    startReleaseWatchdog(slot)
  }

  function reject(port, type, command, errorCode) {
    sendContent(port, {
      type,
      requestId: command.requestId ?? command.taskId ?? command.cancelRequestId,
      ...(type !== 'ATTACH_ACK' ? { taskId: command.taskId } : {}),
      status: type === 'ATTACH_ACK' ? 'not-found' : 'rejected',
      errorCode,
    })
  }

  function validateContext(context, command) {
    return (
      pageIdentitiesEqual(context.pageIdentity, command.pageIdentity) &&
      context.owner.platform === command.pageIdentity.platform &&
      context.owner.mediaId === command.pageIdentity.mediaId
    )
  }

  function createCapability(fence, command) {
    return {
      owner: clone(fence.owner),
      taskId: fence.taskId,
      generation: fence.generation,
      sourceChoice: command.sourceChoice ?? null,
      asrConfirmed: Boolean(command.settingsSnapshot?.asrConfirmed),
      candidateUrls: (command.sourceSnapshot?.mediaCandidates ?? [])
        .map((candidate) => candidate.remoteCandidate?.url)
        .filter(Boolean),
      directSubmission: command.sourceChoice === 'asr' ? 'available' : 'consumed',
      fallbackSubmission: 'unavailable',
      uploadTarget: null,
      providerTaskId: null,
      currentAttempt: { attempt: fence.attempt, modelIdentity: clone(command.modelSnapshot) },
      revoked: false,
    }
  }

  function commitAttempt({ record, retained, command, port, mode, fence }) {
    if (record.cancellation) {
      const startResponse = {
        type: 'START_ACK',
        requestId: record.requestId,
        taskId: record.taskId,
        status: 'cancelled',
        fence: null,
      }
      const cancelResponse = {
        type: 'CANCEL_START_ACK',
        cancelRequestId: record.cancellation.cancelRequestId,
        targetStartRequestId: record.requestId,
        status: 'cancelled',
        fence: null,
      }
      record.state = 'cancelled'
      record.cancellation.response = cancelResponse
      sendToWaiters(record, startResponse)
      sendContent(record.cancellation.port, clone(cancelResponse))
      scheduleStartExpiry(record)
      return false
    }
    if (getSlot(fence.owner)) {
      rejectPending(record, 'VIDEO_SUMMARY_EXECUTION_BUSY')
      return false
    }
    if (mode === 'initial') setRetained(retained)
    else {
      retained.expiresAt = null
      clearTimer(retained, 'expiryTimerId')
    }
    const slot = {
      state: 'starting',
      fence: clone(fence),
      pageIdentity: clone(command.pageIdentity),
      deleteAfterRelease: false,
      acceptTimerId: null,
      releaseTimerId: null,
    }
    setSlot(fence.owner, slot)
    if (mode === 'initial') setCapability(createCapability(fence, command))
    else {
      const capability = getCapability(fence)
      if (!capability || capability.revoked) {
        rejectPending(record, 'VIDEO_SUMMARY_GATEWAY_CAPABILITY_DENIED')
        deleteSlot(fence.owner)
        return false
      }
      capability.currentAttempt = {
        attempt: fence.attempt,
        modelIdentity: clone(command.modelSnapshot),
      }
    }
    retained.port = port
    storeReplay(retained, { type: 'TASK_STARTED', checkpointAvailable: true })
    record.fence = clone(fence)
    sendOffscreen({
      type: 'START_ATTEMPT',
      requestId: record.requestId,
      fence: clone(fence),
      mode,
      payload:
        mode === 'initial'
          ? {
              sourceChoice: command.sourceChoice,
              subtitleTrackId: command.subtitleTrackId,
              sourceSnapshot: clone(command.sourceSnapshot),
              settingsSnapshot: clone(command.settingsSnapshot),
              modelSnapshot: clone(command.modelSnapshot),
            }
          : {
              fromStage: command.fromStage,
              modelSnapshot: clone(command.modelSnapshot),
            },
    })
    slot.acceptTimerId = clock.setTimeout(() => {
      const current = getSlot(fence.owner)
      if (current !== slot || current.state !== 'starting') return
      rejectPending(record, 'VIDEO_SUMMARY_ATTEMPT_ACCEPT_TIMEOUT')
      cancelActive(slot)
    }, WATCHDOG_MS)
    return true
  }

  async function handleStart(context, port, command) {
    const existing = getStartRecord(context.documentId, command.taskId)
    if (existing) {
      const [existingHash, requestHash] = await Promise.all([
        existing.hashPromise,
        hashStartRequest(command),
      ])
      if (existing.requestId !== command.requestId || existingHash !== requestHash) {
        reject(port, 'START_ACK', command, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')
      } else if (existing.state === 'pending') existing.waiters.push(port)
      else sendContent(port, clone(existing.response))
      return
    }
    const documentRecords = startRecords.get(context.documentId)
    if ((documentRecords?.size ?? 0) >= START_RECORD_LIMIT) {
      reject(port, 'START_ACK', command, 'VIDEO_SUMMARY_START_RECORD_LIMIT_EXCEEDED')
      return
    }
    if (countRetained() >= RETAINED_TASK_LIMIT) {
      reject(port, 'START_ACK', command, 'VIDEO_SUMMARY_RETAINED_TASK_LIMIT_EXCEEDED')
      return
    }
    const hashPromise = hashStartRequest(command)
    const record = {
      kind: 'start',
      documentId: context.documentId,
      taskId: command.taskId,
      requestId: command.requestId,
      hashPromise,
      state: 'pending',
      cancellation: null,
      fence: null,
      response: null,
      expiresAt: null,
      waiters: [port],
      expiryTimerId: null,
    }
    setStartRecord(record)
    await hashPromise
    try {
      await ensureOffscreen()
    } catch {
      rejectPending(record, 'VIDEO_SUMMARY_OFFSCREEN_UNAVAILABLE')
      return
    }
    if (
      getStartRecord(context.documentId, command.taskId) !== record ||
      record.state !== 'pending'
    ) {
      return
    }
    if (record.cancellation) {
      commitAttempt({ record, retained: null, command, port, mode: 'initial', fence: null })
      return
    }
    const generation = nextGeneration++
    const fence = {
      owner: clone(context.owner),
      taskId: command.taskId,
      generation,
      attempt: 1,
    }
    const retained = {
      owner: clone(context.owner),
      taskId: command.taskId,
      generation,
      pageIdentity: clone(command.pageIdentity),
      state: 'retained',
      checkpointAvailable: true,
      replayEvent: { type: 'TASK_STARTED', checkpointAvailable: true },
      expiresAt: null,
      retryRecord: null,
      port,
      expiryTimerId: null,
      deleteTimerId: null,
      disconnectTimerId: null,
    }
    commitAttempt({ record, retained, command, port, mode: 'initial', fence })
  }

  function findCancellation(documentId, cancelRequestId) {
    for (const record of startRecords.get(documentId)?.values() ?? []) {
      if (record.cancellation?.cancelRequestId === cancelRequestId) return record
    }
    return null
  }

  function handleCancelStart(context, port, command) {
    const reused = findCancellation(context.documentId, command.cancelRequestId)
    if (reused) {
      if (reused.taskId !== command.taskId || reused.requestId !== command.targetStartRequestId) {
        reject(port, 'START_ACK', command, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')
      } else if (reused.cancellation.response) {
        sendContent(port, clone(reused.cancellation.response))
      }
      return
    }
    const record = getStartRecord(context.documentId, command.taskId)
    if (!record || record.requestId !== command.targetStartRequestId) {
      reject(port, 'START_ACK', command, 'TASK_UNAVAILABLE')
      return
    }
    const cancellation = { cancelRequestId: command.cancelRequestId, response: null, port }
    record.cancellation = cancellation
    if (!record.fence) return
    const response = {
      type: 'CANCEL_START_ACK',
      cancelRequestId: command.cancelRequestId,
      targetStartRequestId: command.targetStartRequestId,
      status: 'cancelling',
      fence: clone(record.fence),
    }
    cancellation.response = response
    record.state = 'cancelling'
    sendToWaiters(record, {
      type: 'START_ACK',
      requestId: record.requestId,
      taskId: record.taskId,
      status: 'cancelling',
      fence: clone(record.fence),
    })
    sendContent(port, clone(response))
    scheduleStartExpiry(record)
    const slot = getSlot(record.fence.owner)
    if (slot && fencesEqual(slot.fence, record.fence)) cancelActive(slot, true)
  }

  function matchingRetained(context, command) {
    if (!validateContext(context, command)) return null
    return getRetained(context.owner, command.taskId, command.generation) ?? null
  }

  function handleAttach(context, port, command) {
    const retained = matchingRetained(context, command)
    if (!retained || retained.state === 'deleting') {
      reject(port, 'ATTACH_ACK', command, 'TASK_UNAVAILABLE')
      return
    }
    clearTimer(retained, 'disconnectTimerId')
    retained.port = port
    const fence = latestFence(retained)
    const slot = getSlot(retained.owner)
    const status = slot
      ? 'active'
      : retained.checkpointAvailable && retained.replayEvent.type === 'TASK_FAILED'
      ? 'retryable'
      : 'terminal'
    sendContent(port, {
      type: 'ATTACH_ACK',
      requestId: command.requestId,
      status,
      fence: clone(fence),
      event: clone(retained.replayEvent),
    })
  }

  async function handleRetry(context, port, command) {
    const retained = matchingRetained(context, command)
    if (!retained || retained.state === 'deleting' || !retained.checkpointAvailable) {
      reject(port, 'RETRY_ACK', command, 'TASK_UNAVAILABLE')
      return
    }
    const requestHash = await hashRetryRequest(command)
    const existing = retained.retryRecord
    if (existing?.requestId === command.requestId) {
      if (existing.requestHash !== requestHash) {
        reject(port, 'RETRY_ACK', command, 'VIDEO_SUMMARY_REQUEST_ID_CONFLICT')
      } else if (existing.state === 'pending') existing.waiters.push(port)
      else sendContent(port, clone(existing.response))
      return
    }
    if (existing?.state === 'pending') {
      reject(port, 'RETRY_ACK', command, 'VIDEO_SUMMARY_RETRY_PENDING')
      return
    }
    if (getSlot(retained.owner)) {
      reject(port, 'RETRY_ACK', command, 'VIDEO_SUMMARY_EXECUTION_BUSY')
      return
    }
    const previousAttempt = existing?.fence?.attempt ?? latestFence(retained)?.attempt ?? 1
    const record = {
      kind: 'retry',
      documentId: context.documentId,
      taskId: command.taskId,
      requestId: command.requestId,
      requestHash,
      state: 'pending',
      response: null,
      cancellation: null,
      fence: null,
      previousAttempt,
      waiters: [port],
    }
    retained.retryRecord = record
    try {
      await ensureOffscreen()
    } catch {
      rejectPending(record, 'VIDEO_SUMMARY_OFFSCREEN_UNAVAILABLE')
      return
    }
    if (retained.retryRecord !== record || record.state !== 'pending') return
    const fence = {
      owner: clone(retained.owner),
      taskId: retained.taskId,
      generation: retained.generation,
      attempt: record.previousAttempt + 1,
    }
    commitAttempt({ record, retained, command, port, mode: 'retry-summary', fence })
  }

  function handleCancelTask(context, command) {
    const retained = matchingRetained(context, command)
    if (!retained || retained.state === 'deleting') return
    const slot = getSlot(retained.owner)
    if (
      slot &&
      slot.fence.taskId === retained.taskId &&
      slot.fence.generation === retained.generation
    ) {
      cancelActive(slot, true)
    } else beginDelete(retained)
  }

  async function handleContentCommand({ context, port, command: value }) {
    let command
    try {
      command = parseContentCommand(value)
    } catch {
      return
    }
    if (!validateContext(context, command)) return
    if (command.type === 'START_TASK') await handleStart(context, port, command)
    else if (command.type === 'CANCEL_START') handleCancelStart(context, port, command)
    else if (command.type === 'ATTACH_TASK') handleAttach(context, port, command)
    else if (command.type === 'RETRY_TASK') await handleRetry(context, port, command)
    else if (command.type === 'CANCEL_TASK') handleCancelTask(context, command)
    else {
      const retained = matchingRetained(context, command)
      const slot = retained && getSlot(retained.owner)
      if (slot) sendOffscreen(clone(command))
    }
  }

  function accepted(message) {
    const slot = getSlot(message.fence.owner)
    if (
      !slot ||
      slot.state !== 'starting' ||
      !fencesEqual(slot.fence, message.fence) ||
      slot.fence.taskId !== message.fence.taskId
    ) {
      return
    }
    const retained = getRetained(
      message.fence.owner,
      message.fence.taskId,
      message.fence.generation,
    )
    const startRecord = getStartRecord(message.fence.owner.documentId, message.fence.taskId)
    const record = message.fence.attempt === 1 ? startRecord : retained?.retryRecord
    if (!record || record.requestId !== message.requestId || record.state !== 'pending') return
    clearTimer(slot, 'acceptTimerId')
    if (record.cancellation || startRecord?.cancellation) {
      cancelActive(slot, true)
      return
    }
    const capability = getCapability(message.fence)
    if (!capability || capability.revoked) {
      cancelActive(slot)
      return
    }
    slot.state = 'running'
    const response = {
      type: record.kind === 'start' ? 'START_ACK' : 'RETRY_ACK',
      requestId: record.requestId,
      taskId: record.taskId,
      status: 'started',
      fence: clone(message.fence),
    }
    record.state = 'started'
    sendOffscreen({
      type: 'ATTEMPT_AUTHORIZED',
      requestId: message.requestId,
      fence: clone(message.fence),
    })
    sendToWaiters(record, response)
    if (record.kind === 'start') scheduleStartExpiry(record)
  }

  function rejectedAttempt(message) {
    const slot = getSlot(message.fence.owner)
    if (!slot || !fencesEqual(slot.fence, message.fence)) return
    clearTimer(slot, 'acceptTimerId')
    clearTimer(slot, 'releaseTimerId')
    deleteSlot(message.fence.owner)
    revokeAttemptModelCapability(message.fence)
    const retained = getRetained(
      message.fence.owner,
      message.fence.taskId,
      message.fence.generation,
    )
    const record =
      message.fence.attempt === 1
        ? getStartRecord(message.fence.owner.documentId, message.fence.taskId)
        : retained?.retryRecord
    if (record?.state === 'pending') rejectPending(record, message.errorCode)
    if (retained) {
      if (message.fence.attempt === 1) {
        storeReplay(retained, createFailureEvent(message.errorCode))
      }
      scheduleRetainedExpiry(retained)
    }
  }

  function taskEvent(message) {
    const slot = getSlot(message.fence.owner)
    if (!slot || !fencesEqual(slot.fence, message.fence)) return
    const retained = getRetained(
      message.fence.owner,
      message.fence.taskId,
      message.fence.generation,
    )
    if (!retained) return
    const event = storeReplay(retained, message.event)
    if (isTerminalEvent(event)) {
      revokeAttemptModelCapability(message.fence)
      startReleaseWatchdog(slot)
    }
    if (retained.port) {
      sendContent(retained.port, {
        type: 'TASK_EVENT',
        fence: clone(message.fence),
        event: clone(event),
      })
    }
  }

  function executionReleased(message) {
    const slot = getSlot(message.fence.owner)
    if (!slot || !fencesEqual(slot.fence, message.fence)) return
    clearTimer(slot, 'acceptTimerId')
    clearTimer(slot, 'releaseTimerId')
    deleteSlot(message.fence.owner)
    revokeAttemptModelCapability(message.fence)
    sendOffscreen({ type: 'EXECUTION_RELEASED_ACK', fence: clone(message.fence) })
    const retained = getRetained(
      message.fence.owner,
      message.fence.taskId,
      message.fence.generation,
    )
    if (!retained) return
    if (slot.deleteAfterRelease) beginDelete(retained)
    else scheduleRetainedExpiry(retained)
  }

  function taskDeleted(message) {
    const retained = getRetained(message.owner, message.taskId, message.generation)
    if (!retained || retained.state !== 'deleting') return
    clearRetained(retained)
  }

  function handleOffscreenMessage(value) {
    let message
    try {
      message = parseOffscreenMessage(value)
    } catch {
      return
    }
    if (message.type === 'ATTEMPT_ACCEPTED') accepted(message)
    else if (message.type === 'ATTEMPT_REJECTED') rejectedAttempt(message)
    else if (message.type === 'TASK_EVENT') taskEvent(message)
    else if (message.type === 'EXECUTION_RELEASED') executionReleased(message)
    else if (message.type === 'TASK_DELETED') taskDeleted(message)
    else if (message.type === 'SOURCE_REFRESH_REQUEST') {
      const retained = getRetained(
        message.fence.owner,
        message.fence.taskId,
        message.fence.generation,
      )
      const capability = getCapability(message.fence)
      const slot = getSlot(message.fence.owner)
      if (
        !retained?.port ||
        !capability ||
        capability.revoked ||
        !slot ||
        !fencesEqual(slot.fence, message.fence)
      ) {
        return false
      }
      sendContent(retained.port, clone(message))
      return true
    }
    return true
  }

  function scheduleDisconnect(record) {
    clearTimer(record, 'disconnectTimerId')
    record.disconnectTimerId = clock.setTimeout(() => {
      const current = getRetained(record.owner, record.taskId, record.generation)
      if (current !== record || record.port) return
      const slot = getSlot(record.owner)
      if (
        slot &&
        slot.fence.taskId === record.taskId &&
        slot.fence.generation === record.generation
      ) {
        cancelActive(slot, true)
      } else beginDelete(record)
    }, DISCONNECT_GRACE_MS)
  }

  function handleContentDisconnect({ context, port }) {
    for (const record of valuesNested(retainedTasks, 6)) {
      if (!ownersEqual(record.owner, context.owner) || record.port !== port) continue
      record.port = null
      scheduleDisconnect(record)
    }
  }

  function handleTabRemoved(tabId) {
    for (const record of valuesNested(retainedTasks, 6)) {
      if (record.owner.tabId !== tabId) continue
      clearTimer(record, 'disconnectTimerId')
      record.port = null
      const slot = getSlot(record.owner)
      if (
        slot &&
        slot.fence.taskId === record.taskId &&
        slot.fence.generation === record.generation
      ) {
        cancelActive(slot, true)
      } else beginDelete(record)
    }
  }

  function handleOffscreenDisconnect() {
    cleanupRuntimeState()
  }

  function debugState() {
    const slots = valuesNested(activeSlots, 2)
      .map((slot) => ({
        key: [slot.fence.owner.tabId, slot.fence.owner.platform],
        state: slot.state,
        fence: clone(slot.fence),
        pageIdentity: clone(slot.pageIdentity),
      }))
      .sort((left, right) => JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)))
    const retained = valuesNested(retainedTasks, 6)
      .map((record) => ({
        owner: clone(record.owner),
        taskId: record.taskId,
        generation: record.generation,
        pageIdentity: clone(record.pageIdentity),
        state: record.state,
        checkpointAvailable: record.checkpointAvailable,
        replayEvent: clone(record.replayEvent),
        expiresAt: record.expiresAt,
        retryRecord: record.retryRecord
          ? {
              requestId: record.retryRecord.requestId,
              requestHash: record.retryRecord.requestHash,
              state: record.retryRecord.state,
              response: clone(record.retryRecord.response),
            }
          : null,
      }))
      .sort((left, right) => left.generation - right.generation)
    const starts = valuesNested(startRecords, 2)
      .map((record) => ({
        documentId: record.documentId,
        taskId: record.taskId,
        requestId: record.requestId,
        state: record.state,
        cancellation: record.cancellation
          ? {
              cancelRequestId: record.cancellation.cancelRequestId,
              response: clone(record.cancellation.response),
            }
          : null,
        fence: clone(record.fence),
        response: clone(record.response),
        expiresAt: record.expiresAt,
      }))
      .sort((left, right) =>
        `${left.documentId}\0${left.taskId}`.localeCompare(`${right.documentId}\0${right.taskId}`),
      )
    const capabilityList = valuesNested(capabilities, 6)
      .map((capability) => clone(capability))
      .sort((left, right) => left.generation - right.generation)
    return clone({
      activeSlots: slots,
      retainedTasks: retained,
      startRecords: starts,
      capabilities: capabilityList,
      nextGeneration,
    })
  }

  return {
    handleContentCommand,
    handleOffscreenMessage,
    handleContentDisconnect,
    handleTabRemoved,
    handleOffscreenDisconnect,
    authorizeGatewayRequest,
    completeGatewayRequest,
    debugState,
  }
}
