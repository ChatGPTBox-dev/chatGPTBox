// https://www.npmjs.com/package/eventsource-parser/v/1.1.1

// Bytes per decode, independent of the retained-state limit.
const MAX_DECODE_CHUNK_SIZE = 64 * 1024
const MAX_KNOWN_FIELD_NAME_LENGTH = 'event'.length

// maxBufferSize counts retained UTF-16 code units, not bytes or total heap usage.
function createParser(onParse, { maxBufferSize } = {}) {
  if (
    maxBufferSize !== undefined &&
    (!Number.isSafeInteger(maxBufferSize) || maxBufferSize < 0)
  ) {
    throw new TypeError('maxBufferSize must be a non-negative safe integer')
  }

  let isFirstChunk
  let decoder
  let buffer
  let startingPosition
  let startingFieldLength
  let eventId
  let eventName
  let data
  let extra
  let extraLength
  let discardTrailingNewline
  let terminated
  reset()
  return {
    feed,
    reset,
  }
  function reset() {
    isFirstChunk = true
    decoder = new TextDecoder()
    buffer = ''
    startingPosition = 0
    startingFieldLength = -1
    eventId = void 0
    eventName = void 0
    data = ''
    extra = void 0
    extraLength = 0
    discardTrailingNewline = false
    terminated = false
  }

  function feed(chunk) {
    if (terminated) {
      const err = new RangeError(
        'Cannot feed parser after exceeding max buffer size; call reset() to resume parsing',
      )
      err.code = 'SSE_BUFFER_LIMIT_EXCEEDED'
      throw err
    }

    if (maxBufferSize === undefined) {
      processDecodedChunk(decoder.decode(chunk, { stream: true }))
      return
    }

    const bytes = ArrayBuffer.isView(chunk)
      ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : new Uint8Array(chunk)

    if (bytes.byteLength === 0) {
      processDecodedChunk(decoder.decode(bytes, { stream: true }))
      return
    }

    let offset = 0
    while (offset < bytes.byteLength) {
      const end = Math.min(bytes.byteLength, offset + MAX_DECODE_CHUNK_SIZE)
      const slice = offset === 0 && end === bytes.byteLength ? bytes : bytes.subarray(offset, end)
      processDecodedChunk(decoder.decode(slice, { stream: true }), end === bytes.byteLength)
      offset = end
    }
  }

  function processDecodedChunk(decodedChunk, isLastSlice = true) {
    buffer += decodedChunk
    if (isFirstChunk && hasBom(buffer)) {
      buffer = buffer.slice(BOM.length)
    }
    isFirstChunk = false
    const length = buffer.length
    let position = 0
    while (position < length) {
      if (discardTrailingNewline) {
        if (buffer[position] === '\n') {
          ++position
        }
        discardTrailingNewline = false
      }
      let lineLength = -1
      let fieldLength = startingFieldLength
      let character
      for (let index = position + startingPosition; lineLength < 0 && index < length; ++index) {
        character = buffer[index]
        if (character === ':' && fieldLength < 0) {
          fieldLength = index - position
        } else if (character === '\r') {
          discardTrailingNewline = true
          lineLength = index - position
        } else if (character === '\n') {
          lineLength = index - position
        }
      }
      if (lineLength < 0) {
        startingPosition = length - position
        startingFieldLength = fieldLength
        break
      } else {
        startingPosition = 0
        startingFieldLength = -1
      }
      parseEventStreamLine(buffer, position, fieldLength, lineLength)
      position += lineLength + 1
    }
    if (position === length) {
      buffer = ''
    } else if (position > 0) {
      buffer = buffer.slice(position)
    }
    if (isLastSlice) {
      checkBufferSize(buffer.length)
    } else {
      checkTransientLineSize()
    }
  }

  function getRetainedSize(pendingBufferLength = buffer.length, additionalSize = 0) {
    return (
      pendingBufferLength +
      data.length +
      (eventId?.length ?? 0) +
      (eventName?.length ?? 0) +
      (extra ? extraLength : 0) +
      additionalSize
    )
  }

  function getTransientLineSize() {
    if (buffer.length === 0 || startingFieldLength < 0) return buffer.length
    if (startingFieldLength > MAX_KNOWN_FIELD_NAME_LENGTH) return buffer.length

    const field = buffer.slice(0, startingFieldLength)
    if (!['', 'data', 'event', 'id', 'retry', 'meta'].includes(field)) return buffer.length

    let valuePosition = startingFieldLength + 1
    if (buffer[valuePosition] === ' ') ++valuePosition
    return Math.max(0, buffer.length - valuePosition)
  }

  function checkTransientLineSize() {
    if (maxBufferSize === undefined) return

    // Bound live parser-retained text, not only the eventual logical event state.
    // Until an event/id replacement line is complete, its partial value and the
    // currently retained eventName/eventId coexist and are intentionally both counted.
    if (getRetainedSize(getTransientLineSize()) <= maxBufferSize) return

    throwBufferLimitError()
  }

  function checkBufferSize(pendingBufferLength = buffer.length, additionalSize = 0) {
    if (maxBufferSize === undefined) return
    if (getRetainedSize(pendingBufferLength, additionalSize) <= maxBufferSize) return

    throwBufferLimitError()
  }

  function throwBufferLimitError() {
    reset()
    terminated = true

    const err = new RangeError(
      `SSE parser retained state exceeded ${maxBufferSize} UTF-16 code units`,
    )
    err.code = 'SSE_BUFFER_LIMIT_EXCEEDED'
    throw err
  }

  function parseEventStreamLine(lineBuffer, index, fieldLength, lineLength) {
    if (lineLength === 0) {
      if (data.length > 0 || extra) {
        onParse({
          type: 'event',
          id: eventId,
          event: eventName || void 0,
          data: data.slice(0, -1),
          extra: extra || void 0,
          // remove trailing newline
        })

        data = ''
        eventId = void 0
        extra = void 0
        extraLength = 0
      }
      eventName = void 0
      return
    }
    const noValue = fieldLength < 0
    const field = lineBuffer.slice(index, index + (noValue ? lineLength : fieldLength))
    let step = 0
    if (noValue) {
      step = lineLength
    } else if (lineBuffer[index + fieldLength + 1] === ' ') {
      step = fieldLength + 2
    } else {
      step = fieldLength + 1
    }
    const position = index + step
    const valueLength = lineLength - step
    const value = lineBuffer.slice(position, position + valueLength).toString()
    if (field === 'data') {
      const addedLength = value ? value.length + 1 : 1
      checkBufferSize(0, addedLength)
      data += value ? ''.concat(value, '\n') : '\n'
    } else if (field === 'event') {
      checkBufferSize(0, value.length)
      eventName = value
    } else if (field === 'id' && !value.includes('\0')) {
      checkBufferSize(0, value.length)
      eventId = value
    } else if (field === 'retry') {
      const retry = parseInt(value, 10)
      if (!Number.isNaN(retry)) {
        onParse({
          type: 'reconnect-interval',
          value: retry,
        })
      }
    } else if (field === 'meta') {
      checkBufferSize(0, lineLength)
      const str = `{"${field}":${value}}`
      if (!extra) {
        extra = []
        extraLength = 0
      }
      extra.push(JSON.parse(str))
      extraLength += lineLength
    }
  }
}
const BOM = [239, 187, 191]
function hasBom(buffer) {
  return BOM.every((charCode, index) => buffer.charCodeAt(index) === charCode)
}
export { createParser }
