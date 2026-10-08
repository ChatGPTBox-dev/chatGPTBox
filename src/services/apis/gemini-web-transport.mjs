import { buildRequest, decodeEnvelopes, protocolError } from '../clients/gemini-web/protocol.mjs'

const ORIGIN = 'https://gemini.google.com'
const GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
const BATCH_EXEC_PATH = '/_/BardChatUi/data/batchexecute'
const MODEL_STATUS_RPC = 'otAQ7b'
const MODEL_HEADER_KEY = 'x-goog-ext-525001261-jspb'
const RESPONSE_LIMIT = 16 * 1024 * 1024
const THINKING_MODE_NUMBER = 5
const THINKING_MODEL_IDS = new Map([
  [1, '5bf011840784117a'],
  [2, 'e051ce1aa80aa576'],
  [4, 'e051ce1aa80aa576'],
])

export function getAbortReason(signal) {
  return signal.reason === undefined
    ? new DOMException('The operation was aborted.', 'AbortError')
    : signal.reason
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw getAbortReason(signal)
}

function throwIfSuperseded(isRequestCurrent) {
  if (typeof isRequestCurrent !== 'function' || isRequestCurrent()) return
  throw new DOMException('The operation was superseded.', 'AbortError')
}

function accountUrl(accountPath = '', path) {
  if (typeof accountPath !== 'string' || (accountPath !== '' && !/^\/u\/\d+$/.test(accountPath))) {
    throw protocolError('Invalid Google account route. Start a new conversation.')
  }
  return `${ORIGIN}${accountPath}${path}`
}

