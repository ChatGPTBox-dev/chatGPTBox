import { VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS } from './contracts.mjs'

const MiB = 1024 * 1024

export const VIDEO_SUMMARY_PROTOCOL_LIMITS = Object.freeze({
  idCodeUnits: 128,
  titleCodeUnits: 1_000,
  labelCodeUnits: 1_000,
  cueTextCodeUnits: 20_000,
  subtitleCues: 20_000,
  subtitleBytes: 16 * MiB,
  mediaCandidates: 16,
  uploadHeaders: 32,
  uploadHeaderCodeUnits: 256,
  contentCommandBytes: 24 * MiB,
  pendingRpcsPerTask: 16,
})

export const VIDEO_SUMMARY_CONTENT_COMMAND_TYPES = Object.freeze([
  'START_TASK',
  'CANCEL_START',
  'ATTACH_TASK',
  'CANCEL_TASK',
  'RETRY_TASK',
  'SOURCE_REFRESH_RESULT',
])

export const VIDEO_SUMMARY_CONTENT_MESSAGE_TYPES = Object.freeze([
  'START_ACK',
  'CANCEL_START_ACK',
  'ATTACH_ACK',
  'RETRY_ACK',
  'TASK_EVENT',
  'SOURCE_REFRESH_REQUEST',
])

export const VIDEO_SUMMARY_OFFSCREEN_COMMAND_TYPES = Object.freeze([
  'START_ATTEMPT',
  'ATTEMPT_AUTHORIZED',
  'CANCEL_TASK',
  'EXECUTION_RELEASED_ACK',
  'DELETE_TASK',
  'SOURCE_REFRESH_RESULT',
  'GATEWAY_RESPONSE',
])

export const VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES = Object.freeze([
  'ATTEMPT_ACCEPTED',
  'ATTEMPT_REJECTED',
  'TASK_EVENT',
  'EXECUTION_RELEASED',
  'TASK_DELETED',
  'SOURCE_REFRESH_REQUEST',
  'GATEWAY_REQUEST',
  'CANCEL_GATEWAY_REQUEST',
])

const platforms = new Set(['bilibili', 'youtube'])
const retryStages = new Set(['summarizing', 'synthesis'])
const eventFields = [
  'type',
  'stage',
  'checkpointAvailable',
  'completedChunks',
  'totalChunks',
  'result',
  'errorCode',
  'message',
]

function fail(code) {
  throw new Error(code)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function object(value) {
  if (!isPlainObject(value)) fail('VIDEO_SUMMARY_PROTOCOL_OBJECT_REQUIRED')
  return value
}

function exact(value, fields) {
  object(value)
  const allowed = new Set(fields)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED')
  }
  return value
}

function required(value, fields) {
  for (const field of fields) {
    if (!(field in value)) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_REQUIRED')
  }
}

