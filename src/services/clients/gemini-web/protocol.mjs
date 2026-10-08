const RESPONSE_LIMIT = 16 * 1024 * 1024

export function protocolError(message) {
  const error = new Error(`Gemini Web: ${message}`)
  error.code = 'GEMINI_WEB_PROTOCOL_ERROR'
  return error
}

function decodeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    // Do not expose response bodies, prompts or session tokens in diagnostics.
    throw protocolError('Invalid response format. The website protocol may have changed.')
  }
}

export function decodeEnvelopes(text) {
  let rest = text.trimStart()
  if (rest.startsWith(")]}'")) rest = rest.slice(4).trimStart()
  const envelopes = []
  while (rest) {
    const marker = /^(\d+)\n/.exec(rest)
    let frame
    if (marker) {
      const length = Number(marker[1])
      // Google counts the leading LF, JSON payload, and trailing LF in UTF-16 units.
      const start = marker[1].length
      if (!Number.isSafeInteger(length) || length <= 0 || length > RESPONSE_LIMIT) {
        throw protocolError('Invalid response frame length.')
      }
      if (rest.length < start + length) throw protocolError('Truncated response frame.')
      frame = decodeJson(rest.slice(start, start + length))
      rest = rest.slice(start + length).trimStart()
    } else {
      const end = rest.indexOf('\n')
      frame = decodeJson(end < 0 ? rest : rest.slice(0, end))
      rest = end < 0 ? '' : rest.slice(end + 1).trimStart()
    }
    if (!Array.isArray(frame) || !frame.every(Array.isArray)) {
      throw protocolError('Invalid response envelope.')
    }
    for (const envelope of frame) envelopes.push(envelope)
  }
  return envelopes
}

function mergeConversationMetadata(metadata, incoming) {
  if (incoming == null) return
  if (!Array.isArray(incoming)) throw protocolError('Invalid response payload.')
  for (const index of [0, 1]) {
    const value = incoming[index]
    if (value == null || value === '') continue
    if (typeof value !== 'string') throw protocolError('Invalid conversation identifier.')
    if (metadata[index] != null && metadata[index] !== '' && metadata[index] !== value) {
      throw protocolError('Conversation identifiers changed during generation.')
    }
    metadata[index] = value
  }
  incoming.forEach((value, index) => {
    if (index < 2 || value == null) return
    metadata[index] = value
  })
}

export function parseAnswer(text) {
  let answer
  const metadata = Array(10).fill(null)
  let candidateId
  let completion
  let context
  for (const envelope of decodeEnvelopes(text)) {
    const errorCode = envelope[5]?.[2]?.[0]?.[1]?.[0]
    if (envelope[0] === 'er' || errorCode) {
      const detail = typeof errorCode === 'number' ? ` (${errorCode})` : ''
      throw protocolError(
        `The website rejected the request${detail}. Check Gemini in your browser.`,
      )
    }
    if (envelope[0] !== 'wrb.fr' || envelope[2] == null || envelope[2] === '') continue
    if (typeof envelope[2] !== 'string') throw protocolError('Invalid response payload.')
    const payload = decodeJson(envelope[2])
    if (!Array.isArray(payload)) throw protocolError('Invalid response payload.')
    mergeConversationMetadata(metadata, payload[1])
    if (typeof payload[25] === 'string') context = payload[25]
    const candidateContainer = payload[4]
    if (candidateContainer == null) continue
    if (!Array.isArray(candidateContainer)) throw protocolError('Invalid response payload.')
    const candidate = candidateContainer[0]
    if (candidate == null) continue
    if (!Array.isArray(candidate)) throw protocolError('Invalid text candidate.')
    const id = candidate[0]
    if (id == null) continue
    if (typeof id !== 'string') throw protocolError('Invalid candidate identifier.')
    if (candidateId != null && candidateId !== id) {
      throw protocolError('Candidate changed during generation.')
    }
    candidateId = id
    const completionContainer = candidate[8]
    if (completionContainer != null && !Array.isArray(completionContainer)) {
      throw protocolError('Invalid response payload.')
    }
    const frameCompletion = completionContainer?.[0]
    const contentContainer = candidate[1]
    if (contentContainer == null) {
      if (frameCompletion != null) completion = frameCompletion
      continue
    }
    if (!Array.isArray(contentContainer)) throw protocolError('Invalid text candidate.')
    const content = contentContainer[0]
    if (content == null) continue
    if (typeof content !== 'string') throw protocolError('Invalid text candidate.')
    // Each frame is a full snapshot, not a text delta. Completion belongs to the latest snapshot.
    if (answer !== content) completion = frameCompletion
    else if (frameCompletion != null) completion = frameCompletion
    answer = content
  }
  if (typeof answer !== 'string' || !answer.trim()) {
    throw protocolError('No text answer was received. Check Gemini in your browser.')
  }
  if (completion == null) {
    throw protocolError('Could not confirm that the answer finished generating.')
  }
  if (completion !== 2) {
    throw protocolError(
      'The answer was interrupted before completion. Check Gemini before retrying.',
    )
  }
  if (![metadata[0], metadata[1], candidateId].every((id) => typeof id === 'string' && id)) {
    throw protocolError('Missing conversation identifiers.')
  }
  metadata[2] = candidateId
  if (context !== undefined) metadata[9] = context
  return {
    answer,
    conversationObj: { c: metadata[0], r: metadata[1], rc: candidateId, metadata },
  }
}

export function conversationMetadata(conversation = {}) {
  const metadata = Array.isArray(conversation.metadata)
    ? conversation.metadata.slice()
    : ['', '', '', null, null, null, null, null, null, '']
  for (const [index, key] of ['c', 'r', 'rc'].entries()) {
    metadata[index] = conversation[key] || metadata[index] || ''
  }
  return metadata
}

export function buildRequest(
  prompt,
  conversation,
  language,
  requestId,
  { temporary = false, modelNumber = 1, extendedThinking = false, thinkingMode = undefined } = {},
) {
  const request = Array(81).fill(null)
  request[0] = [prompt, 0, null, null, null, null, 0]
  request[1] = [language]
  request[2] = conversationMetadata(conversation)
  for (const index of [7, 10, 27, 68]) request[index] = 1
  for (const index of [11, 18, 53]) request[index] = 0
  for (const index of [6, 41]) request[index] = [1]
  request[17] = [[0]]
  request[30] = [4]
  if (temporary) request[45] = 1
  request[59] = requestId
  request[61] = []
  request[79] = modelNumber
  request[80] = thinkingMode === undefined ? (extendedThinking ? 2 : 1) : thinkingMode
  return JSON.stringify([null, JSON.stringify(request)])
}