function pageField(html, name) {
  const value = html.match(new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`))?.[1]
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw protocolError('Invalid website session data.')
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the original HTTP/protocol error if stream cleanup also fails.
  }
}

async function readResponse(response, signal) {
  if (!response.ok) {
    await discardBody(response)
    throw protocolError(`HTTP ${response.status}. Check your login and limits on Gemini.`)
  }
  if (response.url && new URL(response.url).origin !== ORIGIN) {
    await discardBody(response)
    throw protocolError('Sign in to Gemini in this browser profile before trying again.')
  }
  if (!response.body) throw protocolError('Empty website response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const pieces = []
  let size = 0
  let finished = false
  try {
    for (;;) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        break
      }
      size += value.byteLength
      if (size > RESPONSE_LIMIT) throw protocolError('Website response is too large.')
      pieces.push(decoder.decode(value, { stream: true }))
    }
    pieces.push(decoder.decode())
    throwIfAborted(signal)
    return pieces.join('')
  } finally {
    if (!finished) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the original error.
      }
    }
    reader.releaseLock()
  }
}

export async function getGeminiRequestParams(signal, expectedAccountPath) {
  const initUrl = accountUrl(expectedAccountPath, '/app')
  throwIfAborted(signal)
  const response = await fetch(initUrl, {
    credentials: 'include',
    cache: 'no-store',
    signal,
  })
  const html = await readResponse(response, signal)
  const accountPath =
    new URL(response.url || initUrl).pathname.match(/^\/u\/\d+(?=\/|$)/)?.[0] || ''
  if (expectedAccountPath !== undefined && accountPath !== expectedAccountPath) {
    throw protocolError('The Google account route changed. Start a new conversation.')
  }
  const at = pageField(html, 'SNlM0e')
  if (!at) {
    throw protocolError('Sign in to Gemini in this browser profile before trying again.')
  }
  return {
    at,
    accountPath,
    bl: pageField(html, 'cfb2h'),
    sessionId: pageField(html, 'FdrFJe'),
    language: pageField(html, 'TuX5cc') || 'en',
  }
}

export function createGeminiRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toUpperCase()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
    .join('-')
    .toUpperCase()
}

function parseJsonString(value, message) {
  if (typeof value !== 'string') throw protocolError(message)
  try {
    return JSON.parse(value)
  } catch {
    throw protocolError(message)
  }
}

function integer(value) {
  return Number.isInteger(value) ? value : undefined
}

function computeModelCapacity(tierFlags, capabilityFlags) {
  const tiers = Array.isArray(tierFlags) ? tierFlags : []
  const capabilities = Array.isArray(capabilityFlags) ? capabilityFlags : []
  if (tiers.includes(21)) return { capacity: 1, capacityField: 13 }
  if (tiers.includes(22)) return { capacity: 2, capacityField: 13 }
  if (capabilities.includes(115)) return { capacity: 4, capacityField: 12 }
  if (tiers.includes(16) || capabilities.includes(106)) {
    return { capacity: 3, capacityField: 12 }
  }
  if (tiers.includes(8) || capabilities.includes(19)) {
    return { capacity: 2, capacityField: 12 }
  }
  return { capacity: 1, capacityField: 12 }
}

function normalizeModelEntry(entry, capacity) {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0]) return null
  const modelNumber = integer(entry[17]) ?? integer(entry[9])
  const labels = [entry[1], entry[10], entry[11], entry[19]]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return { id: entry[0], modelNumber, labels, ...capacity }
}

function modelLabelsMatch(candidate, requestedModel) {
  if (requestedModel === 'flash-lite') {
    return candidate.labels.includes('flash') && candidate.labels.includes('lite')
  }
  if (requestedModel === 'flash') {
    return candidate.labels.includes('flash') && !candidate.labels.includes('lite')
  }
  return /(^|\s)pro(\s|$)/.test(candidate.labels)
}

function selectModel(models, requestedModel) {
  const expectedNumber = { 'flash-lite': 6, flash: 1, pro: 3 }[requestedModel]
  let model = models.find((candidate) => candidate.modelNumber === expectedNumber)
  if (!model) {
    model = models.find(
      (candidate) => candidate.modelNumber == null && modelLabelsMatch(candidate, requestedModel),
    )
  }
  if (!model) {
    throw protocolError('The selected model is not available for this Google account.')
  }
  if (model.modelNumber == null) {
    return { ...model, modelNumber: expectedNumber }
  }
  return model
}

function selectThinkingMode(status, capacity, models) {
  const discoveredModel = models.find((candidate) => candidate.modelNumber === THINKING_MODE_NUMBER)
  if (discoveredModel) return discoveredModel

  const modePicker = status?.[24]?.[1]
  const thinkingMode = Array.isArray(modePicker)
    ? modePicker.find((modeData) => {
        const modeInfo = Array.isArray(modeData) ? modeData[0] : null
        return Array.isArray(modeInfo) && integer(modeInfo[1]) === THINKING_MODE_NUMBER
      })
    : undefined
  const modeInfo = Array.isArray(thinkingMode) ? thinkingMode[0] : null
  const isAvailable = modeInfo?.[7] === true || modeInfo?.[7] === 1
  if (!Array.isArray(modeInfo) || !isAvailable) {
    throw protocolError('The selected model is not available for this Google account.')
  }

  const id = THINKING_MODEL_IDS.get(capacity.capacity)
  if (!id) {
    throw protocolError('The selected model is not available for this Google account.')
  }
  return { id, modelNumber: THINKING_MODE_NUMBER, ...capacity }
}

function buildModelHeader(model, generationId, thinkingLevel) {
  const offset = model.capacityField === 13 ? 1 : 0
  const header = Array(15 + offset).fill(null)
  header[0] = 1
  header[4] = model.id
  header[7] = 0
  header[8] = [4, 5, 6, 8]
  header[model.capacityField - 1] = model.capacity
  header[14 + offset] = model.modelNumber
  header.push(thinkingLevel, generationId)
  return JSON.stringify(header)
}

export async function getGeminiModelSelection(
  requestedModel,
  params,
  extendedThinking,
  signal,
  isRequestCurrent = () => true,
) {
  if (!requestedModel || requestedModel === 'auto') {
    return { modelNumber: 1, headers: {}, standaloneThinking: false }
  }
  if (!['flash-lite', 'flash', 'thinking', 'pro'].includes(requestedModel)) {
    throw protocolError('Invalid Gemini Web model selection.')
  }

  const { at, bl, sessionId, language, accountPath } = params
  const endpoint = accountUrl(accountPath, BATCH_EXEC_PATH)
  const generationId = createGeminiRequestId()
  const sourcePath = `${accountPath || ''}/app`
  const query = new URLSearchParams({
    rpcids: MODEL_STATUS_RPC,
    hl: language,
    _reqid: String(Math.floor(Math.random() * 90000) + 10000),
    rt: 'c',
    'source-path': sourcePath,
  })
  if (bl) query.set('bl', bl)
  if (sessionId) query.set('f.sid', sessionId)

  const discoveryHeader = Array(17).fill(null)
  discoveryHeader[0] = 1
  discoveryHeader[8] = [4, 5, 6, 8]
  discoveryHeader[16] = generationId

  throwIfAborted(signal)
  throwIfSuperseded(isRequestCurrent)
  const response = await fetch(`${endpoint}?${query}`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'X-Same-Domain': '1',
      [MODEL_HEADER_KEY]: JSON.stringify(discoveryHeader),
      'x-goog-ext-73010989-jspb': '[0]',
    },
    body: new URLSearchParams({
      at,
      'f.req': `[[["${MODEL_STATUS_RPC}","[]",null,"generic"]]]`,
    }),
  })
  const text = await readResponse(response, signal)
  let status
  for (const envelope of decodeEnvelopes(text)) {
    if (envelope[0] === 'er' && envelope[1] === MODEL_STATUS_RPC) {
      throw protocolError('Gemini could not load the available models for this account.')
    }
    if (envelope[0] !== 'wrb.fr' || envelope[1] !== MODEL_STATUS_RPC) continue
    status = parseJsonString(envelope[2], 'Invalid Gemini model discovery response.')
    break
  }
  if (!Array.isArray(status)) {
    throw protocolError('Gemini returned no available model information.')
  }
  const accountStatus = integer(status[14])
  if (accountStatus != null && accountStatus !== 1000) {
    throw protocolError(`This Google account cannot select models (${accountStatus}).`)
  }
  const capacity = computeModelCapacity(status[16], status[17])
  const models = (Array.isArray(status[15]) ? status[15] : [])
    .map((entry) => normalizeModelEntry(entry, capacity))
    .filter(Boolean)
  const selected =
    requestedModel === 'thinking'
      ? selectThinkingMode(status, capacity, models)
      : selectModel(models, requestedModel)
  const standaloneThinking = requestedModel === 'thinking'
  return {
    modelNumber: selected.modelNumber,
    standaloneThinking,
    headers: {
      [MODEL_HEADER_KEY]: buildModelHeader(
        selected,
        generationId,
        standaloneThinking ? null : extendedThinking ? 2 : 1,
      ),
      'x-goog-ext-73010989-jspb': '[0]',
      'x-goog-ext-73010990-jspb': '[0,0,0]',
    },
  }
}

export async function requestGeminiText(
  prompt,
  conversation,
  params,
  {
    model = 'auto',
    temporary = false,
    extendedThinking = false,
    isRequestCurrent = () => true,
  } = {},
  signal,
) {
  throwIfAborted(signal)
  const { at, bl, sessionId, language, accountPath } = params
  const useExtendedThinking = model !== 'auto' && model !== 'thinking' && extendedThinking === true
  const selection = await getGeminiModelSelection(
    model,
    params,
    useExtendedThinking,
    signal,
    isRequestCurrent,
  )
  const endpoint = accountUrl(accountPath, GENERATE_PATH)
  const query = new URLSearchParams({
    hl: language,
    _reqid: String(Math.floor(Math.random() * 90000) + 10000),
    rt: 'c',
  })
  if (bl) query.set('bl', bl)
  if (sessionId) query.set('f.sid', sessionId)
  const requestId = createGeminiRequestId()
  throwIfAborted(signal)
  throwIfSuperseded(isRequestCurrent)
  const response = await fetch(`${endpoint}?${query}`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'X-Same-Domain': '1',
      'x-goog-ext-525005358-jspb': JSON.stringify([requestId, 1]),
      ...selection.headers,
    },
    body: new URLSearchParams({
      at,
      'f.req': buildRequest(prompt, conversation, language, requestId, {
        temporary,
        modelNumber: selection.modelNumber,
        extendedThinking: useExtendedThinking,
        thinkingMode: selection.standaloneThinking ? null : undefined,
      }),
    }),
  })
  return readResponse(response, signal)
}