function text(value, maximum = VIDEO_SUMMARY_PROTOCOL_LIMITS.idCodeUnits, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  if (value.length > maximum) fail('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  return value
}

function integer(value, positive = false) {
  if (!Number.isSafeInteger(value) || (positive && value <= 0)) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  return value
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('VIDEO_SUMMARY_GENERATION_INVALID')
  return value
}

function attempt(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('VIDEO_SUMMARY_ATTEMPT_INVALID')
  return value
}

function boolean(value) {
  if (typeof value !== 'boolean') fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  return value
}

function oneOf(value, choices) {
  if (!choices.includes(value)) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  return value
}

function clone(value) {
  try {
    return structuredClone(value)
  } catch {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
}

export function createPageIdentity(value) {
  exact(value, ['platform', 'videoId', 'mediaId'])
  required(value, ['platform', 'videoId', 'mediaId'])
  if (!platforms.has(value.platform)) fail('VIDEO_SUMMARY_PLATFORM_INVALID')
  return {
    platform: value.platform,
    videoId: text(value.videoId),
    mediaId: text(value.mediaId),
  }
}

export function parsePageIdentity(value) {
  return createPageIdentity(value)
}

export function pageIdentitiesEqual(left, right) {
  try {
    const a = parsePageIdentity(left)
    const b = parsePageIdentity(right)
    return a.platform === b.platform && a.videoId === b.videoId && a.mediaId === b.mediaId
  } catch {
    return false
  }
}

export function createVideoSummaryOwner(value) {
  exact(value, ['tabId', 'documentId', 'platform', 'mediaId'])
  required(value, ['tabId', 'documentId', 'platform', 'mediaId'])
  if (!platforms.has(value.platform)) fail('VIDEO_SUMMARY_PLATFORM_INVALID')
  return {
    tabId: integer(value.tabId),
    documentId: text(value.documentId),
    platform: value.platform,
    mediaId: text(value.mediaId),
  }
}

function parseOwner(value) {
  return createVideoSummaryOwner(value)
}

export function ownersEqual(left, right) {
  try {
    const a = parseOwner(left)
    const b = parseOwner(right)
    return (
      a.tabId === b.tabId &&
      a.documentId === b.documentId &&
      a.platform === b.platform &&
      a.mediaId === b.mediaId
    )
  } catch {
    return false
  }
}

export function createTaskFence(value) {
  exact(value, ['owner', 'taskId', 'generation', 'attempt'])
  required(value, ['owner', 'taskId', 'generation', 'attempt'])
  return {
    owner: parseOwner(value.owner),
    taskId: text(value.taskId),
    generation: generation(value.generation),
    attempt: attempt(value.attempt),
  }
}

function parseFence(value) {
  return createTaskFence(value)
}

export function fencesEqual(left, right) {
  try {
    const a = parseFence(left)
    const b = parseFence(right)
    return (
      ownersEqual(a.owner, b.owner) &&
      a.taskId === b.taskId &&
      a.generation === b.generation &&
      a.attempt === b.attempt
    )
  } catch {
    return false
  }
}

function validateLoosePlainObject(value) {
  object(value)
  return clone(value)
}

function parseCue(value) {
  exact(value, ['startMs', 'endMs', 'text'])
  required(value, ['startMs', 'endMs', 'text'])
  if (!Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  return {
    startMs: value.startMs,
    endMs: value.endMs,
    text: text(value.text, VIDEO_SUMMARY_PROTOCOL_LIMITS.cueTextCodeUnits, true),
  }
}

function parseSubtitleTrack(value, counters) {
  exact(value, ['id', 'language', 'label', 'sourceKind', 'cues'])
  required(value, ['id', 'language', 'label', 'sourceKind', 'cues'])
  if (!Array.isArray(value.cues)) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  counters.cues += value.cues.length
  if (counters.cues > VIDEO_SUMMARY_PROTOCOL_LIMITS.subtitleCues) {
    fail('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  }
  const cues = value.cues.map(parseCue)
  for (const cue of cues) counters.subtitleText += cue.text
  return {
    id: text(value.id),
    language: text(value.language),
    label: text(value.label, VIDEO_SUMMARY_PROTOCOL_LIMITS.labelCodeUnits),
    sourceKind: text(value.sourceKind),
    cues,
  }
}

function validateHeaders(headers) {
  object(headers)
  const entries = Object.entries(headers)
  if (entries.length > VIDEO_SUMMARY_PROTOCOL_LIMITS.uploadHeaders) {
    fail('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  }
  for (const [key, value] of entries) {
    text(key, VIDEO_SUMMARY_PROTOCOL_LIMITS.uploadHeaderCodeUnits)
    text(value, VIDEO_SUMMARY_PROTOCOL_LIMITS.uploadHeaderCodeUnits, true)
  }
}

function inspectHeaders(value) {
  if (Array.isArray(value)) {
    for (const item of value) inspectHeaders(item)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'headers') validateHeaders(child)
    else inspectHeaders(child)
  }
}

function parseMediaCandidate(value) {
  exact(value, ['id', 'mediaMetadata', 'remoteCandidate', 'localFetchRecipe'])
  required(value, ['id', 'mediaMetadata', 'remoteCandidate', 'localFetchRecipe'])
  text(value.id)
  validateLoosePlainObject(value.mediaMetadata)
  if (value.remoteCandidate !== null) validateLoosePlainObject(value.remoteCandidate)
  if (value.localFetchRecipe !== null) validateLoosePlainObject(value.localFetchRecipe)
  inspectHeaders(value)
  return clone(value)
}

function parseSourceSnapshot(value) {
  exact(value, [
    'pageIdentity',
    'title',
    'durationMs',
    'nativeSubtitleTracks',
    'subtitleDiscovery',
    'mediaCandidates',
  ])
  required(value, [
    'pageIdentity',
    'title',
    'durationMs',
    'nativeSubtitleTracks',
    'mediaCandidates',
  ])
  if (!Array.isArray(value.nativeSubtitleTracks) || !Array.isArray(value.mediaCandidates)) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  if (value.mediaCandidates.length > VIDEO_SUMMARY_PROTOCOL_LIMITS.mediaCandidates) {
    fail('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  }
  const counters = { cues: 0, subtitleText: '' }
  const snapshot = {
    pageIdentity: parsePageIdentity(value.pageIdentity),
    title: text(value.title, VIDEO_SUMMARY_PROTOCOL_LIMITS.titleCodeUnits, true),
    durationMs: value.durationMs,
    nativeSubtitleTracks: value.nativeSubtitleTracks.map((track) =>
      parseSubtitleTrack(track, counters),
    ),
    mediaCandidates: value.mediaCandidates.map(parseMediaCandidate),
  }
  if (!Number.isFinite(snapshot.durationMs) || snapshot.durationMs < 0) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  if ('subtitleDiscovery' in value)
    snapshot.subtitleDiscovery = validateLoosePlainObject(value.subtitleDiscovery)
  if (
    new TextEncoder().encode(counters.subtitleText).byteLength >
    VIDEO_SUMMARY_PROTOCOL_LIMITS.subtitleBytes
  ) {
    fail('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  }
  return snapshot
}

function parseTaskEvent(value) {
  exact(value, eventFields)
  required(value, ['type'])
  text(value.type)
  for (const field of ['stage', 'errorCode']) if (field in value) text(value[field])
  if ('message' in value) text(value.message, VIDEO_SUMMARY_PROTOCOL_LIMITS.titleCodeUnits, true)
  if ('checkpointAvailable' in value) boolean(value.checkpointAvailable)
  for (const field of ['completedChunks', 'totalChunks']) if (field in value) integer(value[field])
  if ('result' in value) clone(value.result)
  return clone(value)
}

function validateContentAggregate(value) {
  if (measureSerializedBytes(value) > VIDEO_SUMMARY_PROTOCOL_LIMITS.contentCommandBytes) {
    fail('VIDEO_SUMMARY_PROTOCOL_LIMIT_EXCEEDED')
  }
}

function parseContentStart(value) {
  exact(value, [
    'type',
    'requestId',
    'taskId',
    'pageIdentity',
    'sourceChoice',
    'subtitleTrackId',
    'sourceSnapshot',
    'settingsSnapshot',
    'modelSnapshot',
  ])
  required(value, [
    'type',
    'requestId',
    'taskId',
    'pageIdentity',
    'sourceChoice',
    'sourceSnapshot',
    'settingsSnapshot',
    'modelSnapshot',
  ])
  const parsed = {
    type: value.type,
    requestId: text(value.requestId),
    taskId: text(value.taskId),
    pageIdentity: parsePageIdentity(value.pageIdentity),
    sourceChoice: oneOf(value.sourceChoice, ['native-subtitle', 'asr']),
    sourceSnapshot: parseSourceSnapshot(value.sourceSnapshot),
    settingsSnapshot: validateLoosePlainObject(value.settingsSnapshot),
    modelSnapshot: validateLoosePlainObject(value.modelSnapshot),
  }
  if ('subtitleTrackId' in value) parsed.subtitleTrackId = text(value.subtitleTrackId)
  if (!pageIdentitiesEqual(parsed.pageIdentity, parsed.sourceSnapshot.pageIdentity)) {
    fail('VIDEO_SUMMARY_PAGE_IDENTITY_MISMATCH')
  }
  return parsed
}

function parseRefreshResult(value) {
  exact(value, [
    'type',
    'requestId',
    'taskId',
    'generation',
    'pageIdentity',
    'pageGeneration',
    'sourceSnapshot',
    'errorCode',
  ])
  required(value, ['type', 'requestId', 'taskId', 'generation', 'pageIdentity', 'pageGeneration'])
  if ('sourceSnapshot' in value === 'errorCode' in value) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  const parsed = {
    type: value.type,
    requestId: text(value.requestId),
    taskId: text(value.taskId),
    generation: generation(value.generation),
    pageIdentity: parsePageIdentity(value.pageIdentity),
    pageGeneration: integer(value.pageGeneration),
  }
  if ('sourceSnapshot' in value) {
    parsed.sourceSnapshot = parseSourceSnapshot(value.sourceSnapshot)
    if (!pageIdentitiesEqual(parsed.pageIdentity, parsed.sourceSnapshot.pageIdentity)) {
      fail('VIDEO_SUMMARY_PAGE_IDENTITY_MISMATCH')
    }
  } else parsed.errorCode = text(value.errorCode)
  return parsed
}

export function parseContentCommand(value) {
  object(value)
  if (!VIDEO_SUMMARY_CONTENT_COMMAND_TYPES.includes(value.type)) {
    fail('VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED')
  }
  let parsed
  if (value.type === 'START_TASK') parsed = parseContentStart(value)
  else if (value.type === 'CANCEL_START') {
    exact(value, ['type', 'cancelRequestId', 'targetStartRequestId', 'taskId', 'pageIdentity'])
    required(value, ['type', 'cancelRequestId', 'targetStartRequestId', 'taskId', 'pageIdentity'])
    parsed = {
      type: value.type,
      cancelRequestId: text(value.cancelRequestId),
      targetStartRequestId: text(value.targetStartRequestId),
      taskId: text(value.taskId),
      pageIdentity: parsePageIdentity(value.pageIdentity),
    }
  } else if (value.type === 'ATTACH_TASK') {
    exact(value, ['type', 'requestId', 'taskId', 'generation', 'pageIdentity'])
    required(value, ['type', 'requestId', 'taskId', 'generation', 'pageIdentity'])
    parsed = {
      type: value.type,
      requestId: text(value.requestId),
      taskId: text(value.taskId),
      generation: generation(value.generation),
      pageIdentity: parsePageIdentity(value.pageIdentity),
    }
  } else if (value.type === 'CANCEL_TASK') {
    exact(value, ['type', 'taskId', 'generation', 'pageIdentity'])
    required(value, ['type', 'taskId', 'generation', 'pageIdentity'])
    parsed = {
      type: value.type,
      taskId: text(value.taskId),
      generation: generation(value.generation),
      pageIdentity: parsePageIdentity(value.pageIdentity),
    }
  } else if (value.type === 'RETRY_TASK') {
    exact(value, [
      'type',
      'requestId',
      'taskId',
      'generation',
      'pageIdentity',
      'fromStage',
      'modelSnapshot',
    ])
    required(value, [
      'type',
      'requestId',
      'taskId',
      'generation',
      'pageIdentity',
      'fromStage',
      'modelSnapshot',
    ])
    parsed = {
      type: value.type,
      requestId: text(value.requestId),
      taskId: text(value.taskId),
      generation: generation(value.generation),
      pageIdentity: parsePageIdentity(value.pageIdentity),
      fromStage: oneOf(value.fromStage, [...retryStages]),
      modelSnapshot: validateLoosePlainObject(value.modelSnapshot),
    }
  } else parsed = parseRefreshResult(value)
  validateContentAggregate(parsed)
  return clone(parsed)
}

function parseAck(value, statuses, policy) {
  exact(value, policy.fields)
  required(value, policy.required)
  const status = oneOf(value.status, statuses)
  const parsed = { type: value.type }
  for (const key of policy.required) {
    if (key !== 'type' && key !== 'status') parsed[key] = text(value[key])
  }
  parsed.status = status
  const requirements = policy.byStatus[status] || {}
  for (const field of ['fence', 'event', 'errorCode']) {
    const present = field in value
    if (requirements[field] === true && !present) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_REQUIRED')
    if (requirements[field] !== true && present) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_UNSUPPORTED')
    if (present) {
      parsed[field] =
        field === 'fence'
          ? parseFence(value[field])
          : field === 'event'
          ? parseTaskEvent(value[field])
          : text(value[field])
    }
  }
  return parsed
}

function parseSourceRefreshRequest(value) {
  exact(value, ['type', 'requestId', 'fence', 'expectedPageIdentity', 'reason'])
  required(value, ['type', 'requestId', 'fence', 'expectedPageIdentity', 'reason'])
  return {
    type: value.type,
    requestId: text(value.requestId),
    fence: parseFence(value.fence),
    expectedPageIdentity: parsePageIdentity(value.expectedPageIdentity),
    reason: text(value.reason),
  }
}

export function parseContentMessage(value) {
  object(value)
  if (!VIDEO_SUMMARY_CONTENT_MESSAGE_TYPES.includes(value.type)) {
    fail('VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED')
  }
  let parsed
  if (value.type === 'START_ACK' || value.type === 'RETRY_ACK') {
    parsed = parseAck(
      value,
      ['started', 'cancelled', ...(value.type === 'START_ACK' ? ['cancelling'] : []), 'rejected'],
      {
        fields: ['type', 'requestId', 'taskId', 'status', 'fence', 'errorCode'],
        required: ['type', 'requestId', 'taskId', 'status'],
        byStatus: {
          started: { fence: true },
          cancelling: { fence: true },
          rejected: { errorCode: true },
        },
      },
    )
  } else if (value.type === 'CANCEL_START_ACK') {
    parsed = parseAck(value, ['cancelled', 'cancelling'], {
      fields: ['type', 'cancelRequestId', 'targetStartRequestId', 'status', 'fence'],
      required: ['type', 'cancelRequestId', 'targetStartRequestId', 'status'],
      byStatus: { cancelling: { fence: true } },
    })
  } else if (value.type === 'ATTACH_ACK') {
    parsed = parseAck(value, ['active', 'retryable', 'terminal', 'not-found'], {
      fields: ['type', 'requestId', 'status', 'fence', 'event', 'errorCode'],
      required: ['type', 'requestId', 'status'],
      byStatus: {
        active: { fence: true, event: true },
        retryable: { fence: true, event: true },
        terminal: { fence: true, event: true },
        'not-found': { errorCode: true },
      },
    })
  } else if (value.type === 'TASK_EVENT') {
    exact(value, ['type', 'fence', 'event'])
    required(value, ['type', 'fence', 'event'])
    parsed = {
      type: value.type,
      fence: parseFence(value.fence),
      event: parseTaskEvent(value.event),
    }
  } else parsed = parseSourceRefreshRequest(value)
  return clone(parsed)
}

function parseDelete(value) {
  exact(value, ['type', 'owner', 'taskId', 'generation'])
  required(value, ['type', 'owner', 'taskId', 'generation'])
  return {
    type: value.type,
    owner: parseOwner(value.owner),
    taskId: text(value.taskId),
    generation: generation(value.generation),
  }
}

function parseGatewayResponse(value) {
  exact(value, ['type', 'requestId', 'fence', 'ok', 'result', 'error'])
  required(value, ['type', 'requestId', 'fence', 'ok'])
  boolean(value.ok)
  if (
    value.ok ? !('result' in value) || 'error' in value : !('error' in value) || 'result' in value
  ) {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  const parsed = {
    type: value.type,
    requestId: text(value.requestId),
    fence: parseFence(value.fence),
    ok: value.ok,
  }
  if (value.ok) parsed.result = clone(value.result)
  else parsed.error = clone(value.error)
  inspectHeaders(parsed)
  return parsed
}

export function parseOffscreenCommand(value) {
  object(value)
  if (!VIDEO_SUMMARY_OFFSCREEN_COMMAND_TYPES.includes(value.type)) {
    fail('VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED')
  }
  let parsed
  if (value.type === 'START_ATTEMPT') {
    exact(value, ['type', 'requestId', 'fence', 'mode', 'payload'])
    required(value, ['type', 'requestId', 'fence', 'mode', 'payload'])
    parsed = {
      type: value.type,
      requestId: text(value.requestId),
      fence: parseFence(value.fence),
      mode: oneOf(value.mode, ['initial', 'retry-summary']),
      payload: validateLoosePlainObject(value.payload),
    }
  } else if (value.type === 'ATTEMPT_AUTHORIZED') {
    exact(value, ['type', 'requestId', 'fence'])
    required(value, ['type', 'requestId', 'fence'])
    parsed = { type: value.type, requestId: text(value.requestId), fence: parseFence(value.fence) }
  } else if (value.type === 'CANCEL_TASK' || value.type === 'EXECUTION_RELEASED_ACK') {
    exact(value, ['type', 'fence'])
    required(value, ['type', 'fence'])
    parsed = { type: value.type, fence: parseFence(value.fence) }
  } else if (value.type === 'DELETE_TASK') parsed = parseDelete(value)
  else if (value.type === 'SOURCE_REFRESH_RESULT') parsed = parseRefreshResult(value)
  else parsed = parseGatewayResponse(value)
  return clone(parsed)
}

function parseGatewayCancellation(value) {
  exact(value, ['type', 'requestId', 'fence'])
  required(value, ['type', 'requestId', 'fence'])
  return {
    type: value.type,
    requestId: text(value.requestId),
    fence: parseFence(value.fence),
  }
}

function parseGatewayRequest(value) {
  exact(value, ['type', 'requestId', 'fence', 'gateway', 'operation', 'args'])
  required(value, ['type', 'requestId', 'fence', 'gateway', 'operation', 'args'])
  const parsed = {
    type: value.type,
    requestId: text(value.requestId),
    fence: parseFence(value.fence),
    gateway: oneOf(value.gateway, Object.keys(VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS)),
    operation: text(value.operation),
    args: validateLoosePlainObject(value.args),
  }
  if (!VIDEO_SUMMARY_OFFSCREEN_GATEWAY_OPERATIONS[parsed.gateway].includes(parsed.operation)) {
    fail('VIDEO_SUMMARY_GATEWAY_OPERATION_UNSUPPORTED')
  }
  inspectHeaders(parsed.args)
  return parsed
}

export function parseOffscreenMessage(value) {
  object(value)
  if (!VIDEO_SUMMARY_OFFSCREEN_MESSAGE_TYPES.includes(value.type)) {
    fail('VIDEO_SUMMARY_PROTOCOL_TYPE_UNSUPPORTED')
  }
  let parsed
  if (value.type === 'ATTEMPT_ACCEPTED' || value.type === 'ATTEMPT_REJECTED') {
    const fields = [
      'type',
      'requestId',
      'fence',
      ...(value.type === 'ATTEMPT_REJECTED' ? ['errorCode'] : []),
    ]
    exact(value, fields)
    required(value, fields)
    parsed = { type: value.type, requestId: text(value.requestId), fence: parseFence(value.fence) }
    if ('errorCode' in value) parsed.errorCode = text(value.errorCode)
  } else if (value.type === 'TASK_EVENT') {
    exact(value, ['type', 'fence', 'event'])
    required(value, ['type', 'fence', 'event'])
    parsed = {
      type: value.type,
      fence: parseFence(value.fence),
      event: parseTaskEvent(value.event),
    }
  } else if (value.type === 'EXECUTION_RELEASED') {
    exact(value, ['type', 'fence'])
    required(value, ['type', 'fence'])
    parsed = { type: value.type, fence: parseFence(value.fence) }
  } else if (value.type === 'TASK_DELETED') parsed = parseDelete(value)
  else if (value.type === 'SOURCE_REFRESH_REQUEST') parsed = parseSourceRefreshRequest(value)
  else if (value.type === 'CANCEL_GATEWAY_REQUEST') parsed = parseGatewayCancellation(value)
  else parsed = parseGatewayRequest(value)
  return clone(parsed)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isPlainObject(value)) return value
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key])
  }
  return result
}

async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hashStartRequest({
  pageIdentity,
  sourceChoice,
  subtitleTrackId,
  sourceSnapshot,
  settingsSnapshot,
  modelSnapshot,
}) {
  return hash({
    pageIdentity,
    sourceChoice,
    subtitleTrackId,
    sourceSnapshot,
    settingsSnapshot,
    modelSnapshot,
  })
}

export function hashRetryRequest({ fromStage, modelSnapshot }) {
  return hash({ fromStage, modelSnapshot })
}

export function measureSerializedBytes(value) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  }
  if (serialized === undefined) fail('VIDEO_SUMMARY_PROTOCOL_FIELD_INVALID')
  return new TextEncoder().encode(serialized).byteLength
}
